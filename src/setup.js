import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { filesDigest, sha256 } from './hash.js';
import { nowIso, short } from './util.js';
import {
  BUILTIN_NAMES,
  VERIFY_BUILTINS,
  canonicalBuiltin,
  lockfileIn,
  resolveBuiltin,
  runBuiltinVerifier,
  verifierAvailable as verifierAvailability,
  verifyLockfile,
} from './verifiers.js';

export { VERIFY_BUILTINS, lockfileIn, verifyLockfile };

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

// The statuses that mean "the check may now run": a step that succeeded because
// it was borrowed is a success — the directories are there and were verified
// where they were built.
export const SETUP_OK_STATUSES = new Set(['ran', 'cached', 'adopted']);

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
// Prerequisites can depend on each other (`build` needs the install first), so
// a claim's list is expanded through those edges and ordered topologically.
// Resolution is by name, then by inline setup, and deduplication is by
// (command, evidence) as before — so ten claims requiring `node` pay for one
// install, and a claim requiring both `node` and `python` pays for two, once
// each, whatever order the claims run in.
//
//   setup:
//     node:  { run: npm ci, verify: "npm ls --depth=0" }
//     build: { run: make build, requires: [node], cache: ["dist"] }
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9.-]*$/;

// Deduplication key for a step, independent of what it is called.
export function specKey(spec) {
  return `${spec.run}\0${spec.evidence.join(',')}\0${spec.cache.join(',')}`;
}

// Names as written: one name, or a list, both accepted everywhere a name is.
export function nameList(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

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
    if (spec.requires !== undefined && !Array.isArray(spec.requires) && typeof spec.requires !== 'string') {
      errors.push(`${file}: prerequisite "${name}".requires must be a name or a list of names`);
      continue;
    }
    const v = normalizeVerify(spec.verify);
    if (v.error) {
      errors.push(`${file}: prerequisite "${name}".verify ${v.error}`);
      continue;
    }
    if (spec.share !== undefined && typeof spec.share !== 'boolean') {
      errors.push(`${file}: prerequisite "${name}".share must be true or false`);
      continue;
    }
    specs[name] = normalizeSetup({ setup: spec });
  }
  return { specs, errors };
}

// The declared prerequisites in dependency order: a step comes after everything
// it requires. Cycles are reported rather than resolved silently — a cycle means
// no order exists, and pretending otherwise would run one of the steps too early.
// Steps inside a cycle are left out of `order` for the same reason: there is no
// position for them, and a partial list that omits them is the truth, whereas a
// list that contains them is a sequence that cannot be executed. Callers refuse
// on a non-empty `cycles` anyway (see runner.js).
export function prereqOrder(config = {}) {
  const setup = config.setup || {};
  const order = [];
  const unknown = [];
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (name) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      cycles.push([...stack.slice(stack.indexOf(name)), name]);
      return;
    }
    state.set(name, 'visiting');
    stack.push(name);
    for (const dep of setup[name].requires || []) {
      if (!setup[dep]) {
        unknown.push({ name: dep, required_by: name });
        continue;
      }
      visit(dep);
    }
    stack.pop();
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of Object.keys(setup)) visit(name);
  const inCycle = new Set();
  for (const cy of cycles) for (const name of cy.slice(0, -1)) inCycle.add(name);
  return { order: order.filter((name) => !inCycle.has(name)), unknown, cycles };
}

export function declaredPrereqs(config) {
  return Object.entries(config?.setup || {}).map(([name, spec]) => ({ name, spec }));
}

// The names a claim requires, in the order it lists them.
export function requiredNames(claim) {
  return nameList(claim?.check?.requires ?? claim?.fm?.check?.requires);
}

