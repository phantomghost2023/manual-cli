import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml, parseFlow } from '../src/yaml.js';
import { matches, expandFiles } from '../src/glob.js';
import { loadManual } from '../src/claims.js';
import { interpret } from '../src/runner.js';
import { verify, printVerifyReport, checkTimeoutMs } from '../src/verify.js';
import { brief } from '../src/brief.js';
import { State } from '../src/state.js';
import { listInbox, acceptInbox } from '../src/inbox.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');

describe('yaml parser', () => {
  test('parses maps, nested maps, arrays and flow values', () => {
    const y = parseYaml(`
schema: manual/v1
id: tests.demo
priority: high
when: true
count: 3
applies_to:
  - "src/**"
  - vitest.config.ts
depends_on:
  - id: tooling.node-esm
    required: true
expect:
  exit: 0
  max_ms: 30000
`);
    assert.equal(y.schema, 'manual/v1');
    assert.equal(y.when, true);
    assert.equal(y.count, 3);
    assert.deepEqual(y.applies_to, ['src/**', 'vitest.config.ts']);
    assert.deepEqual(y.depends_on, [{ id: 'tooling.node-esm', required: true }]);
    assert.deepEqual(y.expect, { exit: 0, max_ms: 30000 });
  });

  test('parses block scalars with chomping', () => {
    const y = parseYaml(`statement: >-
  one
  two
check:
  run: |
    line a
    line b
`);
    assert.equal(y.statement, 'one\ntwo');
    assert.equal(y.check.run, 'line a\nline b\n'); // YAML clip keeps one trailing newline
  });

  test('parses nested flow collections', () => {
    assert.deepEqual(parseFlow('{a: 1, b: [x, y]}'), { a: 1, b: ['x', 'y'] });
  });

  test('keeps backslashes literal in single quotes (regex-friendly)', () => {
    const y = parseYaml(`pat: 'no tests found|passed \\(0\\)'`);
    assert.equal(y.pat, 'no tests found|passed \\(0\\)');
  });
});

describe('glob', () => {
  test('matches deep and single-star patterns', () => {
    assert.equal(matches('src/**', 'src/db/q.ts'), true);
    assert.equal(matches('src/**/*.test.js', 'src/a/b/c.test.js'), true);
    assert.equal(matches('src/*', 'src/a/b.ts'), false);
    assert.equal(matches('**', 'anything/deep/file.ts'), true);
  });

  test('expands braces', () => {
    assert.equal(matches('{a,b}.js', 'a.js'), true);
    assert.equal(matches('{a,b}.js', 'c.js'), false);
  });

  test('expands files under a root', () => {
    const files = expandFiles(ROOT, 'src/**/*.test.js');
    assert.ok(files.includes('src/math.test.js'));
  });
});

