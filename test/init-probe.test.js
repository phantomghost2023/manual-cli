import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, probeCandidates, calibratedMaxMs, detect, nonNodeSuites, goInstall } from '../src/init.js';
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

test('a partial node_modules (present but not matching the lockfile) still wires the prerequisite', async () => {
  // The real case (npm/cli): the checkout ships a partial node_modules in git
  // — no dev deps, no .bin — so the old presence gate wired no prerequisite and
  // the proposed check ran against an install that was never made. The
  // lockfile builtin gets the last word when the tree exists.
  const LOCK = JSON.stringify({
    name: 'p',
    lockfileVersion: 3,
    packages: {
      '': { name: 'p', version: '1.0.0', dependencies: { tap: '^16.0.0' } },
      'node_modules/tap': { version: '16.3.10', dev: true },
      'node_modules/left-pad': { version: '1.3.0' },
    },
  });
  const dir = fixture({ name: 'p', version: '1.0.0', scripts: { test: 'tap test/' }, devDependencies: { tap: '^16.0.0' } }, {
    'package-lock.json': LOCK,
    'test/a.js': 'require("tap");\n',
    'node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.3.0"}',
  });
  try {
    init(dir, {});
    const { fm } = readCandidate(dir, 'init-tests.suite.md');
    assert.equal(fm.check.requires, 'node', 'partial install must require the prerequisite');
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

test('a pnpm-workspace monorepo discovers its test suite too', async () => {
  // Found on a real repo (vuejs/core): pnpm monorepos declare packages in
  // pnpm-workspace.yaml, not package.json, so the package.json-only check
  // still proposed nothing on one of the largest test suites in the wild.
  const dir = fixture({
    name: 'p',
    version: '1.0.0',
    packageManager: 'pnpm@9.0.0',
    scripts: { test: 'node --test' },
  }, {
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'packages/a/src/index.js': 'export const x = 1;\n',
    'packages/a/test/a.test.js': 'import { test } from "node:test"; test("ok", () => {});\n',
  });
  try {
    init(dir, {});
    const { fm } = readCandidate(dir, 'init-tests.suite.md');
    assert.equal(fm.id, 'tests.suite');
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

test('calibratedMaxMs: a measured suite earns a bound that can hold it', () => {
  // The formula init writes: today's default as an unbreakable floor (init is
  // never tighter than it used to be), otherwise the measured runtime times
  // MAX_MS_HEADROOM, rounded up to whole seconds. vuejs/core's suite (~293s)
  // is the case this exists for — against the old 120s default it could only
  // ever stamp blocked.
  assert.equal(calibratedMaxMs(3000), 120000);
  assert.equal(calibratedMaxMs(40000), 120000, '40s × 3 lands exactly on the floor');
  assert.equal(calibratedMaxMs(45000), 135000, 'just over: headroom applies');
  assert.equal(calibratedMaxMs(293000), 879000, "vuejs/core's real ~293s suite");
  assert.equal(calibratedMaxMs(0), 120000);
  assert.equal(calibratedMaxMs(NaN), 120000);
});

test('discovery writes no bound; the probe measures one and writes it', async () => {
  // The suite deliberately takes ~1.5s so there is a duration to measure. It
  // still earns the floor (1.5s × 3 < 120s): fast suites keep today's default
  // and observe tightens later from accumulated evidence. What matters is that
  // the bound now has provenance — measured_ms — instead of being invented.
  const dir = fixture({ name: 'p', version: '1.0.0', scripts: { test: 'node -e "setTimeout(() => {}, 1500)"' } }, {
    'test/a.test.js': 'import { test } from "node:test"; test("ok", () => {});\n',
  });
  try {
    init(dir, {});
    const before = readCandidate(dir, 'init-tests.suite.md');
    assert.equal(before.fm.check.expect.max_ms, undefined, 'discovery has not measured anything yet');

    const probes = await probeCandidates(dir, { quiet: true });
    assert.equal(probes[0].state, 'fresh');
    const after = readCandidate(dir, 'init-tests.suite.md');
    assert.equal(after.fm.check.expect.max_ms, 120000, 'the floor, now evidenced');
    assert.equal(after.fm.observation.max_ms, 120000);
    assert.equal(typeof after.fm.observation.measured_ms, 'number');
    assert.ok(after.fm.observation.measured_ms >= 1000 && after.fm.observation.measured_ms < 60000, `measured the 1.5s suite, got ${after.fm.observation.measured_ms}`);
    assert.match(after.body, /bound: max_ms 120000/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a probe stopped at its declared bound is blocked, never broken', async () => {
  // Doctrine made executable: a check killed by a time bound never produced a
  // verdict — verify stamps `blocked` (v0.11.2) and the probe now agrees. A
  // hand-written candidate carries its own declared bound, which is what the
  // probe kills at: the claim is measured against itself, not a default.
  const dir = fixture({ name: 'p', version: '1.0.0' });
  fs.mkdirSync(path.join(dir, '.manual', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'init-slow.md'), [
    '---',
    'schema: manual/v1',
    'id: slow.thing',
    'kind: command',
    'statement: A deliberately slow check.',
    'priority: normal',
    'check:',
    '  run: node -e "setTimeout(() => {}, 10000)"',
    '  expect:',
    '    exit: 0',
    '    max_ms: 2000',
    '---',
    '',
    'body',
    '',
  ].join('\n'));
  try {
    const probes = await probeCandidates(dir, { quiet: true });
    assert.equal(probes[0].state, 'blocked', 'a killed check is untested, not false');
    assert.match(probes[0].note, /stopped at its 2s bound/);
    const { fm, body } = readCandidate(dir, 'init-slow.md');
    assert.equal(fm.check.expect.max_ms, 2000, 'a declared bound is not re-measured');
    assert.equal(fm.observation.probe_state, 'blocked');
    assert.match(body, /never exited within 2s bound/);
    assert.match(body, /raise `check\.expect\.max_ms`/);
  } finally {
    // The killed child releases its hold on the temp dir asynchronously on
    // Windows; retry briefly instead of failing the test on cleanup.
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
});

// ---------------------------------------------------------------------------

// Discovery used to be a package.json reader with a side door for Makefiles,
// migrations and CODEOWNERS. A Go or Python checkout has none of those keys,
// so the tool that ships verifiers for eight ecosystems proposed not one claim
// about seven of them — found by running the wild canary against spf13/cobra,
// where `manual init` printed "0 candidate(s)" on a repo with a test suite.
describe('discovery beyond package.json', () => {
  const mkdirp = (dir, rel) => fs.mkdirSync(path.join(dir, rel), { recursive: true });

  test('a Go repo with tests gets a go test claim, and a vendored one gets no install', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-go-'));
    mkdirp(dir, 'internal/x');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.23\n\nrequire github.com/BurntSushi/toml v1.5.0\n');
    fs.writeFileSync(path.join(dir, 'go.sum'), '');
    fs.writeFileSync(path.join(dir, 'internal/x/x_test.go'), 'package x\n');
    try {
      // Vendored: the tree is the install, so no prerequisite exists to wire.
      fs.mkdirSync(path.join(dir, 'vendor/github.com/x'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'vendor/modules.txt'), '');
      const d = detect(dir);
      const ids = d.findings.map((f) => f.id);
      assert.ok(ids.includes('tests.go'), `expected tests.go, got ${ids.join(', ')}`);
      assert.ok(ids.includes('tooling.vendored-go'));
      const goClaim = d.findings.find((f) => f.id === 'tests.go');
      assert.equal(goClaim.check.run, 'go test ./...');
      assert.equal(goClaim.requires, null, 'a vendored checkout needs no prerequisite');
      assert.deepEqual(Object.keys(d.prereqs), [], 'a vendored checkout declares no go install');

      // Unvendored: discovery names `go mod download` as the prerequisite.
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-go-'));
      mkdirp(bare, 'internal/x');
      fs.writeFileSync(path.join(bare, 'go.mod'), 'module example.com/demo\n\ngo 1.23\n\nrequire github.com/BurntSushi/toml v1.5.0\n');
      fs.writeFileSync(path.join(bare, 'go.sum'), '');
      fs.writeFileSync(path.join(bare, 'internal/x/x_test.go'), 'package x\n');
      try {
        const d2 = detect(bare);
        const goClaim2 = d2.findings.find((f) => f.id === 'tests.go');
        assert.equal(goClaim2.requires, 'go', 'the module cache is empty here, so the claim references the prerequisite');
        assert.deepEqual(Object.keys(d2.prereqs), ['go']);
        assert.equal(d2.prereqs.go.run, 'go mod download');
        assert.equal(d2.prereqs.go.verify.builtin, 'gomod');
        // goInstall is the exported half: the plan and the claims must agree.
        assert.deepEqual(goInstall(bare), d2.prereqs.go);
        assert.equal(goInstall(dir), null, 'a vendored checkout needs nothing installed');
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a Go module with no test files proposes no go test claim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-go-'));
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.23\n');
    try {
      // `go test ./...` exits 0 having tested nothing — a claim that cannot be
      // false says nothing. The glob is the evidence bar.
      assert.deepEqual(nonNodeSuites(dir, {}).map((f) => f.id), []);
      fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n');
      // Still nothing: main.go is not a test file.
      assert.deepEqual(nonNodeSuites(dir, {}).map((f) => f.id), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pytest repo gets a python claim, and the lockfile picks the install', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-py-'));
    mkdirp(dir, 'tests');
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\ndependencies = ["pytest>=8"]\n');
    fs.writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n');
    fs.writeFileSync(path.join(dir, 'tests/test_a.py'), 'def test_ok(): pass\n');
    try {
      const d = detect(dir);
      const py = d.findings.find((f) => f.id === 'tests.python');
      assert.ok(py, `expected tests.python, got ${d.findings.map((f) => f.id).join(', ')}`);
      assert.equal(py.check.run, 'python -m pytest');
      assert.equal(py.requires, 'python', 'the venv is the install the check must run inside');
      assert.equal(d.prereqs.python.run, 'uv sync --frozen', 'the lockfile decides the command, most exact first');
      assert.equal(d.prereqs.python.verify.builtin, 'venv');
      // The check must run the venv's interpreter, not the machine's: the PATH
      // fix in sandbox.localBins is what makes `python -m pytest` mean the venv.
      assert.ok(py.note.includes('virtualenv'), 'the note says what the prerequisite does for the check');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a requirements.txt repo installs into a venv with the platform-correct layout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-py-'));
    mkdirp(dir, 'tests');
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'pytest==8.4.1\n');
    fs.writeFileSync(path.join(dir, 'tests/test_a.py'), 'def test_ok(): pass\n');
    try {
      const d = detect(dir);
      const run = d.prereqs.python.run;
      assert.match(run, /-m venv \.venv/);
      if (process.platform === 'win32') assert.match(run, /\.venv\/Scripts\/pip install/);
      else assert.match(run, /\.venv\/bin\/pip install/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a repo with tests but no pytest declaration proposes no python runner', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-py-'));
    mkdirp(dir, 'tests');
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n');
    fs.writeFileSync(path.join(dir, 'tests/test_a.py'), 'def test_ok(): pass\n');
    try {
      // `python -m pytest` on a repo that never names pytest is a claim whose
      // runner is absent — false about the checkout, not the code.
      assert.deepEqual(nonNodeSuites(dir, {}).map((f) => f.id), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a mixed checkout gets claims from both ecosystems', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-mix-'));
    mkdirp(dir, 'tests');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.23\n');
    fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n');
    fs.writeFileSync(path.join(dir, 'util_test.go'), 'package main\n');
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'pytest==8.4.1\n');
    fs.writeFileSync(path.join(dir, 'tests/test_a.py'), 'def test_ok(): pass\n');
    try {
      const ids = detect(dir).findings.map((f) => f.id);
      assert.ok(ids.includes('tests.go') && ids.includes('tests.python'), `expected both, got ${ids.join(', ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
