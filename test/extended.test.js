import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectForDiff } from '../src/diff.js';
import { enforce } from '../src/enforce.js';
import { planProposals, writeProposals, seriesStats, staleProposals } from '../src/observe.js';
import { doctor, printDoctor } from '../src/doctor.js';
import { listInbox, acceptInbox } from '../src/inbox.js';
import { init } from '../src/init.js';
import { verify } from '../src/verify.js';
import { State } from '../src/state.js';
import { loadManual } from '../src/claims.js';
import { nowIso } from '../src/util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');

const tmp = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  fs.cpSync(ROOT, dir, { recursive: true });
  fs.rmSync(path.join(dir, '.manual', 'state.json'), { force: true }); // fixtures start unstamped
  return dir;
};

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

describe('diff selection', () => {
  const claims = [
    { fm: { id: 'a.fact', kind: 'fact', applies_to: ['src/**'], depends_on: [] } },
    { fm: { id: 'b.tests', kind: 'command', applies_to: ['src/**'], depends_on: [{ id: 'a.fact', required: true }] } },
    { fm: { id: 'c.policy', kind: 'policy', applies_to: ['docs/**'], depends_on: [] } },
    { fm: { id: 'd.other', kind: 'command', applies_to: ['web/**'], depends_on: [] } },
  ];

  test('selects matching claims plus dep closure plus policies', () => {
    const picked = selectForDiff(claims, ['src/db/q.ts']).map((c) => c.fm.id).sort();
    assert.deepEqual(picked, ['a.fact', 'b.tests', 'c.policy']);
  });

  test('policies always ride along even with no overlap', () => {
    const picked = selectForDiff(claims, ['web/x.js']).map((c) => c.fm.id).sort();
    assert.deepEqual(picked, ['c.policy', 'd.other']);
  });

  test('empty diff keeps policies and always-claims only', () => {
    const withAlways = [...claims, { fm: { id: 'e.always', kind: 'fact', applies_to: ['**'], verify: 'always', depends_on: [] } }];
    const picked = selectForDiff(withAlways, []).map((c) => c.fm.id).sort();
    assert.deepEqual(picked, ['c.policy', 'e.always']);
  });

  test('verify --diff on non-git root runs policies plus their dependency closure', async () => {
    const dir = tmp('manual-diff-');
    const state = new State(dir);
    const res = await verify(dir, { state, force: true, diff: true });
    const ids = res.results.map((r) => r.claim.fm.id).sort();
    // The policy gate rides along on every diff (changed files are unknown
    // without git), and so do the claims it depends on — a gate whose
    // dependencies are unverified cannot be trusted to mean anything.
    assert.deepEqual(ids, ['policy.tests-registered', 'tests.demo', 'tooling.node-esm']);
    cleanup(dir);
  });
});

describe('enforce', () => {
  test('passing policy gate exits clean', async () => {
    const dir = tmp('manual-enf-');
    const state = new State(dir);
    const { ran, failures } = await enforce(dir, state, { stage: 'pre-commit' });
    assert.deepEqual(ran, ['policy.tests-registered']);
    assert.deepEqual(failures, []);
    cleanup(dir);
  });

  test('broken policy produces a blocking failure', async () => {
    const dir = tmp('manual-enfbad-');
    // break the policy: a test file without node:test import
    fs.writeFileSync(path.join(dir, 'src', 'extra.test.js'), `import assert from 'node:assert/strict';\nassert.equal(1, 1);\n`);
    const state = new State(dir);
    const { failures } = await enforce(dir, state, { stage: 'pre-commit' });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].severity, 'block');
    assert.equal(failures[0].id, 'policy.tests-registered');
    cleanup(dir);
  });
});

