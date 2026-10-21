'use strict';

// v1.2.17: plain warnings about weak settings. These only ever warn. Nothing
// here stops the app from starting, because a hard stop at deploy time could
// take a live site down. Values are never printed or returned, only names and
// what is wrong.

const COMMON_WORDS = ['password', 'passw0rd', 'changeme', 'change-me', 'secret', 'admin', 'letmein', 'qwerty', '123456', 'abcdef', 'default', 'example', 'test'];

function looksWeak(value) {
  const v = String(value);
  const lower = v.toLowerCase();
  if (new Set(v).size < 6) return 'it repeats a few characters';
  if (COMMON_WORDS.some((w) => lower.includes(w))) return 'it contains a common word or pattern';
  if (/^\d+$/.test(v)) return 'it is only digits';
  return null;
}

function checkOne(name, minLength) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') {
    return { name, problem: 'is not set' };
  }
  const value = String(raw).trim();
  if (value.length < minLength) {
    return { name, problem: `is shorter than ${minLength} characters` };
  }
  const weak = looksWeak(value);
  if (weak) return { name, problem: `looks weak (${weak})` };
  return null;
}

/** [{ name, problem }] for every weak setting. Never includes a value. */
function getWeakSettings() {
  return [
    checkOne('SESSION_SECRET', 32),
    checkOne('ENCRYPTION_KEY', 32),
    checkOne('ADMIN_PASSWORD', 14)
  ].filter(Boolean);
}

/** One warning line per problem, printed once at startup. */
function logStartupWarnings(twoStepOn) {
  for (const w of getWeakSettings()) {
    console.warn(`[SECURITY] ${w.name} ${w.problem}. Use a long random value (32 or more characters for secrets, 14 or more for the password).`);
  }
  if (!twoStepOn) {
    console.warn('[SECURITY] Two-step admin login is off. Turn it on from the Security page in the admin.');
  }
}

module.exports = { getWeakSettings, logStartupWarnings };
