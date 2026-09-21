import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'bin', 'manual.js');
const demo = path.join(here, '..', 'demo');

const tmpCopy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-cli-json-'));
  fs.cpSync(demo, dir, { recursive: true });
  fs.rmSync(path.join(dir, '.manual', 'state.json'), { force: true });
  return dir;
};

// `verify --json` is the mode CI and agents use. It used to return before
// state.save(), so it printed fresh states and discarded them: stamps, trust
// history and the flywheel's measurements all stayed stale on disk while the
// output claimed success. Nothing else could see the difference, which is
// exactly why it needs a test.
test('verify --json writes the stamps and history it reports', () => {
  const root = tmpCopy();
  const out = execFileSync(process.execPath, [cli, 'verify', '--root', root, '--force', '--json'], {
    encoding: 'utf8',
    timeout: 240000,
  });
  const parsed = JSON.parse(out);
  assert.ok(parsed.results.length > 0);
  assert.ok(parsed.results.every((r) => r.state === 'fresh'));

  const statePath = path.join(root, '.manual', 'state.json');
  assert.ok(fs.existsSync(statePath), 'verify --json must write state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const r of parsed.results) {
    assert.ok(state.stamps[r.id], `stamp for ${r.id} reported but not persisted`);
    assert.equal(state.stamps[r.id].state, r.state);
  }
  const history = state.history.filter((h) => h.id === 'tests.demo');
  assert.ok(history.length > 0, 'history must be persisted too');
  assert.ok(typeof history[history.length - 1].ms === 'number');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a persisted run keeps the per-test timing it measured', () => {
  const root = tmpCopy();
  execFileSync(process.execPath, [cli, 'verify', '--root', root, '--force', '--json'], {
    encoding: 'utf8',
    timeout: 240000,
  });
  const state = JSON.parse(fs.readFileSync(path.join(root, '.manual', 'state.json'), 'utf8'));
  const last = state.history.filter((h) => h.id === 'tests.demo').pop();
  // demo/src/math.test.js has two tests, so the suite must be attributable.
  assert.ok(last.slowest_test, `expected a slowest test, got ${JSON.stringify(last)}`);
  assert.equal(last.test_count, 2);
  assert.ok(last.slowest_ms <= last.test_total_ms);
  fs.rmSync(root, { recursive: true, force: true });
});
