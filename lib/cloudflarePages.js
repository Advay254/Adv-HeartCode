const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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

function buildProjectName(seed) {
  // Cloudflare Pages project names: lowercase letters, numbers, hyphens
  // only. Derived from the seed (normally the Paystack reference) plus a
  // short random suffix, so a retry after a name collision doesn't reuse
  // the same colliding name.
  const cleanSeed = String(seed).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `hc-${cleanSeed.slice(0, 20)}-${randomSuffix()}`;
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

  // Wrangler's own GitHub Action (cloudflare/wrangler-action) extracts the
  // deployment URL the same way: scanning stdout for the *.pages.dev URL,
  // since wrangler doesn't currently offer a --json flag for this command.
  const match = stdout.match(/https:\/\/[a-z0-9.-]+\.pages\.dev\S*/i);
  if (!match) {
    throw new Error(`Could not find a deployed URL in wrangler's output: ${stdout.slice(0, 500)}`);
  }
  return match[0];
}

/**
 * Deploys `htmlContent` as the index.html of a brand new Cloudflare Pages
 * project, and returns { url, projectName }. `seed` (normally the Paystack
 * reference) is used to derive a readable, unique project name. Retries
 * ONCE with a new random suffix if project creation collides with an
 * existing name (astronomically unlikely given each reference is unique,
 * but cheap to guard against).
 */
async function deployToCloudflarePages(seed, htmlContent) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!apiToken || !accountId) {
    throw new Error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set');
  }

  let projectName = buildProjectName(seed);
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
        projectName = buildProjectName(seed);
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
