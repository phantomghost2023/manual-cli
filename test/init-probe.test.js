import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, probeCandidates } from '../src/init.js';
import { parseYaml } from '../src/yaml.js';
import { splitFrontmatter } from '../src/md.js';

function fixture(pkg, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-probe-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.manual/state.json\n');
  for (const [rel, content] of Object.entries(extra)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const readCandidate = (dir, file) => {
  const text = fs.readFileSync(path.join(dir, '.manual', 'inbox', file), 'utf8');
  const { fm, body } = splitFrontmatter(text);
  return { fm: parseYaml(fm), body };
};

test('a discovered check that passes is proposed with that evidence', async () => {
  const dir = fixture({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } }, {
    'test/a.test.js': 'import { test } from "node:test"; test("ok", () => {});\n',
  });
  try {
    init(dir, {});
    const probes = await probeCandidates(dir, { quiet: true });
    assert.equal(probes.length, 1);
    assert.equal(probes[0].state, 'fresh');
    const { fm, body } = readCandidate(dir, 'init-tests.suite.md');
    assert.equal(fm.observation.probe_state, 'fresh');
    assert.match(body, /Probed before proposing: the check passes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a discovered check that cannot run is marked broken, not proposed as true', async () => {
  // The real case: a repo whose test runner is not installed.
  const dir = fixture({ name: 'p', version: '1.0.0', scripts: { test: 'mocha test/' } }, {
    'test/a.js': 'describe("x", () => {});\n',
  });
  try {
    init(dir, {});
    const probes = await probeCandidates(dir, { quiet: true });
    assert.equal(probes[0].state, 'broken');
    const { fm, body } = readCandidate(dir, 'init-tests.suite.md');
    // the statement names the real runner rather than claiming "npm test"
    assert.match(fm.statement, /runs with `mocha`/);
    assert.equal(fm.observation.probe_state, 'broken');
    assert.match(fm.observation.probe_note, /exit|not found|ENOENT/);
    assert.match(body, /does not pass here/);
    assert.match(body, /Do not accept it as-is/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probing is idempotent and skips anything that is not an init candidate', async () => {
  const dir = fixture({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } }, {
    'test/a.test.js': 'import { test } from "node:test"; test("ok", () => {});\n',
  });
  try {
    init(dir, {});
    fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'handwritten.md'), '---\nid: x\nkind: fact\ncheck:\n  expr: "true"\n---\nbody\n');
    await probeCandidates(dir, { quiet: true });
    const second = await probeCandidates(dir, { quiet: true });
    assert.equal(second.length, 1, 'hand-written candidates are not probed');
    assert.equal(second[0].state, 'fresh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no inbox means no probing, and no crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-probe-none-'));
  try {
    assert.deepEqual(await probeCandidates(dir, { quiet: true }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
