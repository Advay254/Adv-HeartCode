const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { slugify } = require('./slugify');

const execFileAsync = promisify(execFile);

// Cloudflare doesn't publish a stable, documented REST contract for raw
// Direct Upload deployments (uploading file bytes with no git repo) —
// that flow is JWT/content-hash based and only implemented, as far as
// Cloudflare documents it, inside Wrangler itself. Rather than
// reverse-engineer undocumented internal endpoints for something that
// handles real paid deployments, this shells out to the actual `wrangler`
// CLI — the same officially-maintained tool Cloudflare's own GitHub Action
// uses for CI/CD. Tradeoff, stated plainly: wrangler is a genuinely heavy
// dependency (tens of MB, versus low hundreds of KB for everything else in
// this project) and each deploy spawns a real child process rather than
// making a single HTTP call. Given this is a payment-triggered path (not a
// hot loop) rather than a latency-critical one, that tradeoff is worth it
// for using Cloudflare's own maintained, tested implementation instead of
// a hand-rolled one against endpoints they don't commit to publicly.
// require.resolve('wrangler/bin/wrangler.js') fails — wrangler's own
// package.json "exports" map doesn't expose that subpath directly, even
// though it's the real file "bin" points to. Resolving package.json (which
// IS reliably resolvable) and joining from its directory works regardless
// of how node_modules ends up nested/hoisted.
const WRANGLER_BIN = path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

// Cloudflare Pages project names live as a DNS label (the "X" in
// "X.pages.dev") — hard-capped at 63 characters by RFC 1035, a universal
// DNS constraint, not a Cloudflare-specific one. Cloudflare's own docs
// don't appear to publish a tighter, separate limit on top of that, so
// this is designed against the DNS ceiling with real headroom to spare:
// "hc-" (3) + up to MAX_SEED_LENGTH (40) + a random suffix ("-" + 8 hex
// = 9) tops out at 52, comfortably under 63. Raised from an original 20 —
// too short for the actual patterns this feature exists to support (the
// spec's own example, "happybirthday-from{{user_name}}-to{{recepient_name}}",
// resolves to 31+ characters with realistic names, before any suffix).
const MAX_SEED_LENGTH = 40;

/**
 * Cloudflare Pages project names: lowercase letters, numbers, hyphens
 * only. Derived from `seed` via the shared slugify() (v1.0.8: previously
 * had its own separate inline sanitization here, duplicating
 * routes/adminWebsiteTypes.js's slugify — consolidated into
 * lib/slugify.js so there's one implementation).
 *
 * `seed` is expected PREFIX-FREE — callers must NOT include an "hc-"
 * prefix of their own; this function is the one place that adds it. (A
 * real, pre-existing bug fixed in the same pass as this doc comment:
 * lib/finalizeDeployment.js used to pass `pending.reference` directly,
 * which ALREADY starts with "hc-" — silently producing "hc-hc-..."
 * project names on every single deploy since this file was first
 * written. Never caught because the actual Cloudflare deploy step has
 * never been exercised end-to-end outside a mock — see HANDOFF.md's
 * known gaps. Fixed at the call site: finalizeDeployment.js now strips
 * that prefix before calling this.)
 *
 * `appendRandom` (default true, matching the original always-random
 * behavior when no custom deploy_slug_pattern is in play — see
 * lib/finalizeDeployment.js): when true, always appends a fresh random
 * suffix, so a retry after a name collision doesn't reuse the same
 * colliding name. When false, the seed is used AS-IS with no suffix —
 * used for a v1.0.8 custom deploy_slug_pattern that's already been
 * checked against deployed_sites and found not to collide; forcing a
 * random suffix on top of a pattern the admin deliberately made
 * meaningful (e.g. "happybirthday-from-john-to-sarah") would defeat the
 * entire point of the feature.
 */
function buildProjectName(seed, { appendRandom = true } = {}) {
  const cleanSeed = slugify(String(seed)).slice(0, MAX_SEED_LENGTH);
  return appendRandom ? `hc-${cleanSeed}-${randomSuffix()}` : `hc-${cleanSeed}`;
}

async function runWrangler(args, env) {
  return execFileAsync(process.execPath, [WRANGLER_BIN, ...args], {
    env: { ...process.env, ...env, CI: '1' },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000
  });
}

async function createProject(projectName, apiToken, accountId) {
  await runWrangler(
    ['pages', 'project', 'create', projectName, '--production-branch=main'],
    { CLOUDFLARE_API_TOKEN: apiToken, CLOUDFLARE_ACCOUNT_ID: accountId }
  );
}

