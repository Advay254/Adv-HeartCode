const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV, recommended size for GCM

/**
 * Derives a 32-byte AES key from ENCRYPTION_KEY via SHA-256, so the env var
 * can be literally any string of any length — a random hex string, a
 * passphrase, a mix of words — rather than requiring an exact 64-character
 * hex value. Getting a real 64-char hex string normally needs a tool
 * (openssl, node, or a website), which isn't always convenient — especially
 * with no local Node/terminal available. Hashing means any input
 * deterministically becomes a valid 32-byte key, no format requirement.
 */
function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not set');
  }
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest();
}

/**
 * AES-256-GCM encrypt. Returns "iv:authTag:ciphertext", all hex-encoded,
 * as a single storable TEXT value. A fresh random IV is used every call.
 */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Reverses encrypt(). Throws clearly on a missing/wrong ENCRYPTION_KEY or a
 * malformed stored value — callers are expected to catch this and treat it
 * as "not configured" rather than letting it crash the request.
 */
function decrypt(stored) {
  if (typeof stored !== 'string' || !stored) {
    throw new Error('Nothing to decrypt');
  }

  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Masks a plaintext secret down to its last 4 characters for display,
 * e.g. "sk_test_abc123" -> "••••••••3123". Never called on an already
 * masked/encrypted value.
 */
function maskSecret(plaintext) {
  if (!plaintext) return null;
  const last4 = plaintext.slice(-4);
  return '••••••••' + last4;
}

module.exports = { encrypt, decrypt, maskSecret };
