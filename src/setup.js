import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { filesDigest, sha256 } from './hash.js';
import { nowIso, short } from './util.js';

// Setup / prerequisites for command checks.
//
// Found on a real repository: `npm test` on a fresh clone exits 127 because
// the dependencies aren't installed. The claim was true about the repository
// and false about the checkout, and manual had no way to say so — it reported
// `broken`, which reads as "the test suite fails". `check.setup` declares the
// prerequisite so that state becomes `blocked`: the state that already means
// "this run says nothing about the claim".
//
// Where setup runs, and why not in the sandbox:
//   installs are not sandboxable. A throwaway worktree would have to reinstall
//   on every verify (minutes each time, and invisible to the developer's own
//   test runs), and moving an installed tree back out of a tmpdir is a
//   cross-filesystem copy. Setup therefore runs once, in the root checkout —
//   exactly what a developer does by hand — and the sandbox's existing link of
//   node_modules into the worktree (see sandbox.js) makes the result visible to
//   every check. Source files stay untouched: only the artifact directories a
//   setup declares are created, and only by the command that declares them.
//
// "Once" means once per (command, evidence) pair, not once per verify: the key
// is the command plus the content of its declared evidence, so bumping a
// lockfile re-runs the install and re-verifying untouched code does not.

const DEFAULT_CACHE = ['node_modules'];
const DEFAULT_TIMEOUT_S = 900;

// ---------------------------------------------------------------------------
// Named prerequisites (declared once, in .manual/manual.yaml)
//
// Per-claim `check.setup` covers the case of one claim with one awkward step,
// but a repository does not have one prerequisite: it has an install (or two,
// one per ecosystem), a build, a codegen step — and every command claim that
// touches them would otherwise restate the same command. The same command
// written twice is two chances to disagree, so the repository declares its
// prerequisites once and claims reference them by name:
//
//   # .manual/manual.yaml
//   setup:
//     node:
//       run: npm ci
//       evidence: ["package.json", "package-lock.json"]
//       cache: ["node_modules"]
//
//   # .manual/claims/tests.suite.md
//   check:
//     requires: node
//     run: npm test
//
// Resolution is by name, then by inline setup, and deduplication is by
// (command, evidence) as before — so ten claims requiring `node` pay for one
// install, and a claim requiring both `node` and `python` pays for two, once
// each, whatever order the claims run in.
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9.-]*$/;

// A named prerequisite keeps the claim's name for it, so a failure can say
// *which* step could not be established (`python: .venv/bin/pip install …`).
export function normalizeSetupMap(raw, file = '.manual/manual.yaml') {
  const specs = {};
  const errors = [];
  if (raw === undefined || raw === null) return { specs, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { specs, errors: [`${file}: setup must be a map of name -> run/build step`] };
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) {
      errors.push(`${file}: prerequisite name "${name}" must be lowercase letters, digits, dots or dashes`);
      continue;
    }
    const spec = typeof value === 'string' ? { run: value } : value;
    if (!spec || typeof spec !== 'object' || typeof spec.run !== 'string' || !spec.run) {
      errors.push(`${file}: prerequisite "${name}" needs a run command`);
      continue;
    }
    if (spec.evidence !== undefined && !Array.isArray(spec.evidence)) {
      errors.push(`${file}: prerequisite "${name}".evidence must be a list of files/globs`);
      continue;
    }
    if (spec.cache !== undefined && !Array.isArray(spec.cache)) {
      errors.push(`${file}: prerequisite "${name}".cache must be a list of directories`);
      continue;
    }
    if (spec.timeout_s !== undefined && !(Number(spec.timeout_s) > 0)) {
      errors.push(`${file}: prerequisite "${name}".timeout_s must be a positive number of seconds`);
      continue;
    }
    specs[name] = normalizeSetup({ setup: spec });
  }
  return { specs, errors };
}

export function declaredPrereqs(config) {
  return Object.entries(config?.setup || {}).map(([name, spec]) => ({ name, spec }));
}

