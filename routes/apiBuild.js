const express = require('express');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { getActiveProviderConfig } = require('../lib/ai-provider');
const { substitutePlaceholders, substitutePlainText } = require('../lib/template');
const { createRateLimiter } = require('../lib/rateLimit');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Field keys are dynamic (only known after querying this website type's
// template_fields), so this can't be a fully static schema. client_email
// is validated strictly; .catchall() validates every OTHER key generically
// — string, reasonably bounded, or absent. Gap this closes: previously an
// optional (non-required) field had NO type check at all before being
// dropped into the AI prompt — a client could send a number, array, or
// deeply nested object for any optional field and it would flow straight
// into JSON.stringify(). Required-field presence is still checked
// separately below (depends on runtime DB state — which fields THIS
// website type actually has — so it can't be expressed in a static schema
// the way the type/length bound here can).
const generateBodySchema = z
  .object({ client_email: z.string().trim().email().max(254) })
  .catchall(z.string().max(5000).optional());

// v1.0.6: two separate limiters, chosen per-request based on whether the
// REQUESTED website type actually costs AI tokens (websiteType.ai_enabled)
// — not one blanket limiter for every hit on this route. A type with AI
// off just substitutes raw form values into the template; it costs
// nothing but a DB read, so it gets the more generous limiter. A type with
// AI on reaches a real provider and costs real money per request, so it
// keeps the original, tighter budget.
const aiGenerateLimiter = createRateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const basicGenerateLimiter = createRateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });

const OUTPUT_TYPES = ['string', 'array_of_strings', 'array_of_objects'];

/**
 * Builds a JSON Schema description of the AI's expected output shape from
 * this website type's ai_output_fields, for embedding in the system
 * prompt (as explicit, machine-readable guidance the model can follow)
 * and for documentation purposes. Every field is required and
 * additionalProperties is false, matching the strict "exactly these keys,
 * nothing else" contract the original v1.0.5 prompt already used for flat
 * fields.
 */