// A claim's prerequisites, in the order they must run: the named installs it
// requires (each expanded through its own `requires` edges), then its own inline
// setup — the specific step that builds on them.
export function resolvePrereqs(claim, config = {}) {
  const setup = config.setup || {};
  const specs = [];
  const unknown = [];
  const cycles = [];
  const done = new Set();
  const seenKeys = new Set();
  const stack = [];
  const push = (name, raw) => {
    if (!raw) return;
    // Normalizing here keeps the caller's shapes interchangeable: a spec from
    // manual.yaml is already normalized, a shorthand string is not, and neither
    // should decide whether deduplication works.
    const spec = normalizeSetup({ setup: raw });
    const key = specKey(spec);
    if (seenKeys.has(key)) return; // one claim listing the same step twice, or two names for it
    seenKeys.add(key);
    specs.push({ name, spec });
  };
  const visit = (name) => {
    if (done.has(name)) return;
    const spec = setup[name];
    // A name with no definition is not a skipped step, it is a typo — the
    // caller reports it rather than letting the check run unprepared.
    if (!spec) {
      unknown.push(name);
      return;
    }
    if (stack.includes(name)) {
      cycles.push([...stack.slice(stack.indexOf(name)), name]);
      return;
    }
    stack.push(name);
    for (const dep of spec.requires || []) visit(dep);
    stack.pop();
    done.add(name);
    push(name, spec);
  };
  for (const name of requiredNames(claim)) visit(name);
  const inline = claim?.setup || normalizeSetup(claim?.check);
  if (inline) push(null, inline);
  return { specs, unknown, cycles };
}

// The exact sequence a full verify would execute, deduped, claim by claim (a
// claim's closure runs at that claim's turn). This is what `setup --plan`
// prints, so the plan is the run and not an approximation of it.
export function planPrereqs(claims, config = {}) {
  const steps = [];
  const byKey = new Map();
  const unknown = new Map();
  const cycles = [];
  for (const cl of claims) {
    const id = cl.fm?.id || null;
    const { specs, unknown: miss, cycles: loop } = resolvePrereqs(cl, config);
    for (const name of miss) unknown.set(name, [...(unknown.get(name) || []), id]);
    for (const cy of loop) if (!cycles.some((c) => c.join('>') === cy.join('>'))) cycles.push(cy);
    for (const { name, spec } of specs) {
      const key = specKey(spec);
      if (byKey.has(key)) {
        const step = byKey.get(key);
        if (id && !step.claims.includes(id)) step.claims.push(id);
        continue;
      }
      const step = { name, spec, key, claims: id ? [id] : [], inline: name === null };
      byKey.set(key, step);
      steps.push(step);
    }
  }
  return { steps, unknown: [...unknown.entries()].map(([name, claims]) => ({ name, claims })), cycles };
}

// Built-in verifiers live in verifiers.js — one per ecosystem, all of them
// answering three ways: yes, no, and "there is nothing here to compare
// against". A command can still answer the same question, but a builtin asks it
// with a readdir per verify instead of a tree walk.
const BUILTIN_CHOICES = ["auto", ...BUILTIN_NAMES].join(' | ');

// A typo deserves the list, not a refusal.
function builtinError(name) {
  return `builtin "${name}" is not one of: ${BUILTIN_CHOICES} (lockfile is an older spelling of npm)`;
}

// `verify: "npm ls --depth=0"` is a command; `verify: { builtin: npm }` is one of
// ours. The map form is required for builtins, so a bare word is never
// ambiguous — and a `builtin:name` string is read as the same declaration rather
// than run as a command, because "run the marker as a shell command" is a bug
// that has already happened here once (`builtin:lockfile: command not found`,
// which degraded every cached install to a reinstall).
export function normalizeVerify(raw) {
  if (raw === undefined || raw === null) return { verify: null, builtin: null };
  if (typeof raw === 'string') {
    if (!raw.trim()) return { error: 'must be a command that exits 0 for a valid install' };
    const marker = /^builtin:\s*([A-Za-z0-9_-]+)$/.exec(raw.trim());
    if (marker) {
      const name = canonicalBuiltin(marker[1]);
      if (!name) return { error: builtinError(marker[1]) };
      return { verify: `builtin:${name}`, builtin: name, builtinOptions: {} };
    }
    return { verify: raw, builtin: null };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const name = canonicalBuiltin(raw.builtin);
    if (!name) return { error: builtinError(raw.builtin) };
    // `builtin` is dropped rather than set to undefined: an own key holding
    // undefined is still a difference, and options that survive one pass and not
    // the next are options that work until the config is re-read.
    const { builtin: _drop, ...options } = raw;
    return { verify: `builtin:${name}`, builtin: name, builtinOptions: options };
  }
  return { error: `must be a command, or { builtin: ${BUILTIN_CHOICES} }` };
}