describe('observe (flywheel)', () => {
  test('proposes tighten when measurements sit far under the bound', () => {
    const dir = tmp('manual-obs-');
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' }); // proposals require a verified claim
    for (let i = 0; i < 5; i++) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms: 210 + i * 5 });
    const proposals = planProposals(dir, state);
    const tighten = proposals.find((p) => p.id === 'tests.demo' && p.kind === 'tighten');
    assert.ok(tighten, 'expected a tighten proposal');
    assert.equal(tighten.bound, 30000);
    assert.ok(tighten.proposed < 30000 && tighten.proposed >= 700);
    const written = writeProposals(dir, state, { quiet: true });
    assert.equal(written.length, 1);
    assert.ok(fs.existsSync(path.join(dir, '.manual', 'inbox', written[0].file)));
    cleanup(dir);
  });

  // The bug this pins: `observe` proposed 3x the median. On a spiky series that
  // lands *below* the p90, i.e. a bound the claim is guaranteed to violate.
  const spike = [6000, 9000, 9000, 9000, 9000, 9000, 9000, 9000, 12000, 25000, 47000];

  const setBound = (dir, ms) => {
    const p = path.join(dir, '.manual', 'claims', 'tests.demo.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/max_ms: \d+/, `max_ms: ${ms}`));
  };

  test('a tighten proposal clears the observed tail, not just the median', () => {
    const dir = tmp('manual-obs-tail-');
    setBound(dir, 120000);
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (const ms of spike) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms });
    const st = seriesStats(state, 'tests.demo');
    const tighten = planProposals(dir, state).find((p) => p.id === 'tests.demo' && p.kind === 'tighten');
    assert.ok(tighten, 'expected a tighten proposal against a loose bound');
    assert.equal(st.p50, 9000);
    assert.equal(tighten.proposed, 52000, 'clears the 47s worst run with 10% headroom');
    assert.ok(tighten.proposed > st.p90, `bound ${tighten.proposed} must clear the p90 ${st.p90}`);
    assert.ok(tighten.proposed < tighten.bound, 'and still be a tightening');
    const written = writeProposals(dir, state, { quiet: true });
    const text = fs.readFileSync(path.join(dir, '.manual', 'inbox', written[0].file), 'utf8');
    assert.match(text, /p50 9000ms, p90 25000ms, worst 47000ms/, 'the candidate states the tail it respected');
    cleanup(dir);
  });

  test('no tighten proposal when the tail does not fit under the bound', () => {
    const dir = tmp('manual-obs-refuse-');
    setBound(dir, 30000);
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (const ms of spike) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms });
    // Median is 9s, well under half of 30s — the old heuristic would "tighten"
    // to 27s, which the 47s run already violates. Refusing is the correct answer.
    const proposals = planProposals(dir, state).filter((p) => p.kind === 'tighten');
    assert.deepEqual(proposals, []);
    cleanup(dir);
  });

  test('a pending candidate whose evidence moved is reported stale, not silently kept', () => {
    const dir = tmp('manual-obs-stale-');
    setBound(dir, 120000);
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (const ms of spike) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms });
    // writeProposals refuses to overwrite a candidate a human may be reviewing…
    assert.equal(writeProposals(dir, state, { quiet: true }).length, 1);
    // …but a candidate whose numbers no longer match must not block a corrected
    // one invisibly. The scenario: an old candidate proposing a bound that the
    // newer, spikier evidence says is too tight.
    const staleFile = path.join(dir, '.manual', 'inbox', '2020-01-01-tighten-tests.demo.md');
    fs.writeFileSync(staleFile, '---\nid: candidate.tighten.tests.demo\nkind: candidate\nproposes:\n  update: tests.demo\n  patch:\n    check.expect.max_ms: 11000\n---\ntoo tight\n');
    const stale = staleProposals(dir, state);
    const mine = stale.find((s) => s.file === '2020-01-01-tighten-tests.demo.md');
    assert.ok(mine, 'the hand-named candidate is found too, not just canonical filenames');
    assert.equal(mine.proposes_in_file, 11000);
    assert.equal(mine.proposes_now, 52000);
    assert.equal(mine.p90, 25000);
    // the demo's own shipped candidate proposes 10s for this claim, which this
    // synthetic evidence also disagrees with — both are reported
    assert.ok(stale.some((s) => s.file === '2026-09-21-tighten-demo-tests.md'));

    // and doctor surfaces them as something needing attention
    const report = doctor(dir, state);
    assert.equal(report.staleCandidates.length, stale.length);
    assert.equal(printDoctor(report), 1);
    cleanup(dir);
  });

  test('proposes relax when the bound itself caused a break', () => {
    const dir = tmp('manual-obsr-');
    const state = new State(dir);
    state.set('tests.demo', { state: 'broken', note: 'max_ms exceeded' });
    state.pushHistory({ id: 'tests.demo', state: 'broken', at: nowIso(), ms: 41200 });
    const proposals = planProposals(dir, state);
    const relax = proposals.find((p) => p.kind === 'relax');
    assert.ok(relax, 'expected a relax proposal');
    assert.equal(relax.proposed, 83000);
    cleanup(dir);
  });

  // A suite that grew slowly never fires the relax path: nothing broke. If the
  // bound only ever moves after a false alarm, the first honest signal anyone
  // gets is a claim that flaps — and a claim that flaps gets ignored.
  const drift = [2000, 2100, 4000, 9000, 12000, 18000, 24000];

  test('raises the bound on a suite that grew slower without ever breaking it', () => {
    const dir = tmp('manual-obs-raise-');
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (const ms of drift) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms });
    const st = seriesStats(state, 'tests.demo');
    const raise = planProposals(dir, state).find((p) => p.id === 'tests.demo' && p.kind === 'raise');
    assert.ok(raise, 'expected a raise proposal while the claim is still fresh');
    assert.equal(st.p50, 9000);
    assert.equal(st.p90, 24000);
    assert.equal(raise.bound, 30000, 'the default bound is what it outgrew');
    assert.equal(raise.proposed, 36000);
    assert.ok(raise.proposed > raise.bound, 'a raise must actually raise');
    assert.ok(raise.diagnosis.some((d) => d.kind === 'trend-up'), 'and say the runs are trending slower');
    const written = writeProposals(dir, state, { quiet: true });
    assert.equal(written.length, 1);
    const text = fs.readFileSync(path.join(dir, '.manual', 'inbox', written[0].file), 'utf8');
    assert.match(text, /p50 9000ms, p90 24000ms, worst 24000ms over 7 samples/);
    assert.match(text, /before a legitimate run fails/);
    cleanup(dir);
  });

  test('no raise while the tail still fits comfortably under the bound', () => {
    const dir = tmp('manual-obs-raise-refuse-');
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (let i = 0; i < 6; i++) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms: 900 + i * 20 });
    assert.deepEqual(planProposals(dir, state).filter((p) => p.kind === 'raise'), []);
    cleanup(dir);
  });

  test('a proposal rewrites the recorded measurement from history, not from the init probe', () => {
    const dir = tmp('manual-obs-measured-');
    // The single number init took when the claim was written: 2.0s for a suite
    // that now costs 9s at the median and 24s at the tail.
    const claim = path.join(dir, '.manual', 'claims', 'tests.demo.md');
    fs.writeFileSync(claim, fs.readFileSync(claim, 'utf8').replace(/^lifecycle:/m, 'observation:\n  at: 2026-01-01T00:00:00Z\n  measured_ms: 2000\nlifecycle:'));
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (const ms of drift) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms });
    const written = writeProposals(dir, state, { quiet: true });
    acceptInbox(dir, written[0].file, { quiet: true });
    const after = loadManual(dir).claims.find((cl) => cl.fm.id === 'tests.demo');
    assert.equal(after.fm.check.expect.max_ms, 36000, 'the bound follows the history');
    assert.equal(after.fm.observation.measured_ms, 9000, 'and so does the published measurement');
    assert.equal(after.fm.observation.samples, 7);
    assert.equal(after.fm.observation.measured_from, 'verify history');
    // The rest of the frontmatter survives the patch.
    assert.equal(after.fm.observation.at, '2026-01-01T00:00:00Z');
    assert.equal(after.fm.provenance.author, 'mira');
    cleanup(dir);
  });
});

