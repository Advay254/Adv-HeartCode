const express = require('express');
const { getPool } = require('../db/init');
const { getActiveProviderConfig } = require('../lib/ai-provider');
const { substitutePlaceholders } = require('../lib/template');
const { createRateLimiter } = require('../lib/rateLimit');

const router = express.Router();
router.use(express.json());

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Max 5 generations per IP per hour — this is the endpoint that costs AI
// tokens once a request reaches the provider, so it's worth protecting
// before payment exists at all.
const generateLimiter = createRateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });

router.post('/:slug/generate', async (req, res) => {
  const ip = req.ip;

  // Consumed FIRST, before any DB work or validation — every POST here
  // counts against the hourly budget regardless of what happens after.
  // This also blunts a flood of malformed requests, not just ones that
  // actually reach (and cost money at) the AI provider.
  if (!generateLimiter.tryConsume(ip)) {
    return res.status(429).json({ error: 'Too many generation requests, please try again later' });
  }

  const pool = getPool();

  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );
  if (typeResult.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  const websiteType = typeResult.rows[0];

  const fieldsResult = await pool.query(
    'SELECT * FROM template_fields WHERE website_type_id = $1 ORDER BY display_order ASC, id ASC',
    [websiteType.id]
  );
  const fields = fieldsResult.rows;

  const values = req.body || {};

  // ---- server-side validation — never trust the client-side checks ----
  const missingFields = [];

  const clientEmail = typeof values.client_email === 'string' ? values.client_email.trim() : '';
  if (!clientEmail || !EMAIL_RE.test(clientEmail)) {
    missingFields.push('client_email');
  }

  for (const f of fields) {
    if (!f.is_required) continue;
    const val = typeof values[f.field_key] === 'string' ? values[f.field_key].trim() : '';
    if (!val) missingFields.push(f.field_key);
  }

  if (missingFields.length > 0) {
    return res.status(400).json({ error: 'Missing or invalid required fields', missingFields });
  }

  const templateResult = await pool.query(
    'SELECT * FROM templates WHERE website_type_id = $1 AND is_active = true LIMIT 1',
    [websiteType.id]
  );
  if (templateResult.rowCount === 0) {
    return res.status(503).json({ error: 'This website type has no active template yet' });
  }
  const templateHtml = templateResult.rows[0].html_content;

  const providerConfig = await getActiveProviderConfig();
  if (!providerConfig || !providerConfig.selectedModel) {
    return res.status(503).json({ error: 'Content generation temporarily unavailable, please try again shortly' });
  }

  // ---- prompt construction ----
  // The system prompt is deliberately narrow: take short/informal raw
  // field values and expand each into finished, on-brand website copy,
  // preserving concrete facts (names, prices, contact details) exactly
  // rather than inventing new ones. It must return flat JSON keyed by
  // field_key — not prose — so the response can be mechanically
  // substituted into the template without any parsing beyond JSON.parse.
  const fieldKeys = fields.map(f => f.field_key);
  const systemPrompt = `You are a copywriting engine for a website builder. You will be given raw form field values a client typed for their website. Expand and polish each value into finished, professional website copy suitable for public display — correct grammar, keep the client's original meaning and any specific facts (names, prices, contact details) exactly as given, but make the tone clear and welcoming.

Return ONLY a single JSON object, no preamble, no markdown code fences, no commentary — just the JSON object itself. The object must have exactly these keys: ${JSON.stringify(fieldKeys)}. Each value must be a plain text string with no HTML tags. Do not add, remove, or rename keys.`;

  const userPrompt = JSON.stringify(
    fields.reduce((acc, f) => {
      acc[f.field_key] = values[f.field_key];
      return acc;
    }, {})
  );

  let generatedValues = null;
  const attemptErrors = [];

  // Fall through the provider's keys in priority order on any failure —
  // bad key (401), provider-side rate limit (429), provider outage (5xx),
  // network failure, or a response that doesn't parse as the expected JSON
  // shape all count as "try the next key".
  for (const key of providerConfig.keys) {
    try {
      const response = await fetch(`${providerConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model: providerConfig.selectedModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7
        })
      });

      if (!response.ok) {
        attemptErrors.push(`HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const rawContent = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null;

      if (!rawContent) {
        attemptErrors.push('empty response');
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawContent);
      } catch (err) {
        attemptErrors.push('non-JSON response');
        continue;
      }

      const hasAllKeys = fieldKeys.every(k => typeof parsed[k] === 'string');
      if (!hasAllKeys) {
        attemptErrors.push('response missing expected keys');
        continue;
      }

      generatedValues = parsed;
      break;
    } catch (err) {
      attemptErrors.push(err.message);
    }
  }

  // Fail LOUDLY if every key failed — never silently fall back to raw,
  // unedited field values. Raw input wasn't written as public-facing copy;
  // silently substituting it would produce a worse result than the client
  // expects, with no indication anything went wrong.
  if (!generatedValues) {
    console.error(`[BUILD] All provider keys failed for slug "${req.params.slug}":`, attemptErrors);
    return res.status(503).json({ error: 'Content generation temporarily unavailable, please try again shortly' });
  }

  // ---- substitute into the template ----
  // Every generated value is HTML-escaped inside substitutePlaceholders —
  // these are content values being dropped into an existing template
  // shell, not markup, regardless of how much the AI provider is trusted.
  const html = substitutePlaceholders(templateHtml, generatedValues);

  res.json({ html });
});

module.exports = router;