// The names a claim requires, in the order it lists them.
export function requiredNames(claim) {
  const raw = claim?.check?.requires ?? claim?.fm?.check?.requires;
  if (raw === undefined || raw === null || raw === '') return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

// A claim's prerequisites, in the order they must run: the named installs it
// requires, then its own inline setup — the specific step that builds on them.
export function resolvePrereqs(claim, config = {}) {
  const specs = [];
  const unknown = [];
  const seen = new Set();
  const push = (name, raw) => {
    if (!raw) return;
    // Normalizing here keeps the caller's shapes interchangeable: a spec from
    // manual.yaml is already normalized, a shorthand string is not, and neither
    // should decide whether deduplication works.
    const spec = normalizeSetup({ setup: raw });
    const key = `${spec.run}\0${spec.evidence.join(',')}\0${spec.cache.join(',')}`;
    if (seen.has(key)) return; // one claim listing the same step twice, or two names for it
    seen.add(key);
    specs.push({ name, spec });
  };
  for (const name of requiredNames(claim)) {
    const spec = config?.setup?.[name];
    // A name with no definition is not a skipped step, it is a typo — the
    // caller reports it rather than letting the check run unprepared.
    if (!spec) unknown.push(name);
    else push(name, spec);
  }
  const inline = claim?.setup || normalizeSetup(claim?.check);
  if (inline) push(null, inline);
  return { specs, unknown };
}

export function normalizeSetup(check) {
  const raw = check?.setup;
  if (!raw) return null;
  const spec = typeof raw === 'string' ? { run: raw } : { ...raw };
  const cache = spec.cache === undefined ? DEFAULT_CACHE : spec.cache;
  return {
    run: String(spec.run),
    evidence: Array.isArray(spec.evidence) ? spec.evidence.map(String) : [],
    cache: Array.isArray(cache) ? cache.map(String) : [],
    timeout_s: Number(spec.timeout_s) > 0 ? Number(spec.timeout_s) : DEFAULT_TIMEOUT_S,
  };
}

// Files that decide what an install would produce, when a claim doesn't say.
const LOCKFILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'package.json', 'requirements.txt', 'poetry.lock', 'Gemfile.lock', 'go.sum',
  'Cargo.lock', 'pom.xml', 'build.gradle',
];

export function defaultSetupEvidence(root) {
  const found = LOCKFILES.filter((f) => fs.existsSync(path.join(root, f)));
  return found.length ? found : ['package.json'];
}

// The cache key: the command, plus the content of everything that could change
// what it installs. Content, not mtime — a touched lockfile must not cost a
// full reinstall, and a reverted one must not skip it.
export function setupKey(root, spec) {
  const patterns = spec.evidence.length ? spec.evidence : defaultSetupEvidence(root);
  const d = filesDigest(root, patterns);
  return 'setup-' + sha256(`${spec.run}\0${spec.evidence.length ? '' : 'default'}\0${d.digest}`).slice(0, 16);
}

export function setupCachePath(root) {
  return path.join(root, '.manual', 'cache', 'setup.json');
}