/**
 * v1.1.1 Part A: this used to RETURN the hashed per-deployment URL scraped
 * from wrangler's stdout (e.g. "https://e1c63c4b.hc-foo.pages.dev") and
 * that became the link every client actually received. That hash segment
 * is Cloudflare's identifier for THIS ONE deployment, not the stable
 * production URL — cosmetically confusing for a client (why does my
 * website's address start with a random hex string?), and technically
 * wrong to treat as "the" URL for the project going forward.
 *
 * Cloudflare Pages always additionally serves a clean, stable alias at
 * https://<project-name>.pages.dev that tracks whatever is currently live
 * on the project's PRODUCTION branch — regardless of which specific
 * deployment (and therefore which hash) is behind it at any given moment.
 * Since createProject() above always sets `--production-branch=main` and
 * deployDirectory() below always deploys with `--branch=main` (the same
 * value), every deployment this app ever makes IS a production deployment
 * by Cloudflare's own branch-matching rule — so the clean alias is always
 * the right, permanent URL to hand a client, never a preview/staging one.
 *
 * The function below still scrapes stdout for a *.pages.dev URL exactly as
 * before, but ONLY as a lightweight confirmation that wrangler actually
 * reported success (something plausible was printed) — that hashed value
 * is deliberately never returned or used past this point. The URL actually
 * returned from deployDirectory() (and therefore stored/emailed/shown to
 * the client) is built directly from `projectName`, the exact string this
 * code itself generated and told Cloudflare to create — never parsed or
 * trusted from Cloudflare's response.
 *
 * Caveat carried over from HANDOFF.md's Known Gaps: a real, successful
 * deploy has never been exercised end-to-end in this build's sandbox (no
 * network path to api.cloudflare.com here) — the branch-matching reasoning
 * above is sound and matches Cloudflare's documented behavior, but treat
 * the FIRST real deploy after upgrading to this version as the actual
 * proof: confirm https://<project-name>.pages.dev loads the site (not a
 * 404) before assuming every client link going forward is good.
 */
async function deployDirectory(projectName, dirPath, apiToken, accountId) {
  const { stdout } = await runWrangler(
    [
      'pages', 'deploy', dirPath,
      `--project-name=${projectName}`,
      '--branch=main',
      '--commit-dirty=true'
    ],
    { CLOUDFLARE_API_TOKEN: apiToken, CLOUDFLARE_ACCOUNT_ID: accountId }
  );

  // Confirmation-only match — NOT the returned value. See the function's
  // doc comment above for why the clean alias is built from projectName
  // instead, regardless of what (if anything) wrangler printed here.
  const sawDeploymentUrl = /https:\/\/[a-z0-9.-]+\.pages\.dev\S*/i.test(stdout);
  if (!sawDeploymentUrl) {
    throw new Error(`wrangler did not report a deployed URL — deploy likely failed: ${stdout.slice(0, 500)}`);
  }

  return `https://${projectName}.pages.dev`;
}

/**
 * Deploys `htmlContent` as the index.html of a brand new Cloudflare Pages
 * project, and returns { url, projectName }. `seed` (normally the Paystack
 * reference, or — v1.0.8 — a resolved deploy_slug_pattern) is used to
 * derive a readable, unique project name. `appendRandom` (default true)
 * is passed straight through to buildProjectName's first attempt — see
 * its own comment for when a caller wants false. Retries ONCE, ALWAYS
 * WITH appendRandom forced true regardless of the original mode, if
 * project creation collides with an existing name on Cloudflare's own
 * side — a retry inherently means "the plain name didn't work," so this
 * is the one place randomness is non-negotiable even for a custom
 * pattern.
 */
async function deployToCloudflarePages(seed, htmlContent, { appendRandom = true } = {}) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!apiToken || !accountId) {
    throw new Error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set');
  }

  let projectName = buildProjectName(seed, { appendRandom });
  let attempt = 0;
  const maxAttempts = 2;

  while (true) {
    attempt += 1;
    try {
      await createProject(projectName, apiToken, accountId);
      break;
    } catch (err) {
      const message = (err.stderr || err.message || '').toLowerCase();
      const isNameCollision = message.includes('already exists') || message.includes('already taken');
      if (isNameCollision && attempt < maxAttempts) {
        projectName = buildProjectName(seed, { appendRandom: true });
        continue;
      }
      throw new Error(`Failed to create Cloudflare Pages project: ${err.stderr || err.message}`);
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heartcode-deploy-'));
  try {
    await fs.writeFile(path.join(tempDir, 'index.html'), htmlContent, 'utf8');
    const url = await deployDirectory(projectName, tempDir, apiToken, accountId);
    return { url, projectName };
  } catch (err) {
    throw new Error(`Failed to deploy to Cloudflare Pages: ${err.stderr || err.message}`);
  } finally {
    // Best-effort cleanup — a leftover temp dir doesn't break anything on
    // Render's ephemeral filesystem, but there's no reason to leave it.
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { deployToCloudflarePages };