export function normalizeSetup(check) {
  const raw = check?.setup;
  if (!raw) return null;
  const spec = typeof raw === 'string' ? { run: raw } : { ...raw };
  const cache = spec.cache === undefined ? DEFAULT_CACHE : spec.cache;
  // Idempotent: a spec that has already been normalized carries verifyBuiltin,
  // and `verify` in its `builtin:name` form. Re-deriving the builtin from that
  // string is impossible by design (the map form exists precisely so a bare word
  // is never ambiguous), and doing it anyway silently downgraded the builtin to
  // a shell command that always fails — found on a real repo, where every cached
  // install was distrusted and reinstalled after `builtin:lockfile: command not
  // found`. Normalizing twice must be the same as normalizing once.
  const v = spec.verifyBuiltin !== undefined && spec.verifyBuiltin !== null
    ? { verify: spec.verify ?? `builtin:${spec.verifyBuiltin}`, builtin: spec.verifyBuiltin, builtinOptions: spec.builtinOptions || {} }
    : normalizeVerify(spec.verify);
  return {
    run: String(spec.run),
    evidence: Array.isArray(spec.evidence) ? spec.evidence.map(String) : [],
    cache: Array.isArray(cache) ? cache.map(String) : [],
    timeout_s: Number(spec.timeout_s) > 0 ? Number(spec.timeout_s) : DEFAULT_TIMEOUT_S,
    // A prerequisite can depend on another one (`build` needs `node`), be
    // re-checked before its cached result is trusted, and be borrowed from
    // another checkout on this machine that already installed it.
    requires: nameList(spec.requires),
    verify: v.verify || null,
    verifyBuiltin: v.builtin || null,
    // What a builtin was told beyond its name (`{ builtin: venv, path: ".venv" }`),
    // carried through normalization: normalizing twice is normalizing once, and
    // options that vanish on the second pass would be options that work until
    // something re-reads the config.
    builtinOptions: v.builtinOptions || {},
    share: spec.share === true,
  };
}

// The builtin verifiers, and the npm one this file used to hold itself, now live
// in verifiers.js: `lockfile` and `verifyLockfile` are imported above and
// re-exported, so a caller that used them keeps working. The npm verifier still
// answers the question the cache key cannot — an install made from *this*
// lockfile can still have lost a subtree in the meantime (an interrupted
// `npm ci`, a deletion, an antivirus quarantine) — in a few hundred `stat` calls
// rather than by walking the tree.

// Run a prerequisite's verifier and describe the outcome.
//
// A builtin is answered by its ecosystem module in verifiers.js; a declared
// command is capped at two minutes, because this runs on the path whose whole
// point is to avoid work — a verifier that hangs is worse than one that says no.
export function runVerifier(root, spec) {
  if (spec.verifyBuiltin) return runBuiltinVerifier(root, spec);
  if (!spec.verify) return null;
  const r = execInRoot(root, spec.verify, Math.min(spec.timeout_s, 120));
  return { ok: r.status === 0, ms: r.ms, note: r.status === 0 ? `exit 0 in ${r.ms}ms` : r.note };
}

