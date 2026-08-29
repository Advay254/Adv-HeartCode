const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const crypto = require('crypto');
const { z } = require('zod');
const { getActivePaystackKeys } = require('../lib/paystack');
const { finalizeDeployment } = require('../lib/finalizeDeployment');

const router = express.Router();

// Applied only AFTER signature verification below — this is a structural
// sanity check on an already-trusted payload, not a security boundary.
// The signature check is what actually matters; this just guards against
// acting on an unexpected/malformed shape from a genuinely-signed request.
const webhookEventSchema = z.object({
  event: z.string(),
  data: z.object({ reference: z.string().min(1) }).passthrough().optional()
});

// Paystack signs the RAW request body (not the re-serialized JSON) with
// HMAC-SHA512, keyed with the secret key. express.raw() keeps req.body as
// an untouched Buffer so the signature check is computed over exactly the
// bytes Paystack actually sent — re-serializing parsed JSON before
// verifying could produce different bytes (key order, whitespace) and
// break verification even for a genuine, unmodified request.
router.use(express.raw({ type: 'application/json', limit: '1mb' }));

router.post('/paystack', asyncHandler(async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.body; // Buffer, thanks to express.raw() above

  if (!signature || !Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: 'Missing signature or body' });
  }

  const keys = await getActivePaystackKeys();
  if (!keys) {
    // Paystack isn't configured — nothing we can verify against. Return
    // 200 anyway (see note below on why webhooks always get a 200).
    console.error('[WEBHOOK] Received Paystack webhook but Paystack is not configured');
    return res.status(200).json({ received: true });
  }

  const expectedSignature = crypto
    .createHmac('sha512', keys.secretKey)
    .update(rawBody)
    .digest('hex');

  const signatureBuf = Buffer.from(String(signature), 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const validSignature = signatureBuf.length === expectedBuf.length
    && crypto.timingSafeEqual(signatureBuf, expectedBuf);

  if (!validSignature) {
    console.error('[WEBHOOK] Invalid Paystack signature — rejecting');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }

  const eventParsed = webhookEventSchema.safeParse(event);
  if (!eventParsed.success) {
    console.error('[WEBHOOK] Unexpected event shape from a validly-signed request:', eventParsed.error.issues);
    return res.status(400).json({ error: 'Unexpected event shape' });
  }
  event = eventParsed.data;

  // Always acknowledge with 200 immediately once the signature is valid —
  // Paystack retries on non-200 responses (every 3 min for the first 4
  // attempts, then hourly for up to 72 hours), which would otherwise cause
  // repeated retries for something that isn't actually a delivery problem
  // (e.g. an event type we don't act on, or a reference we can't find).
  // finalizeDeployment() runs after responding — its own idempotency
  // guarantees this is safe even if Paystack's retry logic ALSO fires a
  // duplicate delivery for the same event.
  res.status(200).json({ received: true });

  if (event.event !== 'charge.success') {
    return;
  }

  const reference = event.data && event.data.reference;
  if (!reference) {
    console.error('[WEBHOOK] charge.success event missing data.reference');
    return;
  }

  try {
    const result = await finalizeDeployment(reference);
    if (result.status === 'error') {
      console.error(`[WEBHOOK] finalizeDeployment error for ${reference}:`, result.error);
    }
  } catch (err) {
    console.error(`[WEBHOOK] Unexpected error finalizing ${reference}:`, err.message);
  }
}));

module.exports = router;
