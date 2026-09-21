import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { affectedClaims, watchOnce } from '../src/watch.js';
import { State } from '../src/state.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');

const tmp = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  fs.cpSync(ROOT, dir, { recursive: true });
  fs.rmSync(path.join(dir, '.manual', 'state.json'), { force: true });
  return dir;
};
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

describe('watch selection', () => {
  test('src change pulls evidence matches plus dependency closure', () => {
    const ids = affectedClaims(ROOT, ['src/math.js']).map((c) => c.fm.id);
    assert.ok(ids.includes('tests.demo')); // evidence src/**
    assert.ok(ids.includes('tooling.node-esm')); // tests.demo depends on it
    assert.ok(ids.includes('policy.tests-registered')); // applies_to src/**
  });

  test('unrelated file selects universal-glob claims plus their dependents', () => {
    const ids = affectedClaims(ROOT, ['README.md']).map((c) => c.fm.id);
    assert.ok(ids.includes('tooling.node-esm')); // applies_to ["**"]
    // tests.demo depends on tooling.node-esm: a change that could flip the
    // dependency's stamp pulls dependents into the re-check set (by design).
    assert.ok(ids.includes('tests.demo'));
  });

  test('no matches yields nothing', () => {
    const dir = tmp('manual-w0-');
    // strip the universal claim's glob to prove emptiness is possible
    fs.rmSync(path.join(dir, '.manual', 'claims', 'tooling.node-esm.md'));
    const ids = affectedClaims(dir, ['docs/other.md']).map((c) => c.fm.id);
    assert.deepEqual(ids, []);
    cleanup(dir);
  });
});

describe('watchOnce', () => {
  test('re-verifies affected claims and stamps the result', async () => {
    const dir = tmp('manual-w1-');
    const state = new State(dir);
    const results = await watchOnce(dir, ['package.json'], state, { quiet: true });
    const byId = Object.fromEntries(results.map((s) => [s.id, s.state]));
    assert.ok('tooling.node-esm' in byId);
    assert.equal(byId['tooling.node-esm'], 'fresh');
    cleanup(dir);
  });

  test('detects breakage introduced by the change', async () => {
    const dir = tmp('manual-w2-');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.type = 'commonjs';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    const state = new State(dir);
    const results = await watchOnce(dir, ['package.json'], state, { quiet: true });
    const byId = Object.fromEntries(results.map((s) => [s.id, s.state]));
    assert.equal(byId['tooling.node-esm'], 'broken');
    cleanup(dir);
  });
});