// Whether a declared verifier can answer at all *here* — a stat, or one readdir,
// so it is cheap enough for `manual setup` and the plan to report it without
// running anything. The reason is returned rather than logged, because "cannot
// check" and "checked and fine" must never read the same.
export function verifierAvailable(root, spec) {
  if (spec.verifyBuiltin) return verifierAvailability(root, spec);
  return null;
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

// ---------------------------------------------------------------------------
// Trusting a cached install
//
// "This ran once" is not evidence that the tree is still there, still complete,
// or still the one the lockfile describes. Three layers, cheapest first:
//   1. the declared directories exist (a stat each) — the oldest check, which
//      misses a tree that was emptied in place;
//   2. a witness: the immediate entries of those directories, hashed and
//      counted, which catches a wiped, replaced, or half-installed tree at the
//      cost of one readdir;
//   3. `verify:` — an optional command the prerequisite can answer with
//      ("npm ls --depth=0"), and the only thing that can tell a stale tree from
//      a complete one.
// A cached result that fails a layer is distrusted and rebuilt, and the layer
// that caught it is recorded, so a surprise reinstall is explainable.
// ---------------------------------------------------------------------------

export function witnessFor(root, dirs) {
  const out = {};
  for (const rel of dirs) {
    let names;
    try {
      names = fs.readdirSync(path.join(root, rel)).sort();
    } catch {
      return null; // a declared directory that isn't there has no witness
    }
    out[rel] = { n: names.length, sig: sha256(names.join('\0')).slice(0, 16) };
  }
  return Object.keys(out).length ? out : null;
}

// An entry with no witness predates this check: fall back to layer 1.
export function witnessMatches(root, witness) {
  if (!witness) return true;
  const now = witnessFor(root, Object.keys(witness));
  if (!now) return false;
  for (const [rel, w] of Object.entries(witness)) {
    const cur = now[rel];
    if (!cur || cur.n !== w.n || cur.sig !== w.sig) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sharing a verified install with other checkouts on this machine
//
// The cache is per checkout, so a second clone installs the same tree again from
// scratch. The store records where a verified install lives (not a copy of it),
// keyed by platform + command + evidence content: a checkout whose evidence
// matches can link the other checkout's directories instead of installing. It is
// opt-in per prerequisite (`share: true`) because the tree is then genuinely
// shared — mutating it in one checkout mutates it in the other, exactly as the
// sandbox's own dependency links do.
// ---------------------------------------------------------------------------

export function storeFilePath() {
  const home = process.env.MANUAL_STORE || path.join(os.homedir(), '.cache', 'manual-cli');
  return path.join(home, 'setup-store.json');
}

export function readStore() {
  try {
    const d = JSON.parse(fs.readFileSync(storeFilePath(), 'utf8'));
    return d && d.results ? d : { version: 1, results: {} };
  } catch {
    return { version: 1, results: {} };
  }
}

function writeStore(data) {
  const p = storeFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

// Platform is part of the identity: a Windows node_modules is not a Linux one.
export function storeKey(root, spec) {
  const patterns = spec.evidence.length ? spec.evidence : defaultSetupEvidence(root);
  const d = filesDigest(root, patterns);
  return sha256(`${process.platform}\0${spec.run}\0${d.digest}`).slice(0, 32);
}

export function recordStore(root, spec, witness) {
  const data = readStore();
  data.results[storeKey(root, spec)] = {
    run: spec.run,
    platform: process.platform,
    checkout: root,
    at: nowIso(),
    witness,
    verify: spec.verify,
  };
  writeStore(data);
}

// An install on this machine that this checkout can borrow — verified *now*,
// because the checkout that made it may have moved on since.
export function storeLookup(root, spec) {
  const key = storeKey(root, spec);
  const entry = readStore().results[key];
  if (!entry?.checkout) return null;
  if (path.resolve(entry.checkout) === path.resolve(root)) return null;
  if (!fs.existsSync(entry.checkout)) return null;
  if (entry.witness && !witnessMatches(entry.checkout, entry.witness)) return null;
  return { key, entry, source: entry.checkout };
}

// What would happen if this setup were needed right now — used by `manual
// setup`, doctor and the report. Free of side effects: nothing is installed, and
// the expensive layer (a `verify:` command) is not run here; the witness is a
// readdir, so it is worth answering with.
export function setupStatus(root, spec) {
  const key = setupKey(root, spec);
  const resolved = resolveBuiltin(root, spec);
  const entry = readSetupCache(root).entries[key] || null;
  const missing = spec.cache.filter((d) => !fs.existsSync(path.join(root, d)));
  const witnessOk = entry?.witness ? witnessMatches(root, entry.witness) : null;
  const borrowed = !entry?.ok && spec.share ? storeLookup(root, spec) : null;
  return {
    key,
    run: spec.run,
    cache: spec.cache,
    cached: Boolean(entry?.ok) && missing.length === 0 && witnessOk !== false,
    entry,
    missing,
    witness_ok: witnessOk,
    verify: spec.verify,
    // Which ecosystem verifier will be asked, and why that one: `auto` is a
    // question, and reporting the question instead of the answer would leave a
    // reader unable to tell a resolved verifier from an unresolved one.
    verify_builtin: resolved.name,
    verify_why: resolved.why,
    verify_label: !spec.verify
      ? null
      : resolved.name && resolved.name !== String(spec.verify).replace(/^builtin:/, '')
        ? `${spec.verify} → ${resolved.name} (${resolved.why})`
        : spec.verify,
    // A declared verifier that cannot run here is reported rather than silently
    // skipped: "verified" and "unverifiable" are different facts about a tree.
    verify_unavailable: verifierAvailable(root, spec),
    requires: spec.requires,
    share: spec.share,
    // A step that is not satisfied here but is available from another checkout.
    borrowable_from: borrowed?.source || null,
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

// One place for "run a command for this prerequisite", so the install and the
// `verify:` command cannot drift apart in env, cwd or error shape.
function execInRoot(root, cmd, timeoutS) {
  const t0 = Date.now();
  const r = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', cmd], {
    cwd: root,
    encoding: 'buffer',
    timeout: timeoutS * 1000,
    env: setupEnv(root),
    maxBuffer: 8 * 1024 * 1024,
  });
  const dec = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? ''));
  return {
    ms: Date.now() - t0,
    status: r.status,
    stdout: dec(r.stdout),
    stderr: dec(r.stderr),
    timedOut: r.status === null && r.error?.code === 'ETIMEDOUT',
    note: short(dec(r.stderr) || dec(r.stdout) || `exit ${r.status}`, 300),
  };
}

// Borrow another checkout's verified install by linking its directories. Refuses
// on any doubt: a missing source directory, or a directory that already exists
// here (linking over one would discard it, and a symlink over a real tree is how
// you lose a node_modules).
function adopt(root, spec, hit) {
  if (spec.cache.length === 0) return null; // nothing to link, nothing to check
  const linked = [];
  for (const rel of spec.cache) {
    const src = path.join(hit.source, rel);
    const dst = path.join(root, rel);
    if (!fs.existsSync(src) || fs.existsSync(dst)) return null;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(rel);
    } catch {
      return null;
    }
  }
  return linked;
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

  // Layer 1: the directories are there. Layers 2 and 3 ask whether they are the
  // ones we installed — a wiped tree, or one the lockfile no longer describes.
  if (!force && entry?.ok && missing.length === 0) {
    const witnessOk = witnessMatches(root, entry.witness);
    const check = witnessOk ? runVerifier(root, spec) : null;
    // `ok === null` is the verifier's "nothing to compare against": it is not a
    // reason to rebuild, and treating it as one would make every verify reinstall
    // on any repo without the file the verifier needs.
    if (witnessOk && (!check || check.ok !== false)) {
      // The verifier could have answered and did not: that is news about the
      // tree, and it belongs in front of whoever is reading the verify. A
      // verifier that can never answer here is already reported by `manual setup`
      // and doctor, and repeating it on every verify would be noise.
      if (check?.ok === null && !check.unavailable && !quiet) {
        console.log(`  ⚙ setup: ${spec.run} — reused, not re-confirmed: ${short(check.note, 240)}`);
      }
      const out = {
        key,
        status: 'cached',
        run: spec.run,
        ms: entry.ms ?? null,
        at: entry.at,
        verified_at: check ? nowIso() : entry.verified_at || null,
        // What the verifier answered, kept on the result so a caller can report
        // "reused because it was re-checked" rather than "reused".
        verify: check ? { builtin: check.builtin || spec.verifyBuiltin || null, ok: check.ok, note: check.note, ms: check.ms } : null,
        note: `already satisfied at ${entry.at}${entry.ms != null ? ` (${entry.ms}ms)` : ''}`,
      };
      memo.set(memoKey, out);
      return out;
    }
    entry.invalidated = {
      at: nowIso(),
      by: witnessOk ? 'verify' : 'witness',
      note: witnessOk ? (check?.note || 'the verifier said no') : 'the declared directories changed since it ran',
    };
    cache.entries[key] = entry;
    writeSetupCache(root, cache);
    // Announced here rather than at the install, because the answer may instead
    // be to borrow another checkout's tree — and a reinstall nobody can explain
    // reads as a cache that does not work.
    if (!quiet) {
      console.log(`  ⚙ setup: ${spec.run} (cached install distrusted — ${entry.invalidated.by}: ${short(entry.invalidated.note, 160)})`);
    }
  }

  // A verified install of the same command and evidence, made by another
  // checkout on this machine, costs a symlink instead of an install.
  if (!force && spec.share) {
    const hit = storeLookup(root, spec);
    const linked = hit ? adopt(root, spec, hit) : null;
    if (linked) {
      const at = nowIso();
      cache.entries[key] = {
        run: spec.run,
        ok: true,
        at,
        // Not zero: the time this checkout spent, which is the honest number for
        // a borrowed tree.
        ms: 0,
        dirs: spec.cache,
        witness: hit.entry.witness,
        adopted_from: hit.source,
        reason: 'borrowed from another checkout',
      };
      writeSetupCache(root, cache);
      const out = {
        key,
        status: 'adopted',
        run: spec.run,
        ms: 0,
        at,
        link: hit.source,
        note: `borrowed ${linked.join(', ')} from ${hit.source}`,
      };
      memo.set(memoKey, out);
      if (!quiet) console.log(`  ⚙ setup: ${spec.run} — borrowed from ${hit.source} (verified there, never installed here)`);
      return out;
    }
  }

  if (onRun) onRun({ key, run: spec.run, missing });
  if (!quiet) {
    // "Why now?" has four different answers, and a reinstall nobody can explain
    // is indistinguishable from a cache that does not work. Found on a real repo:
    // the entry was valid and the declared directories were present, so the honest
    // reason was the verifier's (or `--force`) — and it printed " missing".
    const why = entry?.ok
      ? entry.invalidated
        ? 'rebuilding the distrusted install'
        : missing.length
          ? `${missing.join(', ')} missing`
          : 'forced'
      : entry
        ? 'previous attempt failed'
        : 'not yet run here';
    console.log(`  ⚙ setup: ${spec.run} (${why})`);
  }

  const r = execInRoot(root, spec.run, spec.timeout_s);
  let witness = r.status === 0 ? witnessFor(root, spec.cache) : null;

  if (r.status === 0) {
    // A successful run is not evidence of a repaired tree. Found on a real
    // repo (a classic yarn 1 checkout): deleting a package behind yarn's back
    // distrusts the install (the witness), the declared
    // `yarn install --frozen-lockfile` runs as a measured no-op
    // ("Already up-to-date"), and recording a fresh witness then laundered
    // the damage — the verifier's `no` was architecturally unreachable,
    // because it was only consulted on the *reused* path. The same laundering
    // happens one step later for a retry of a failed install. So every run
    // this cache records is held to its own verifier first, and a `no` is a
    // failed install: the tree on disk does not satisfy what the manual
    // declared, and a failure is one thing this cache never trusts.
    if (spec.verify) {
      const check = runVerifier(root, spec);
      if (check && check.ok === false && !check.unavailable) {
        const note = `verify: ${short(check.note || 'the verifier said no', 160)}`;
        cache.entries[key] = {
          run: spec.run,
          ok: false,
          at: nowIso(),
          ms: r.ms,
          dirs: spec.cache,
          note,
        };
        writeSetupCache(root, cache);
        const out = { key, status: 'failed', run: spec.run, ms: r.ms, exit: r.status, note };
        memo.set(memoKey, out);
        if (!quiet) console.log(`  ⚙ setup: ${spec.run} (ran, but did not satisfy it — ${note})`);
        return out;
      }
    }
    // Having just run, the tree is by definition the one the command produced —
    // so `verify:` is recorded rather than paid for. It pays for itself the next
    // time this install is reused.
    cache.entries[key] = {
      run: spec.run,
      ok: true,
      at: nowIso(),
      ms: r.ms,
      dirs: spec.cache,
      witness,
      verify: spec.verify,
      // Recorded so a later reader can tell a first install from a reinstall.
      reason: entry?.ok ? (entry.invalidated ? `cached install distrusted (${entry.invalidated.by})` : 'deps missing') : entry ? 'previous attempt failed' : 'not yet run here',
    };
    writeSetupCache(root, cache);
    if (spec.share) recordStore(root, spec, witness);
    const out = { key, status: 'ran', run: spec.run, ms: r.ms, at: cache.entries[key].at, note: `${r.ms}ms` };
    memo.set(memoKey, out);
    if (!quiet) console.log(`  ⚙ setup: ok (${r.ms}ms)`);
    return out;
  }

  // Failures are recorded for diagnosis but never trusted: the next attempt
  // runs again, because the usual cause (no network, a locked file) is
  // transient and caching it would blind the manual forever.
  cache.entries[key] = {
    run: spec.run,
    ok: false,
    at: nowIso(),
    ms: r.ms,
    dirs: spec.cache,
    note: r.note || (r.timedOut ? 'timed out' : `exit ${r.status}`),
  };
  writeSetupCache(root, cache);
  const out = {
    key,
    status: r.timedOut ? 'timeout' : 'failed',
    run: spec.run,
    ms: r.ms,
    exit: r.status,
    timedOut: r.timedOut,
    note: r.note || `exit ${r.status}`,
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