describe('doctor', () => {
  test('healthy after verify, suspect when evidence changes', async () => {
    const dir = tmp('manual-doc-');
    const state = new State(dir);
    let res = doctor(dir, state);
    assert.ok(res.rows.every((r) => r.issues.includes('never verified — run `manual verify`')));

    await verify(dir, { state, force: true });
    res = doctor(dir, state);
    assert.equal(res.suspect.length, 0);

    // mutate evidence behind the manual's back
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.description = 'changed';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    res = doctor(dir, state);
    assert.ok(res.suspect.some((r) => r.issues.some((i) => /evidence changed/.test(i))));
    cleanup(dir);
  });
});

describe('inbox patch mode', () => {
  test('accepting a patch candidate edits the target claim frontmatter in place', () => {
    const dir = tmp('manual-patch-');
    fs.writeFileSync(
      path.join(dir, '.manual', 'inbox', '2026-09-21-patch-tests.md'),
      `---
schema: manual/v1
id: candidate.tighten-tests
kind: candidate
proposes:
  update: tests.demo
  patch:
    check.expect.max_ms: 10000
observation:
  at: 2026-09-21T15:00:00Z
  by: agent:manual-cli
  measured_ms: 210
review:
  needed: human-approve
---
p50 was 210ms; tighten to 10s.
`,
    );
    const dest = acceptInbox(dir, '2026-09-21-patch-tests.md');
    assert.equal(path.basename(dest), 'tests.demo.md');
    const text = fs.readFileSync(dest, 'utf8');
    assert.match(text, /max_ms: 10000/);
    assert.match(text, /The test suite runs with plain `node --test`/); // body preserved
    assert.doesNotMatch(text, /candidate\.tighten-tests/); // no clobbering
    cleanup(dir);
  });

  test('listInbox handles a missing inbox dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-noInbox-'));
    const files = listInbox(dir); // should not throw
    assert.deepEqual(files, []);
    cleanup(dir);
  });
});

