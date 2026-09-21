import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTestTimings, verifyOne } from '../src/runner.js';
import { State } from '../src/state.js';

// Real node --test TAP output (captured from node 22 with --test-reporter=tap).
const TAP = `TAP version 13
# Subtest: slow one
ok 1 - slow one
  ---
  duration_ms: 303.2133
  type: 'test'
  ...
# Subtest: fast one
ok 2 - fast one
  ---
  duration_ms: 0.552
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# duration_ms 642.1258
`;

test('node TAP durations are attributed to their test, not to the suite total', () => {
  const t = parseTestTimings(TAP);
  assert.equal(t.count, 2);
  assert.equal(t.slowest.name, 'slow one');
  assert.equal(t.slowest.ms, 303.2133);
  assert.equal(t.total, 304); // 303.2133 + 0.552, rounded
});

test('the suite total line is not misattributed to the last test', () => {
  // "# duration_ms 642.1258" carries no duration for a named test; only the
  // indented per-test lines do. Two tests must not become three.
  assert.equal(parseTestTimings(TAP).count, 2);
});

test('spec-reporter checkmarks are parsed too', () => {
  const spec = `
  suite
    ✔ queries the database (812ms)
    ✓ formats the result (12.5ms)
    ✓ handles empty input (0 ms)
`;
  const t = parseTestTimings(spec);
  assert.equal(t.count, 3);
  assert.equal(t.slowest.name, 'queries the database');
  assert.equal(t.slowest.ms, 812);
});

test('jest-style durations with a space before ms are parsed', () => {
  const t = parseTestTimings('  ✓ renders the list (1234 ms)\n');
  assert.equal(t.slowest.ms, 1234);
});

test('output without timings yields null rather than a guess', () => {
  assert.equal(parseTestTimings('ok 1 - something\n'), null);
  assert.equal(parseTestTimings(''), null);
  assert.equal(parseTestTimings(null), null);
});

test('an indented duration with no subtest name above it is ignored', () => {
  assert.equal(parseTestTimings('  duration_ms: 500\n'), null);
});

const claimFile = (dir) => {
  fs.mkdirSync(path.join(dir, '.manual', 'claims'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.manual', 'claims', 'tests.mini.md'),
    `---
schema: manual/v1
id: tests.mini
kind: command
statement: The suite runs with the TAP reporter.
priority: medium
evidence:
  files:
    - mini.test.mjs
check:
  run: node --test --test-reporter=tap mini.test.mjs
  expect:
    exit: 0
    max_ms: 30000
verify: on_change
provenance:
  author: test
  origin: authored
  evidence: "written by the timings test"
lifecycle: accepted
---
The suite runs with the TAP reporter.
`
  );
};

test('a real check run records which test dominated its runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-timings-'));
  fs.writeFileSync(
    path.join(root, 'mini.test.mjs'),
    `import test from 'node:test';
import assert from 'node:assert';
test('slow one', async () => { await new Promise((r) => setTimeout(r, 250)); assert.ok(true); });
test('fast one', () => assert.ok(true));
`
  );
  claimFile(root);
  const state = new State(root);
  // runCheck reads check.run/check.expect off the claim, and the timeout off
  // fm.check.expect.max_ms — a hand-built claim must carry both.
  const claim = {
    check: { run: 'node --test --test-reporter=tap mini.test.mjs', expect: { exit: 0, max_ms: 30000 } },
    fm: { id: 'tests.mini', kind: 'command', check: { expect: { exit: 0, max_ms: 30000 } }, provenance: {} },
    digest: 'sha256:test',
    fileCount: 1,
  };
  const r = await verifyOne(claim, root, state, {});
  assert.equal(r.stamp.state, 'fresh');

  const entry = state.history(5).find((h) => h.id === 'tests.mini');
  assert.equal(entry.slowest_test, 'slow one');
  assert.ok(entry.slowest_ms >= 200, `expected the slow test to be measured, got ${entry.slowest_ms}`);
  assert.equal(entry.test_count, 2);
  // The dominant test is most of the suite, which is exactly what observe needs
  // to be able to say out loud.
  assert.ok(entry.slowest_ms / entry.test_total_ms > 0.8);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a check with no per-test output records no timing fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-notimings-'));
  fs.mkdirSync(path.join(root, '.manual', 'claims'), { recursive: true });
  const state = new State(root);
  const claim = {
    check: { run: 'node -e "console.log(1)"', expect: { exit: 0 } },
    fm: { id: 'tooling.echo', kind: 'command', check: { expect: { exit: 0 } }, provenance: {} },
    digest: 'sha256:test2',
    fileCount: 0,
  };
  await verifyOne(claim, root, state, {});
  const entry = state.history(5).find((h) => h.id === 'tooling.echo');
  assert.equal('slowest_test' in entry, false);
  assert.equal('slowest_ms' in entry, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('history marks whether a run followed a change to the evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-digest-'));
  fs.mkdirSync(path.join(root, '.manual', 'claims'), { recursive: true });
  const state = new State(root);
  const base = {
    check: { run: 'node -e "0"', expect: { exit: 0 } },
    fm: { id: 'tooling.echo', kind: 'command', check: { expect: { exit: 0 } }, provenance: {} },
    digest: 'sha256:aaa',
    fileCount: 0,
  };
  await verifyOne(base, root, state, {});
  await verifyOne(base, root, state, {}); // same digest → warm
  await verifyOne({ ...base, digest: 'sha256:bbb' }, root, state, {}); // changed → cold
  const runs = state.history(10).filter((h) => h.id === 'tooling.echo');
  assert.deepEqual(runs.map((h) => h.digest_changed), [0, 0, 1]);
  fs.rmSync(root, { recursive: true, force: true });
});
