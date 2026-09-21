import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectForDiff } from '../src/diff.js';
import { enforce } from '../src/enforce.js';
import { planProposals, writeProposals } from '../src/observe.js';
import { doctor } from '../src/doctor.js';
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