describe('init', () => {
  test('dry run discovers without writing', () => {
    const dir = tmp('manual-initd-');
    const res = init(dir, { dryRun: true });
    assert.equal(res.findings >= 2, true); // ESM fact + test suite from scripts.test
    assert.equal(res.created.length >= 2, true);
    assert.equal(fs.existsSync(path.join(dir, '.manual', 'inbox', 'init-tooling.modules.md')), false);
    cleanup(dir);
  });

  test('init scaffolds .manual, manual.yaml, gitignore and inbox candidates', () => {
    const dir = tmp('manual-init-');
    const res = init(dir, { dryRun: false });
    assert.equal(fs.existsSync(path.join(dir, '.manual', 'manual.yaml')), true);
    assert.equal(fs.existsSync(path.join(dir, '.manual', 'inbox', 'init-tooling.modules.md')), true);
    assert.equal(fs.existsSync(path.join(dir, '.manual', 'inbox', 'init-tests.suite.md')), true);
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(gi, /\.manual\/state\.json/);
    assert.ok(res.created.length >= 2);
    cleanup(dir);
  });

  test('demo repo itself loads clean and claims match filenames', () => {
    const { claims, errors } = loadManual(ROOT);
    assert.deepEqual(errors, []);
    for (const c of claims) {
      assert.equal(path.basename(c.file), `${c.fm.id}.md`);
    }
  });
});