function buildOutputSchema(outputFields) {
  const properties = {};
  const required = [];

  for (const f of outputFields) {
    required.push(f.output_key);

    if (f.output_type === 'array_of_strings') {
      properties[f.output_key] = {
        type: 'array',
        items: { type: 'string' },
        ...(f.description ? { description: f.description } : {})
      };
    } else if (f.output_type === 'array_of_objects') {
      const shape = f.object_shape || {};
      const subProps = {};
      const subRequired = [];
      for (const subKey of Object.keys(shape)) {
        subProps[subKey] = { type: 'string' };
        subRequired.push(subKey);
      }
      properties[f.output_key] = {
        type: 'array',
        items: { type: 'object', properties: subProps, required: subRequired, additionalProperties: false },
        ...(f.description ? { description: f.description } : {})
      };
    } else {
      properties[f.output_key] = {
        type: 'string',
        ...(f.description ? { description: f.description } : {})
      };
    }
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Validates a parsed AI JSON response against the expected output field
 * shapes — every string field is actually a string, every array field is
 * actually an array of the right item shape. Mirrors the strictness of
 * the original v1.0.5 flat-field check (`typeof parsed[k] === 'string'`),
 * extended to the two new array shapes.
 */
function validateAiOutput(parsed, outputFields) {
  if (!parsed || typeof parsed !== 'object') return false;

  for (const f of outputFields) {
    const val = parsed[f.output_key];

    if (f.output_type === 'array_of_strings') {
      if (!Array.isArray(val) || !val.every(v => typeof v === 'string')) return false;
    } else if (f.output_type === 'array_of_objects') {
      if (!Array.isArray(val)) return false;
      const shapeKeys = Object.keys(f.object_shape || {});
      for (const item of val) {
        if (item === null || typeof item !== 'object') return false;
        for (const subKey of shapeKeys) {
          if (typeof item[subKey] !== 'string') return false;
        }
      }
    } else {
      if (typeof val !== 'string') return false;
    }
  }

  return true;
}

router.post('/:slug/generate', express.json(), async (req, res) => {
  const ip = req.ip;
  const pool = getPool();

  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );
  if (typeResult.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  const websiteType = typeResult.rows[0];

  // v1.0.6: which limiter applies depends on this type's ai_enabled flag,
  // so the DB lookup above has to happen before rate limiting can be
  // applied — a deliberate, small tradeoff (a flood of requests against a
  // bogus/nonexistent slug now costs one query before being limited)
  // accepted so an AI-enabled type's tighter, cost-protecting budget can't
  // be evaded by requests that never even needed it. The global rate
  // limiter in server.js still bounds raw request volume regardless.
  const limiter = websiteType.ai_enabled ? aiGenerateLimiter : basicGenerateLimiter;
  const limiterMessage = websiteType.ai_enabled
    ? 'Too many generation requests, please try again later'
    : 'Too many requests, please try again later';
  if (!limiter.tryConsume(ip)) {
    return res.status(429).json({ error: limiterMessage });
  }

  const fieldsResult = await pool.query(
    'SELECT * FROM template_fields WHERE website_type_id = $1 ORDER BY display_order ASC, id ASC',
    [websiteType.id]
  );
  const fields = fieldsResult.rows;

  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  const submitted = parsed.data;

  // ---- required-field presence — depends on THIS website type's fields,
  // which is runtime DB state, not something a static schema can express ----
  const missingFields = [];

  if (!EMAIL_RE.test(submitted.client_email)) {
    // zod's .email() already validated this, but the existing stricter
    // house regex is kept as a belt-and-suspenders check on the exact
    // shape the rest of the system (and the AI prompt) expects.
    missingFields.push('client_email');
  }

  for (const f of fields) {
    if (!f.is_required) continue;
    const val = typeof submitted[f.field_key] === 'string' ? submitted[f.field_key].trim() : '';
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

  // Raw submitted values, keyed by field_key — the base of the final
  // template variables regardless of whether AI is involved.
  const rawValues = fields.reduce((acc, f) => {
    acc[f.field_key] = submitted[f.field_key];
    return acc;
  }, {});

  // ---- AI disabled: substitute raw values straight into the template.
  // No AI provider is looked up, no AI client is ever instantiated or
  // called — this whole branch never touches lib/ai-provider.js. ----
  if (!websiteType.ai_enabled) {
    const html = substitutePlaceholders(templateHtml, rawValues, {});
    return res.json({ html });
  }

  // ---- AI enabled ----
  const outputFieldsResult = await pool.query(
    'SELECT * FROM ai_output_fields WHERE website_type_id = $1 ORDER BY display_order ASC, id ASC',
    [websiteType.id]
  );
  const outputFields = outputFieldsResult.rows;

  if (outputFields.length === 0) {
    // ai_enabled with nothing configured to generate — there's no
    // structured output to request, so there's nothing useful an AI call
    // could add. Fall through to the same raw-substitution behavior as
    // the disabled path rather than spending a token budget on an
    // effectively-empty request.
    console.warn(`[BUILD] Website type "${req.params.slug}" has AI enabled but no output fields configured — skipping AI call.`);
    const html = substitutePlaceholders(templateHtml, rawValues, {});
    return res.json({ html });
  }

  const providerConfig = await getActiveProviderConfig();
  if (!providerConfig || !providerConfig.selectedModel) {
    return res.status(503).json({ error: 'Content generation temporarily unavailable, please try again shortly' });
  }

  // ---- prompt construction ----
  // System/user prompts come from the admin's own per-type configuration
  // (website_types.ai_system_prompt / ai_user_prompt_template), with raw
  // field tokens ({{field_key}}) substituted via substitutePlainText —
  // deliberately NOT substitutePlaceholders, since this text is going into
  // an LLM prompt, not markup, and HTML-escaping it would inject literal
  // "&amp;"-style noise into the prompt instead of protecting anything.
  const outputSchema = buildOutputSchema(outputFields);
  const schemaInstructions = `Return ONLY a single JSON object, no preamble, no markdown code fences, no commentary — just the JSON object itself. It must conform EXACTLY to this JSON Schema (every listed key required, no extra keys):

${JSON.stringify(outputSchema)}`;

  const systemPrompt = `${substitutePlainText(websiteType.ai_system_prompt || '', rawValues)}\n\n${schemaInstructions}`;
  const userPrompt = substitutePlainText(websiteType.ai_user_prompt_template || '', rawValues);

  let parsedOutput = null;
  const attemptErrors = [];

  // Fall through the provider's keys in priority order on any failure —
  // bad key (401), provider-side rate limit (429), provider outage (5xx),
  // network failure, or a response that doesn't parse as the expected JSON
  // shape all count as "try the next key". Reuses the exact same
  // getActiveProviderConfig() + fetch(.../chat/completions) calling
  // convention as before — no second AI client, this is the only place in
  // the app that talks to an AI provider.
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

      let candidate;
      try {
        candidate = JSON.parse(rawContent);
      } catch (err) {
        attemptErrors.push('non-JSON response');
        continue;
      }

      if (!validateAiOutput(candidate, outputFields)) {
        attemptErrors.push('response missing expected keys or wrong shape');
        continue;
      }

      parsedOutput = candidate;
      break;
    } catch (err) {
      attemptErrors.push(err.message);
    }
  }

  // Fail LOUDLY if every key failed — never silently fall back to raw,
  // unedited field values. Raw input wasn't written as public-facing copy;
  // silently substituting it would produce a worse result than the client
  // expects, with no indication anything went wrong.
  if (!parsedOutput) {
    console.error(`[BUILD] All provider keys failed for slug "${req.params.slug}":`, attemptErrors);
    return res.status(503).json({ error: 'Content generation temporarily unavailable, please try again shortly' });
  }

  // ---- split AI output into flat vs array-shaped, merge with raw values ----
  // Final variables object = a shallow merge of the raw submitted values
  // and the AI's flat (string) outputs, keyed together for
  // substitutePlaceholders's `values` map. Array-shaped AI outputs go into
  // a separate `arrayValues` map for the {{#each}} pass. In an unexpected
  // key collision (shouldn't happen — output_key is validated against
  // field_key at save time in routes/adminWebsiteTypes.js, specifically to
  // prevent this), the AI's value wins: it's spread in AFTER rawValues.
  const flatValues = { ...rawValues };
  const arrayValues = {};

  for (const f of outputFields) {
    if (f.output_type === 'array_of_strings' || f.output_type === 'array_of_objects') {
      arrayValues[f.output_key] = parsedOutput[f.output_key];
    } else {
      flatValues[f.output_key] = parsedOutput[f.output_key];
    }
  }

  // ---- substitute into the template ----
  // Every value is HTML-escaped inside substitutePlaceholders — these are
  // content values being dropped into an existing template shell, not
  // markup, regardless of how much the AI provider is trusted.
  const html = substitutePlaceholders(templateHtml, flatValues, arrayValues);

  res.json({ html });
});

module.exports = router;
