// Wild-repo canary: run the builtins and the init/verify lifecycle against
// repositories this tool did not grow up with.
//
// Every builtin verifier in this repo earned its "yes" on a wild repo, and every
// false "yes" and false "no" was found on one too — pnpm 12's peer-suffixed store
// dirs (165 false misses), npm's other-platform binaries (20), bun's peer
// variants (3), and a deleted vendored package that modules.txt still promised.
// Fixtures cannot produce those: they are tuned to the version that was current
// the day they were written. So the check runs here, on a fresh clone, with the
// ecosystem's own installer having just populated the tree.
//
// The one rule the canary enforces: a healthy tree must never be reported as
// unsatisfied. `ok: null` (cannot tell) is a pass — the tool's job is to
// withhold a verdict it cannot back, and several locks legitimately cannot
// answer (uv.lock does not mark group membership; Cargo.lock covers
// dev-dependencies a plain build never fetches). `ok: false` on a tree the
// ecosystem's own installer just produced is the failure this exists to catch.
//
// Usage:
//   node test/wild.mjs builtin   --root <dir> --name <builtin> --expect ok|none
//   node test/wild.mjs lifecycle --root <dir> [--name <label>]
//
// Run by .github/workflows/wild.yml on release. See docs/WILD-REPOS.md.

import fs from 'node:fs';
import path from 'node:path';
import { runBuiltinVerifier, resolveBuiltin } from '../src/verifiers.js';
import { init, probeCandidates } from '../src/init.js';
import { acceptInbox, listInbox } from '../src/inbox.js';
import { verify } from '../src/verify.js';
import { State } from '../src/state.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const fail = (msg) => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};
const pass = (msg) => console.log(`✓ ${msg}`);

async function builtin() {
  const root = flag('root');
  const name = flag('name');
  const expect = flag('expect', 'ok');
  const label = flag('label', `${name} on ${path.basename(root || '?')}`);
  if (!root || !name) fail('builtin needs --root and --name');

  const resolved = resolveBuiltin(root, { verifyBuiltin: name });
  const res = await runBuiltinVerifier(root, { verifyBuiltin: name });
  console.log(`${label}`);
  console.log(`  builtin: ${res.builtin || resolved.name} (${resolved.why})`);
  console.log(`  verdict: ok=${res.ok} in ${res.ms}ms`);
  console.log(`  note:    ${res.note}`);

  if (res.ok === false) {
    // The whole point. Everything else can be improved later; this cannot stand.
    fail(`${label}: the tree its own installer just populated was reported unsatisfied${res.missing?.length ? ` (e.g. ${res.missing[0]})` : ''}`);
  }
  if (expect === 'ok' && res.ok !== true) {
    fail(`${label}: expected a verdict of "yes" on a healthy tree, got ok=${res.ok} — ${res.note}`);
  }
  if (expect === 'none') {
    pass(`${label}: withheld a verdict (${res.ok === null ? 'cannot tell' : `ok=${res.ok}`}) — no false "no"`);
  } else {
    pass(`${label}: ${res.ok === true ? 'ok' : `ok=${res.ok} (not a no)`}`);
  }
}

async function lifecycle() {
  const root = flag('root');
  const label = flag('label', `init/verify on ${path.basename(root || '?')}`);
  if (!root) fail('lifecycle needs --root');

  // A clone may ship its own .manual/ (this tool's own repo does). The canary
  // measures discovery from scratch, so start from nothing.
  fs.rmSync(path.join(root, '.manual'), { recursive: true, force: true });

  init(root, { dryRun: false });
  const candidates = listInbox(root);
  console.log(`  discovered ${candidates.length} candidate(s)`);
  // An empty manual used to be the normal outcome on a repo with no
  // package.json: discovery drove everything off Node's manifest, so a Go or
  // Python checkout produced nothing at all and no test noticed, because
  // "proposed no claims" and "had nothing to propose" looked identical. The
  // matrix only names repos that have a suite, so finding nothing here is the
  // regression — not a clean pass.
  if (candidates.length === 0) {
    fail(`${label}: discovery proposed nothing on a repo with a test suite — check ${path.basename(root)} for a manifest nonNodeSuites() does not read`);
  }

  // The probe is the other half of discovery: it runs each candidate once, wires
  // the prerequisite a failure implies, and writes the bound that measurement
  // earns. Without it every candidate is unmeasured, which is how a five-minute
  // suite ends up stamped `blocked` against the config default forever.
  const probed = await probeCandidates(root, { quiet: true });
  for (const p of probed) {
    const file = path.join(root, '.manual', 'inbox', p.file);
    const bound = fs.existsSync(file) ? /max_ms: (\d+)/.exec(fs.readFileSync(file, 'utf8')) : null;
    console.log(`  probed ${p.file}: ${p.state} (${p.note})${bound ? ` max_ms=${bound[1]}` : ''}${p.requires ? ` requires=${p.requires}` : ''}`);
  }

  // The probe must run before the candidates move: it is what writes the bound
  // and the prerequisite into the file, and a candidate accepted first would
  // carry neither. CI cannot hand a candidate to a human, so accept the lot —
  // the point is to exercise the checks discovery wrote, not to endorse them.
  for (const file of candidates) {
    try {
      acceptInbox(root, file, { quiet: true });
    } catch (e) {
      console.log(`  skipped ${file}: ${e.message}`);
    }
  }

  const state = new State(root);
  // Setup runs here rather than in the workflow, because that is the half of
  // the lifecycle worth testing end to end: discovery names the install, verify
  // performs it once, and only then does the check run. A canary that
  // pre-installed the tree and passed --no-setup would never exercise the
  // prerequisite path at all — and that path is where "the claim ran against an
  // install that was never made" hides (npm/cli, whose checkout commits a
  // partial node_modules). The --preinstalled cells are the exception: the
  // workflow installed the tree because the probe's calibration window cannot
  // hold this suite's first cold run; verify still runs, with setup allowed but
  // already satisfied, so the claim is checked against the tree it declared.
  const res = await verify(root, { state, force: true, quiet: true });
  state.save();

  const broken = [];
  const blocked = [];
  for (const r of res.results) {
    const note = r.stamp.note ? ` — ${r.stamp.note}` : '';
    console.log(`  ${r.stamp.state.padEnd(7)} ${r.claim.fm.id}${note}`);
    if (r.stamp.state === 'broken') broken.push(r.claim.fm.id);
    if (r.stamp.state === 'blocked') blocked.push(r.claim.fm.id);
  }
  if (res.errors.length) {
    console.log(`  load errors: ${res.errors.join('; ')}`);
  }
  if (blocked.length) {
    console.log(`  note: ${blocked.length} claim(s) could not be tested here (${blocked.join(', ')}) — untested, not false`);
  }
  if (broken.length) {
    fail(`${label}: ${broken.length} claim(s) discovery proposed do not hold: ${broken.join(', ')} — read the note above; either discovery proposed a claim the repo contradicts, or a check is misdeclared`);
  }
  pass(`${label}: ${res.results.length} claim(s), none broken`);
}

if (cmd === 'builtin') await builtin();
else if (cmd === 'lifecycle') await lifecycle();
else fail(`unknown command: ${cmd || '(none)'} — use "builtin" or "lifecycle"`);