describe('observe across machines (the committed ledger)', () => {
  // The ledger is the portable half of trust: it is committed, so another
  // machine's verify outcomes — including CI's, which are usually the slowest —
  // are visible to every checkout. A bound computed only from state.json
  // describes the fastest machine in the room, and CI is where a calibrated
  // bound meets its first flake.
  const seed = (dir, ms, machine, extra = {}) => {
    fs.appendFileSync(
      path.join(dir, '.manual', 'ledger.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), machine, id: 'tests.demo', state: 'fresh', ms, ...extra })}\n`,
    );
  };

  test('a slow CI machine stops a tighten the laptop would have proposed', () => {
    const dir = tmp('manual-obs-ci-tighten-');
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (let i = 0; i < 6; i++) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms: 200 + i * 5 });
    // The runner that flaked: its p90 is far above what the local tail supports.
    for (const ms of [40000, 42000, 44000, 46000, 48000]) seed(dir, ms, 'ci-runner-7');
    const tighten = planProposals(dir, state).find((p) => p.id === 'tests.demo' && p.kind === 'tighten');
    assert.equal(tighten, undefined, `expected no tighten when the ledger's slowest machine would flake`);
    cleanup(dir);
  });

  test('the slowest machine shapes the raise, and the candidate names it', () => {
    const dir = tmp('manual-obs-ci-raise-');
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (const ms of [2000, 2100, 4000, 9000, 12000, 18000, 24000]) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms });
    for (const ms of [30000, 34000, 38000, 42000, 46000]) seed(dir, ms, 'ci-runner-7');
    const raise = planProposals(dir, state).find((p) => p.id === 'tests.demo' && p.kind === 'raise');
    assert.ok(raise, 'expected a raise');
    assert.equal(raise.proposed, 51000, 'the bound clears the slowest machine, not just the laptop');
    const written = writeProposals(dir, state, { quiet: true });
    const text = fs.readFileSync(path.join(dir, '.manual', 'inbox', written[0].file), 'utf8');
    assert.match(text, /ci-runner-7's 90th percentile is 46000ms against \d+ms everywhere else/);
    assert.match(text, /plus the committed ledger across machines/);
    cleanup(dir);
  });

  test('a bounded ledger entry — a run stopped at the bound — counts toward the raise', () => {
    const dir = tmp('manual-obs-ci-bounded-');
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (let i = 0; i < 6; i++) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms: 900 + i * 20 });
    // CI stopped at the bound: no duration, but it is the strongest raise signal
    // there is. A bound the tool cannot keep on the machines that run it is a
    // bound that is already wrong.
    seed(dir, null, 'ci-runner-7', { state: 'blocked', note: 'no exit within 30s' });
    const raise = planProposals(dir, state).find((p) => p.id === 'tests.demo' && p.kind === 'raise');
    assert.ok(raise, 'a timed-out CI run must raise the bound even without a duration');
    assert.equal(raise.proposed, 36000, 'proposed from the local tail, which fits under the bound CI could not finish inside');
    assert.equal(raise.boundedRuns, 1);
    const written = writeProposals(dir, state, { quiet: true });
    const text = fs.readFileSync(path.join(dir, '.manual', 'inbox', written[0].file), 'utf8');
    assert.match(text, /1 ledger entry carries no duration/);
    assert.match(text, /counts toward the raise/);
    cleanup(dir);
  });

  test('a single-machine manual reads exactly as before', () => {
    const dir = tmp('manual-obs-solo-');
    const state = new State(dir);
    state.set('tests.demo', { state: 'fresh', note: 'ok' });
    for (const ms of [2000, 2100, 4000, 9000, 12000, 18000, 24000]) state.pushHistory({ id: 'tests.demo', state: 'fresh', at: nowIso(), ms });
    const raise = planProposals(dir, state).find((p) => p.id === 'tests.demo' && p.kind === 'raise');
    assert.ok(raise);
    assert.equal(raise.machineShare, null);
    assert.equal(raise.boundedRuns, 0);
    const written = writeProposals(dir, state, { quiet: true });
    const text = fs.readFileSync(path.join(dir, '.manual', 'inbox', written[0].file), 'utf8');
    assert.doesNotMatch(text, /Across machines/);
    assert.doesNotMatch(text, /committed ledger/);
    cleanup(dir);
  });
});
