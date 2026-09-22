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
  // The real case: a repo whose test runner is not installed (found on
  // express, where scripts.test is `mocha --require …`).
  const dir = fixture({ name: 'p', version: '1.0.0', scripts: { test: 'mocha test/' } }, {
    'test/a.js': 'describe("x", () => {});\n',
  });
  try {
    init(dir, {});
    const probes = await probeCandidates(dir, { quiet: true });
    assert.equal(probes[0].state, 'broken');
    const { fm, body } = readCandidate(dir, 'init-tests.suite.md');
    // `mocha` is a local binary: node_modules/.bin is only on PATH under
    // `npm test`, so the claim documents — and runs — the repo's own entry
    // point, and names the runner it dispatches to.
    assert.equal(fm.check.run, 'npm test');
    assert.match(fm.statement, /runs with `npm test` \(mocha\)/);
    assert.match(fm.observation.probe_state, /broken/);
    assert.match(fm.observation.probe_note, /exit|not found|ENOENT/);
    assert.match(body, /does not pass here/);
    assert.match(body, /Do not accept it as-is/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a script that starts with a system binary is run as written', async () => {
  const dir = fixture({ name: 'p', version: '1.0.0', scripts: { test: 'node --test test/' } }, {
    'test/a.test.js': 'import { test } from "node:test"; test("ok", () => {});\n',
  });
  try {
    init(dir, {});
    const { fm } = readCandidate(dir, 'init-tests.suite.md');
    assert.equal(fm.check.run, 'node --test test/', 'no need to go through npm for this one');
    assert.match(fm.statement, /runs with `node`/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a workspaces monorepo discovers its test suite even without a root src/ or test/', async () => {
  // Found on a real repo (remix-run/react-router v5): the tests live under
  // packages/*/src and packages/*/test, the root has neither directory, and
  // discovery proposed nothing on a repo with a real test suite.
  const dir = fixture({
    name: 'p',
    version: '1.0.0',
    workspaces: { packages: ['packages/*'] },
    scripts: { test: 'node --test' },
  }, {
    'packages/a/src/index.js': 'export const x = 1;\n',
    'packages/a/test/a.test.js': 'import { test } from "node:test"; test("ok", () => {});\n',
  });
  try {
    init(dir, {});
    const { fm } = readCandidate(dir, 'init-tests.suite.md');
    assert.equal(fm.id, 'tests.suite');
    assert.equal(fm.check.run, 'node --test');
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