describe('claims loader', () => {
  test('loads the demo manual without errors', () => {
    const { claims, errors } = loadManual(ROOT);
    assert.deepEqual(errors, []);
    assert.equal(claims.length, 5);
    const ids = claims.map((c) => c.fm.id);
    assert.ok(ids.includes('traps.reporter-pipe'));
  });

  test('rejects filename != <id>.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-bad-'));
    fs.mkdirSync(path.join(dir, '.manual', 'claims'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.manual', 'claims', 'wrong-name.md'), `---
schema: manual/v1
id: some.claim
kind: fact
statement: x
---
some claim body here
`);
    const { errors } = loadManual(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /filename must be/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rejects unknown kinds loudly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-bad-'));
    fs.mkdirSync(path.join(dir, '.manual', 'claims'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.manual', 'claims', 'weird.kind.md'), `---
schema: manual/v1
id: weird.kind
kind: opinion
statement: x
---
some claim body here
`);
    const { errors } = loadManual(dir);
    assert.match(errors[0], /unknown kind/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('runner interpretation matrix', () => {
  const mk = (kind) => ({ fm: { kind, id: 'x.y' } });

  test('command broken means broken', () => {
    assert.equal(interpret(mk('command'), { ok: false, exit: 1 }).state, 'broken');
  });

  test('trap broken means the gotcha no longer reproduces', () => {
    const r = interpret(mk('trap'), { ok: false, exit: 0 });
    assert.equal(r.state, 'broken');
    assert.match(r.note, /no longer reproduces/);
  });

  test('trap fresh while gotcha reproduces', () => {
    assert.equal(interpret(mk('trap'), { ok: true, exit: 1, ms: 12 }).state, 'fresh');
  });
});

describe('verify e2e on demo repo', () => {
  test('all demo claims verify fresh in order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-demo-'));
    // copy demo into a temp dir so state.json stays out of the real demo tree
    fs.cpSync(ROOT, dir, { recursive: true });
    const state = new State(dir);
    const res = await verify(dir, { state, force: true });
    assert.deepEqual(res.errors, []);
    const byId = Object.fromEntries(res.results.map((r) => [r.claim.fm.id, r.stamp]));
    assert.equal(byId['tooling.node-esm'].state, 'fresh');
    assert.equal(byId['tests.demo'].state, 'fresh');
    assert.equal(byId['traps.reporter-pipe'].state, 'fresh');
    assert.equal(byId['policy.tests-registered'].state, 'fresh');
    assert.equal(byId['tests.demo'].tier, 'silver');
    // second run without force: all skipped via digests
    const res2 = await verify(dir, { state, force: false });
    assert.ok(res2.results.every((r) => r.skipped));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('broken dependency blocks dependents', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-dep-'));
    fs.cpSync(ROOT, dir, { recursive: true });
    // sabotage the dep: make package.json type something else
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.type = 'commonjs';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    const state = new State(dir);
    const res = await verify(dir, { state, force: true });
    const byId = Object.fromEntries(res.results.map((r) => [r.claim.fm.id, r.stamp]));
    assert.equal(byId['tooling.node-esm'].state, 'broken');
    assert.equal(byId['tests.demo'].state, 'blocked');
    // tier demotion applied to the broken fact
    assert.equal(byId['tooling.node-esm'].tier, 'bronze');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('brief', () => {
  test('always-claims and relevant claims pack under budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-brief-'));
    fs.cpSync(ROOT, dir, { recursive: true });
    const state = new State(dir);
    const out = brief(dir, ['src/db/queries.ts'], { state, budget: 600, quiet: true });
    assert.ok(out.lines.length >= 2);
    assert.ok(out.used <= 600);
    const ids = out.lines.join('\n');
    assert.match(ids, /tooling\.node-esm/); // when: true
    assert.match(ids, /tests\.demo|traps\.reporter-pipe|policy\.tests-registered/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('inbox', () => {
  test('lists and accepts a candidate into claims/<id>.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-inbox-'));
    fs.cpSync(ROOT, dir, { recursive: true });
    const files = listInbox(dir);
    assert.equal(files.length, 1);
    const dest = acceptInbox(dir, files[0]);
    assert.equal(path.basename(dest), 'tests.demo.md'); // proposes.update target
    assert.ok(fs.existsSync(dest));
    assert.ok(!fs.existsSync(path.join(dir, '.manual', 'inbox', files[0])));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('report', () => {
  test('prints a report and exits 1 when something is broken', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-rep-'));
    fs.cpSync(ROOT, dir, { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.type = 'commonjs';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    const state = new State(dir);
    const res = await verify(dir, { state, force: true });
    const code = printVerifyReport(res);
    assert.equal(code, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test("a claim's own bound is how long verify waits for it", () => {
  // init calibrates max_ms from a measured run; killing at the config default
  // first would make every calibrated bound decorative (runCheck prefers an
  // explicit timeoutMs over the claim's). The config default is what claims
  // with no declared bound get.
  const cfg = { verify: { default_timeout_s: 120 } };
  assert.equal(checkTimeoutMs({ fm: { check: { expect: { max_ms: 879000 } } } }, cfg), 879000, 'the calibrated bound wins');
  assert.equal(checkTimeoutMs({ fm: { check: { expect: {} } } }, cfg), 120000, 'config default for the unbound');
  assert.equal(checkTimeoutMs({ fm: {} }, cfg), 120000);
  assert.equal(checkTimeoutMs({ fm: {} }, {}), 60000, 'no config at all still stops a runaway at 60s');
});