export function readSetupCache(root) {
  try {
    const d = JSON.parse(fs.readFileSync(setupCachePath(root), 'utf8'));
    return d && d.entries ? d : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeSetupCache(root, data) {
  const p = setupCachePath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

// What would happen if this setup were needed right now — used by `manual
// setup`, doctor and the report, and free of side effects: no install runs.
export function setupStatus(root, spec) {
  const key = setupKey(root, spec);
  const entry = readSetupCache(root).entries[key] || null;
  const missing = spec.cache.filter((d) => !fs.existsSync(path.join(root, d)));
  return {
    key,
    run: spec.run,
    cache: spec.cache,
    cached: Boolean(entry?.ok) && missing.length === 0,
    entry,
    missing,
  };
}

// One memo per (root, key) per process: within a single verify, a failed
// install must not be retried once per claim — that is how a 40-second npm ci
// becomes a six-minute verify. Across processes the on-disk cache decides.
const memo = new Map();

function setupEnv(root) {
  const env = { ...process.env, MANUAL_ROOT: root, MANUAL_SETUP: '1' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export async function ensureSetup(root, spec, { force = false, quiet = false, onRun = null } = {}) {
  const key = setupKey(root, spec);
  const memoKey = `${root}\0${key}`;
  if (!force && memo.has(memoKey)) {
    // Within one run: a failure is not retried once per claim (that is how a
    // 40-second install becomes a six-minute verify), and a success that has
    // already happened is reported as what it now is — satisfied, not "ran".
    const hit = memo.get(memoKey);
    return hit.status === 'ran' ? { ...hit, status: 'cached' } : hit;
  }

  const cache = readSetupCache(root);
  const entry = cache.entries[key];
  const missing = spec.cache.filter((d) => !fs.existsSync(path.join(root, d)));

  // Cached and still present: the premise is already established.
  if (!force && entry?.ok && missing.length === 0) {
    const out = {
      key,
      status: 'cached',
      run: spec.run,
      ms: entry.ms ?? null,
      at: entry.at,
      note: `already satisfied at ${entry.at}${entry.ms != null ? ` (${entry.ms}ms)` : ''}`,
    };
    memo.set(memoKey, out);
    return out;
  }

  if (onRun) onRun({ key, run: spec.run, missing });
  if (!quiet) {
    const why = entry?.ok
      ? `${missing.join(', ')} missing`
      : entry
        ? `previous attempt failed`
        : 'not yet run here';
    console.log(`  ⚙ setup: ${spec.run} (${why})`);
  }

  const t0 = Date.now();
  const r = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', spec.run], {
    cwd: root,
    encoding: 'buffer',
    timeout: spec.timeout_s * 1000,
    env: setupEnv(root),
    maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const dec = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? ''));
  const stdout = dec(r.stdout);
  const stderr = dec(r.stderr);
  const timedOut = r.status === null && r.error?.code === 'ETIMEDOUT';

  if (r.status === 0) {
    cache.entries[key] = {
      run: spec.run,
      ok: true,
      at: nowIso(),
      ms,
      dirs: spec.cache,
      // Recorded so a later reader can tell a first install from a reinstall.
      reason: entry?.ok ? 'deps missing' : entry ? 'previous attempt failed' : 'not yet run here',
    };
    writeSetupCache(root, cache);
    const out = { key, status: 'ran', run: spec.run, ms, at: cache.entries[key].at, note: `${ms}ms` };
    memo.set(memoKey, out);
    if (!quiet) console.log(`  ⚙ setup: ok (${ms}ms)`);
    return out;
  }

  // Failures are recorded for diagnosis but never trusted: the next attempt
  // runs again, because the usual cause (no network, a locked file) is
  // transient and caching it would blind the manual forever.
  cache.entries[key] = {
    run: spec.run,
    ok: false,
    at: nowIso(),
    ms,
    dirs: spec.cache,
    note: short(stderr || stdout || (timedOut ? 'timed out' : `exit ${r.status}`), 300),
  };
  writeSetupCache(root, cache);
  const out = {
    key,
    status: timedOut ? 'timeout' : 'failed',
    run: spec.run,
    ms,
    exit: r.status,
    timedOut,
    note: short(stderr || stdout || `exit ${r.status}`, 300),
  };
  memo.set(memoKey, out);
  return out;
}

// Distinct specs across a set of claims, so a verify pays for each install at
// most once. Returns nothing: this exists to warm the memo and the disk cache
// *before* the sandbox is created, so that directories the install creates can
// still be linked into the worktree.
export async function warmSetups(root, claims, { force = false, quiet = false, onRun = null, config = {} } = {}) {
  const seen = new Set();
  const results = [];
  for (const cl of claims) {
    for (const { name, spec } of resolvePrereqs(cl, config).specs) {
      const key = setupKey(root, spec);
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await ensureSetup(root, spec, { force, quiet, onRun });
      results.push({ ...r, name, id: cl.fm?.id });
    }
  }
  return results;
}

export function resetSetupMemo() {
  memo.clear();
}
