import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  ensureSetup,
  normalizeSetup,
  planPrereqs,
  prereqOrder,
  readSetupCache,
  resetSetupMemo,
  resolvePrereqs,
  setupKey,
  setupStatus,
  verifyLockfile,
} from '../src/setup.js';
import { loadConfig, loadManual, parseClaim } from '../src/claims.js';
import { verify, printVerifyReport } from '../src/verify.js';
import { State } from '../src/state.js';
import { detect, init, installCommand, looksLikeMissingDeps, probeCandidates } from '../src/init.js';
import { doctor, printDoctor } from '../src/doctor.js';
import { enforce } from '../src/enforce.js';
import { brief } from '../src/brief.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// The repository below is real enough to be interesting: `test/run.js` needs
// `node_modules/fake-dep/ok.txt`, and the only thing that can create it is the
// declared setup. Nothing here shells out to a package manager, so the tests
// stay hermetic; the end-to-end behaviour of a real `npm ci` is proven against
// a real clone in the field notes.
// ---------------------------------------------------------------------------

function makeDepRepo({ git = false, claim = null, lockfile = '{"lockfileVersion":3,"packages":{}}\n' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-setup-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.mkdirSync(path.join(root, '.manual', 'claims'), { recursive: true });
  const counter = path.join(base, 'installs.txt').replace(/\\/g, '/');
  const installCmd = `node fake-install.js ${counter}`;
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'dep-repo', version: '1.0.0', dependencies: { 'fake-dep': '1.0.0' }, scripts: { test: 'node test/run.js' } }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'package-lock.json'), lockfile);
  fs.writeFileSync(
    path.join(root, 'test', 'run.js'),
    "const fs = require('node:fs');\n" +
      "if (!fs.existsSync('node_modules/fake-dep/ok.txt')) { console.error(\"Cannot find module 'fake-dep'\"); process.exit(1); }\n" +
      "console.log('ok');\n",
  );
  fs.writeFileSync(
    path.join(root, 'fake-install.js'),
    "const fs = require('node:fs');\n" +
      "fs.mkdirSync('node_modules/fake-dep', { recursive: true });\n" +
      "fs.writeFileSync('node_modules/fake-dep/ok.txt', 'ok');\n" +
      `fs.appendFileSync(${JSON.stringify(counter)}, (process.argv[3] || 'install') + '\\n');\n`,
  );
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.manual/state.json\n.manual/cache/\n');
  if (claim) {
    fs.writeFileSync(
      path.join(root, '.manual', 'claims', `${claim.id}.md`),
      claimText({ id: claim.id, setup: claim.setup, installCmd }),
    );
  }
  if (git) {
    const g = (args) => execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    g('init -q');
    g('-c user.email=t@t -c user.name=t add -A');
    g('-c user.email=t@t -c user.name=t commit -qm fixture');
  }
  return { base, root, counter, installCmd };
}

// `setup: true` uses the fixture's own install command; a string is raw YAML,
// so a test can declare a prerequisite that fails on purpose.
function claimText({ id, setup = null, installCmd = 'npm ci', run = 'node test/run.js' }) {
  const setupYaml = setup === null || setup === false
    ? ''
    : setup === true
      ? `  setup:\n    run: ${JSON.stringify(installCmd)}\n    evidence:\n      - "package.json"\n      - "package-lock.json"\n    cache:\n      - node_modules\n`
      : `  setup:\n${setup}`;
  return `---
schema: manual/v1
id: ${id}
kind: command
statement: The suite passes once its dependencies exist.
priority: high
applies_to: ["**"]
evidence:
  files:
    - "package.json"
    - "package-lock.json"
check:
${setupYaml}  run: ${JSON.stringify(run)}
  expect:
    exit: 0
verify: on_change
provenance:
  author: test
  origin: authored
  evidence: "setup semantics"
lifecycle: accepted
---

The suite passes once its dependencies exist.
`;
}

const countInstalls = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

function captureLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    return { value: fn(), logs };
  } finally {
    console.log = orig;
  }
}

beforeEach(() => resetSetupMemo());

// ---------------------------------------------------------------------------

describe('setup: claim schema', () => {
  const parse = (checkYaml) =>
    parseClaim(
      `---
schema: manual/v1
id: x.y
kind: command
statement: Something is true about this repository today.
priority: normal
applies_to: ["**"]
evidence:
  files: ["package.json"]
check:
${checkYaml}
verify: on_change
provenance:
  author: t
  origin: authored
  evidence: "e"
lifecycle: candidate
---

Something is true about this repository today.
`,
      '/tmp/x.y.md',
    );

  test('a bare string shorthand is an install command', () => {
    const cl = parse('  setup: npm ci\n  run: npm test\n');
    assert.equal(cl.setup.run, 'npm ci');
    // Defaults exist so the common case needs no ceremony at all.
    assert.deepEqual(cl.setup.cache, ['node_modules']);
    assert.equal(cl.setup.timeout_s, 900);
    assert.deepEqual(cl.setup.evidence, []);
  });

  test('the map form can override evidence, cache and timeout', () => {
    const cl = parse(
      '  setup:\n    run: make deps\n    evidence: ["Makefile"]\n    cache: ["vendor"]\n    timeout_s: 30\n  run: npm test\n',
    );
    assert.deepEqual(cl.setup, {
      run: 'make deps',
      evidence: ['Makefile'],
      cache: ['vendor'],
      timeout_s: 30,
      requires: [],
      verify: null,
      verifyBuiltin: null,
      share: false,
    });
  });

  test('setup without a command is rejected, not silently ignored', () => {
    assert.throws(() => parse('  setup: {}\n  run: npm test\n'), /setup needs a command/);
  });

  test('setup on an expr check is rejected — there is nothing to install', () => {
    assert.throws(() => parse('  setup: npm ci\n  expr: exists("x")\n'), /only applies to command claims/);
  });

  test('malformed setup fields are rejected', () => {
    assert.throws(() => parse('  setup:\n    run: npm ci\n    cache: node_modules\n  run: npm test\n'), /cache must be a list/);
    assert.throws(() => parse('  setup:\n    run: npm ci\n    timeout_s: 0\n  run: npm test\n'), /timeout_s must be a positive/);
  });

  test('a claim without setup parses exactly as before', () => {
    const cl = parse('  run: npm test\n');
    assert.equal(cl.setup, null);
  });

  test('normalizing an already-normalized setup changes nothing', () => {
    // Specs travel: a declared one is normalized when manual.yaml is read, then
    // normalized again when a claim resolves it. The second pass must not
    // reinterpret `builtin:lockfile` (a marker) as a command to run.
    const once = normalizeSetup({ setup: { run: 'npm ci', verify: { builtin: 'lockfile' }, requires: ['node'], share: true } });
    assert.equal(once.verifyBuiltin, 'lockfile');
    assert.deepEqual(normalizeSetup({ setup: once }), once);
  });
});

describe('setup: cache key', () => {
  test('is stable, and only moves when the declared evidence moves', () => {
    const { root } = makeDepRepo();
    const spec = normalizeSetup({ setup: { run: 'npm ci' } });
    const k1 = setupKey(root, spec);
    assert.equal(setupKey(root, spec), k1);

    // Touching the lockfile must not cost a reinstall: the key is content, not
    // mtime. (A reverted lockfile must not skip one either.)
    const lock = path.join(root, 'package-lock.json');
    const now = Date.now() / 1000;
    fs.utimesSync(lock, now, now);
    assert.equal(setupKey(root, spec), k1);

    fs.writeFileSync(lock, '{"lockfileVersion":3,"packages":{},"changed":true}\n');
    const k2 = setupKey(root, spec);
    assert.notEqual(k2, k1);

    // Unrelated files are irrelevant.
    fs.writeFileSync(path.join(root, 'README.md'), 'x');
    assert.equal(setupKey(root, spec), k2);
  });

  test('the command is part of the key, so changing it re-runs', () => {
    const { root } = makeDepRepo();
    const a = setupKey(root, normalizeSetup({ setup: { run: 'npm ci' } }));
    const b = setupKey(root, normalizeSetup({ setup: { run: 'npm ci --omit=dev' } }));
    assert.notEqual(a, b);
  });
});

describe('setup: running once', () => {
  test('runs the command, remembers it, and does not run it again', async () => {
    const { root, counter, installCmd } = makeDepRepo();
    const spec = normalizeSetup({ setup: { run: installCmd, cache: ['node_modules'] } });

    const first = await ensureSetup(root, spec, { quiet: true });
    assert.equal(first.status, 'ran');
    assert.equal(countInstalls(counter), 1);
    assert.ok(fs.existsSync(path.join(root, 'node_modules/fake-dep/ok.txt')));

    const second = await ensureSetup(root, spec, { quiet: true });
    assert.equal(second.status, 'cached');
    assert.equal(countInstalls(counter), 1);

    // A new process (memo cleared) still does not reinstall: the disk cache is
    // what makes "once" mean once, not once-per-verify.
    resetSetupMemo();
    const third = await ensureSetup(root, spec, { quiet: true });
    assert.equal(third.status, 'cached');
    assert.equal(countInstalls(counter), 1);
    assert.equal(readSetupCache(root).entries[first.key].ok, true);
  });

  test('re-runs when the artifacts are gone, even though the cache says done', async () => {
    const { root, counter, installCmd } = makeDepRepo();
    const spec = normalizeSetup({ setup: { run: installCmd, cache: ['node_modules'] } });
    await ensureSetup(root, spec, { quiet: true });

    fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
    resetSetupMemo();
    const again = await ensureSetup(root, spec, { quiet: true });
    assert.equal(again.status, 'ran');
    assert.equal(countInstalls(counter), 2);
  });

  test('--force re-runs an install the cache considers done', async () => {
    const { root, counter, installCmd } = makeDepRepo();
    const spec = normalizeSetup({ setup: { run: installCmd, cache: ['node_modules'] } });
    await ensureSetup(root, spec, { quiet: true });
    const forced = await ensureSetup(root, spec, { force: true, quiet: true });
    assert.equal(forced.status, 'ran');
    assert.equal(countInstalls(counter), 2);
  });

  test('a failed install is recorded but never trusted', async () => {
    const { root } = makeDepRepo();
    const spec = normalizeSetup({ setup: { run: 'node -e "process.exit(3)"', cache: [] } });
    const bad = await ensureSetup(root, spec, { quiet: true });
    assert.equal(bad.status, 'failed');
    assert.equal(bad.exit, 3);
    assert.equal(readSetupCache(root).entries[bad.key].ok, false);

    // Transient failures (no network, a locked binary) must not blind the
    // manual forever: the next attempt runs again.
    resetSetupMemo();
    const again = await ensureSetup(root, spec, { quiet: true });
    assert.equal(again.status, 'failed');
    assert.equal(setupStatus(root, spec).cached, false);
  });

  test('setupStatus reports what would happen without doing it', async () => {
    const { root, counter, installCmd } = makeDepRepo();
    const spec = normalizeSetup({ setup: { run: installCmd, cache: ['node_modules'] } });
    const before = setupStatus(root, spec);
    assert.equal(before.cached, false);
    assert.equal(before.entry, null);
    assert.deepEqual(before.missing, ['node_modules']);
    assert.equal(countInstalls(counter), 0, 'asking what would happen must not install');
    await ensureSetup(root, spec, { quiet: true });
    assert.equal(setupStatus(root, spec).cached, true);
    assert.deepEqual(setupStatus(root, spec).missing, []);
  });
});

describe('verify: a claim whose prerequisite is missing', () => {
  test('without a setup declaration, the same repo reports broken — the bug this fixes', async () => {
    const { root } = makeDepRepo({ claim: { id: 'tests.suite', setup: false } });
    const state = new State(root);
    const res = await verify(root, { state, force: true });
    const r = res.results[0];
    assert.equal(r.stamp.state, 'broken');
    assert.match(r.stamp.note, /Cannot find module|exit 1/);
  });

  test('with one, the claim runs once its dependencies exist and reports fresh', async () => {
    const { root, counter } = makeDepRepo({ git: true, claim: { id: 'tests.suite', setup: true } });
    const state = new State(root);
    const res = await verify(root, { state, force: true });
    const r = res.results[0];
    assert.equal(r.stamp.state, 'fresh');
    assert.equal(r.stamp.setups.length, 1);
    assert.equal(r.stamp.setups[0].status, 'ran');
    assert.equal(countInstalls(counter), 1);
    // The install's cost is not the suite's runtime: folding it into the
    // measurement would corrupt every bound the flywheel later proposes.
    assert.ok(r.stamp.measured_ms < 5000, `measured ${r.stamp.measured_ms}ms with the install excluded`);

    // Second verify: the check re-runs (force), the install does not — and the
    // install's artifacts are still there afterwards, which is what the
    // teardown in sandbox.js is careful about.
    const again = await verify(root, { state, force: true });
    assert.equal(again.results[0].stamp.state, 'fresh');
    assert.equal(countInstalls(counter), 1);
    assert.equal(again.results[0].stamp.setups[0].status, 'cached');
    assert.deepEqual(fs.readdirSync(path.join(root, 'node_modules')), ['fake-dep']);
  });

  test('two claims sharing a prerequisite pay for it once', async () => {
    // No worktree: this is about the memo and the cache key, and the worktree
    // path already has its own test above.
    const { root, counter, installCmd } = makeDepRepo();
    for (const id of ['tests.a', 'tests.b']) {
      fs.writeFileSync(
        path.join(root, '.manual', 'claims', `${id}.md`),
        claimText({ id, setup: `    run: ${JSON.stringify(installCmd)}\n    evidence:\n      - "package.json"\n    cache:\n      - node_modules\n` }),
      );
    }
    const state = new State(root);
    const res = await verify(root, { state, force: true });
    assert.deepEqual(res.results.map((r) => r.stamp.state), ['fresh', 'fresh']);
    assert.equal(countInstalls(counter), 1);
  });

  test('a lockfile change re-installs; nothing else does', async () => {
    const { root, counter } = makeDepRepo({ claim: { id: 'tests.suite', setup: true } });
    const state = new State(root);
    await verify(root, { state, force: true });
    assert.equal(countInstalls(counter), 1);

    fs.writeFileSync(path.join(root, 'test', 'run.js'), "console.log('ok');\n");
    resetSetupMemo();
    await verify(root, { state, force: true });
    assert.equal(countInstalls(counter), 1, 'editing code does not invalidate an install');

    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{},"v":2}\n');
    resetSetupMemo();
    await verify(root, { state, force: true });
    assert.equal(countInstalls(counter), 2, 'a new lockfile does');
  });

  test('a prerequisite that cannot be installed blocks the claim instead of breaking it', async () => {
    const { root } = makeDepRepo({
      claim: { id: 'tests.suite', setup: '    run: node -e "process.exit(9)"\n    cache:\n      - node_modules\n' },
    });
    const state = new State(root);
    // Gold trust, earned before the environment broke.
    state.set('tests.suite', { state: 'fresh', tier: 'gold', passes: 9, measured_ms: 12 });

    const res = await verify(root, { state, force: true });
    const r = res.results[0];
    assert.equal(r.stamp.state, 'blocked');
    assert.match(r.stamp.note, /setup failed/);
    // Untested is not disproven: the trust earned earlier is not destroyed by
    // a machine that cannot install dependencies.
    assert.equal(r.stamp.tier, 'gold');
    assert.equal(r.stamp.passes, 9);
    assert.equal(r.stamp.setups[0].status, 'failed');

    // ...but it must not pass CI either.
    const { value: code } = captureLogs(() => printVerifyReport(res));
    assert.equal(code, 1);
  });

  test('--no-setup trusts the environment without blaming the code', async () => {
    const { root, installCmd } = makeDepRepo({ claim: { id: 'tests.suite', setup: true } });
    const state = new State(root);
    const res = await verify(root, { state, force: true, noSetup: true });
    const r = res.results[0];
    assert.equal(r.stamp.state, 'blocked');
    assert.match(r.stamp.note, /setup skipped/);
    assert.equal(r.stamp.setups[0].status, 'skipped');

    // When the environment really does have them, --no-setup is a normal green
    // verify with no install at all (this is the CI path).
    assert.ok(installCmd);
    await ensureSetup(root, loadManual(root).claims[0].setup, { quiet: true });
    resetSetupMemo();
    const ok = await verify(root, { state, force: true, noSetup: true });
    assert.equal(ok.results[0].stamp.state, 'fresh');
    assert.equal(ok.results[0].stamp.setups[0].status, 'skipped');
  });
});

describe('repo-level prerequisites: declared once in manual.yaml', () => {
  const writeConfig = (root, text) => fs.writeFileSync(path.join(root, '.manual', 'manual.yaml'), text);
  const configPath = (root) => path.join(root, '.manual', 'manual.yaml');

  // A claim whose check needs the artifact both prerequisites produce, so the
  // check only passes once they have run.
  const claimRequiring = (id, requires, extra = '') => `---
schema: manual/v1
id: ${id}
kind: command
statement: The suite passes once its dependencies exist.
priority: high
applies_to: ["**"]
evidence:
  files:
    - "package.json"
check:
  requires: ${Array.isArray(requires) ? `[${requires.join(', ')}]` : requires}
${extra}  run: "node test/run.js"
  expect:
    exit: 0
verify: on_change
provenance:
  author: test
  origin: authored
  evidence: "repo-level prerequisites"
lifecycle: accepted
---

The suite passes once its dependencies exist.
`;

  test('one named install serves every claim that requires it', async () => {
    const { root, counter } = makeDepRepo();
    writeConfig(
      root,
      `schema: manual/v1\nsetup:\n  node:\n    run: "node fake-install.js ${counter} node"\n    evidence: ["package.json", "package-lock.json"]\n    cache: ["node_modules"]\n`,
    );
    for (const id of ['tests.a', 'tests.b', 'tests.c']) {
      fs.writeFileSync(path.join(root, '.manual', 'claims', `${id}.md`), claimRequiring(id, 'node'));
    }
    // And one claim that declares the very same step inline: same command and
    // evidence, so the same key, so it is still one install.
    fs.writeFileSync(
      path.join(root, '.manual', 'claims', 'tests.d.md'),
      claimRequiring('tests.d', 'node', `  setup:\n    run: "node fake-install.js ${counter} node"\n    evidence: ["package.json", "package-lock.json"]\n    cache: ["node_modules"]\n`),
    );
    const state = new State(root);
    const res = await verify(root, { state, force: true });
    assert.deepEqual(res.results.map((r) => r.stamp.state), ['fresh', 'fresh', 'fresh', 'fresh']);
    assert.deepEqual(fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean), ['node']);
    // The stamp names the prerequisite, so a failure downstream says which step.
    assert.deepEqual(res.results[0].stamp.setups.map((s) => s.name), ['node']);
  });

  test('two ecosystems install once each, in the order the claim lists them', async () => {
    const { root, counter } = makeDepRepo();
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'requests==2.0.0\n');
    writeConfig(
      root,
      `schema: manual/v1\nsetup:\n  node:\n    run: "node fake-install.js ${counter} node"\n    evidence: ["package.json"]\n    cache: ["node_modules"]\n  python:\n    run: "node fake-install.js ${counter} python"\n    evidence: ["requirements.txt"]\n    cache: ["node_modules"]\n  build:\n    run: "node fake-install.js ${counter} build"\n    evidence: ["package.json"]\n    cache: ["node_modules"]\n`,
    );
    fs.writeFileSync(
      path.join(root, '.manual', 'claims', 'tests.suite.md'),
      claimRequiring('tests.suite', ['node', 'python'], `  setup:\n    run: "node fake-install.js ${counter} build"\n    evidence: ["package.json"]\n    cache: ["node_modules"]\n`),
    );
    const state = new State(root);
    const res = await verify(root, { state, force: true });
    assert.equal(res.results[0].stamp.state, 'fresh');
    // Named prerequisites in the order written, then the claim's own step — the
    // inline one is the specific build that sits on top of the installs.
    assert.deepEqual(fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean), ['node', 'python', 'build']);
    assert.deepEqual(res.results[0].stamp.setups.map((s) => [s.name, s.status]), [
      ['node', 'ran'],
      ['python', 'ran'],
      [null, 'ran'],
    ]);
    const hist = state.data.history.at(-1);
    assert.equal(hist.setups, 3);
    assert.ok(hist.setup_ms > 0);
  });

  test('a name nobody declares is a load error, not a skipped step', async () => {
    const { root } = makeDepRepo();
    writeConfig(root, 'schema: manual/v1\nsetup:\n  node:\n    run: "node fake-install.js"\n');
    fs.writeFileSync(path.join(root, '.manual', 'claims', 'tests.suite.md'), claimRequiring('tests.suite', 'nodejs'));
    const state = new State(root);
    const res = await verify(root, { state, force: true });
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /requires unknown prerequisite "nodejs"/);
    assert.match(res.errors[0], /node/); // and it names what *is* declared
    // The claim is blocked rather than run unprepared, because a check that runs
    // without its install reports its own failure as the repository's truth.
    assert.equal(res.results[0].stamp.state, 'blocked');
    assert.match(res.results[0].stamp.note, /unknown prerequisite/);
  });

  test('a malformed setup block is reported instead of crashing the manual', async () => {
    const { root } = makeDepRepo();
    writeConfig(
      root,
      'schema: manual/v1\nsetup:\n  Node_Install:\n    run: npm ci\n  broken:\n    evidence: ["package.json"]\n  bad-cache:\n    run: npm ci\n    cache: node_modules\n',
    );
    const cfg = loadConfig(root);
    assert.deepEqual(Object.keys(cfg.setup), []);
    assert.equal(cfg.setupErrors.length, 3);
    assert.match(cfg.setupErrors.join('\n'), /must be lowercase/);
    assert.match(cfg.setupErrors.join('\n'), /"broken" needs a run command/);
    assert.match(cfg.setupErrors.join('\n'), /cache must be a list/);
    const res = await verify(root, { state: new State(root), force: true });
    assert.deepEqual(res.errors, cfg.setupErrors.map((e) => e));
  });

  test('resolvePrereqs dedupes identical steps and puts the inline one last', () => {
    const spec = { run: 'npm ci', evidence: ['package.json'], cache: ['node_modules'] };
    const config = { setup: { node: spec, aliases: spec } };
    const { specs, unknown } = resolvePrereqs({ check: { requires: ['aliases', 'node'] } }, config);
    assert.deepEqual(specs.map((s) => s.name), ['aliases']);
    assert.deepEqual(unknown, []);
    const inline = resolvePrereqs({ check: { requires: 'node' }, setup: { run: 'make build' } }, config);
    assert.deepEqual(inline.specs.map((s) => [s.name, s.spec.run]), [['node', 'npm ci'], [null, 'make build']]);
    assert.deepEqual(resolvePrereqs({ check: {} }, config).specs, []);
  });

  test('manual setup shows declared, referenced and unknown prerequisites', async () => {
    const { root, counter } = makeDepRepo();
    const bin = path.resolve('bin/manual.js');
    writeConfig(
      root,
      `schema: manual/v1\nsetup:\n  node:\n    run: "node fake-install.js ${counter} node"\n    evidence: ["package.json"]\n    cache: ["node_modules"]\n  unused:\n    run: "make things"\n    cache: []\n`,
    );
    fs.writeFileSync(path.join(root, '.manual', 'claims', 'tests.suite.md'), claimRequiring('tests.suite', 'node'));
    const listed = JSON.parse(execSync(`node "${bin}" setup --json`, { cwd: root, encoding: 'utf8' }));
    const byName = Object.fromEntries(listed.setups.map((s) => [s.name, s]));
    assert.deepEqual(byName.node.claims, ['tests.suite']);
    assert.equal(byName.node.cached, false);
    assert.equal(byName.unused.declared, true);
    assert.deepEqual(byName.unused.claims, [], 'a declared install is a fact about the repo, referenced or not');
    assert.equal(countInstalls(counter), 0);

    // --force warms what claims need, not every declaration: an unreferenced
    // install is a fact about the repo, and running it is opt-in (--all).
    const ran = execSync(`node "${bin}" setup --force`, { cwd: root, encoding: 'utf8' });
    assert.match(ran, /declared, no claim requires it — skipped/);
    assert.deepEqual(fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean), ['node']);

    // A typo shows up as a failing listing, not as a missing install.
    fs.writeFileSync(path.join(root, '.manual', 'claims', 'tests.typo.md'), claimRequiring('tests.typo', 'nope'));
    const failed = (() => {
      try {
        execSync(`node "${bin}" setup`, { cwd: root, encoding: 'utf8' });
        return 0;
      } catch (e) {
        return Number(e.status);
      }
    })();
    assert.equal(failed, 1);
  });
});

describe('init: repo-level prerequisites', () => {
  test('the detected ecosystem is declared in manual.yaml and referenced by name', () => {
    const { root } = makeDepRepo();
    const res = init(root);
    assert.deepEqual(res.declared, ['node']);
    const cfg = loadConfig(root);
    assert.equal(cfg.setup.node.run, 'npm ci');
    assert.deepEqual(cfg.setup.node.cache, ['node_modules']);
    const candidate = fs.readFileSync(path.join(root, '.manual', 'inbox', 'init-tests.suite.md'), 'utf8');
    assert.match(candidate, /requires: node/);
    assert.ok(!/setup:/.test(candidate), 'the command is written once, in manual.yaml');
    // And the candidate resolves, as a claim, to that declared install.
    const parsed = parseClaim(candidate, path.join(root, '.manual', 'claims', 'tests.suite.md'));
    const { specs } = resolvePrereqs(parsed, cfg);
    assert.equal(specs[0].spec.run, 'npm ci');
  });

  test('an existing setup block is never rewritten — the gap is reported instead', () => {
    const { root } = makeDepRepo();
    fs.mkdirSync(path.join(root, '.manual', 'inbox'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.manual', 'manual.yaml'),
      'schema: manual/v1\nbrief:\n  budget_tokens: 600\nsetup:\n  custom:\n    run: "my own thing"\n',
    );
    const before = fs.readFileSync(path.join(root, '.manual', 'manual.yaml'), 'utf8');
    const res = init(root);
    assert.equal(fs.readFileSync(path.join(root, '.manual', 'manual.yaml'), 'utf8'), before, 'a human file is not merged into');
    assert.match(res.declared.join(' '), /node \(not written/);
    assert.equal(loadConfig(root).setup.node, undefined);
  });

  test('a config without a setup block gains one, keeping what was there', () => {
    const { root } = makeDepRepo();
    fs.writeFileSync(path.join(root, '.manual', 'manual.yaml'), 'schema: manual/v1\nbrief:\n  budget_tokens: 600\n');
    init(root);
    const cfg = loadConfig(root);
    assert.equal(cfg.brief.budget_tokens, 600);
    assert.equal(cfg.setup.node.run, 'npm ci');
  });

  test('a Makefile that names its own dependency target is declared too', () => {
    const { root } = makeDepRepo();
    fs.writeFileSync(path.join(root, 'Makefile'), 'test:\n\tgo test ./...\n\ndeps:\n\tgo mod download\n');
    const { prereqs } = detect(root);
    assert.equal(prereqs.make.run, 'make deps');
    // `cache: []` because the target decides where it lands: the marker is the
    // only evidence of success available, and a made-up directory would be
    // worse (it would re-run forever, or never).
    assert.deepEqual(prereqs.make.cache, []);
    assert.deepEqual(prereqs.make.evidence, ['Makefile']);
  });

  test('a second ecosystem is declared alongside the first', () => {
    const { root } = makeDepRepo();
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'requests==2.0.0\n');
    fs.mkdirSync(path.join(root, '.venv'), { recursive: true });
    const { prereqs } = detect(root);
    assert.deepEqual(Object.keys(prereqs).sort(), ['node', 'python']);
    assert.match(prereqs.python.run, /venv/);
    assert.deepEqual(prereqs.python.cache, ['.venv']);
    init(root);
    assert.deepEqual(Object.keys(loadConfig(root).setup).sort(), ['node', 'python']);
  });
});

describe('setup: surfaced where a human and an agent will see it', () => {
  test('doctor names the prerequisite and the command that fixes it', async () => {
    const { root } = makeDepRepo({ claim: { id: 'tests.suite', setup: true } });
    const state = new State(root);
    const blocked = await verify(root, { state, force: true, noSetup: true });
    assert.equal(blocked.results[0].stamp.state, 'blocked');

    const res = doctor(root, state);
    const row = res.rows.find((r) => r.id === 'tests.suite');
    assert.equal(row.setups.length, 1);
    assert.equal(row.setups[0].cached, false);
    assert.deepEqual(row.setups[0].missing, ['node_modules']);
    assert.match(row.issues.join(' '), /prerequisite not satisfied/);
    assert.match(row.issues.join(' '), /manual setup --force/);
    const { value: code, logs } = captureLogs(() => printDoctor(res));
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /⚙ setup \(unsatisfied\)/);
  });

  test('a policy gate does not pass a policy whose prerequisite is missing', async () => {
    const { root } = makeDepRepo();
    // Same silent-pass shape as `verify --json` forgetting to save: a gate that
    // reports success for a check it never ran.
    fs.writeFileSync(
      path.join(root, '.manual', 'claims', 'policy.deps.md'),
      `---
schema: manual/v1
id: policy.deps
kind: policy
statement: The suite policy is gated on its dependencies being installed.
priority: high
applies_to: ["**"]
evidence:
  files: ["package.json"]
check:
  setup:
    run: node -e "process.exit(7)"
    cache:
      - node_modules
  run: node test/run.js
  expect:
    exit: 0
  enforce:
    stage: pre-commit
    paths: ["**"]
    severity: block
verify: on_change
provenance:
  author: test
  origin: authored
  evidence: "gate semantics"
lifecycle: accepted
---
The suite policy is gated on its dependencies being installed.
`,
    );
    const state = new State(root);
    const { failures } = await enforce(root, state, { stage: 'pre-commit' });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].severity, 'block');
    assert.match(failures[0].note, /blocked — setup failed/);
  });

  test('brief tells an agent what to install, and stays quiet once it is there', async () => {
    const { root, installCmd } = makeDepRepo({ claim: { id: 'tests.suite', setup: true } });
    const state = new State(root);
    const before = brief(root, ['test/run.js'], { state, quiet: true });
    assert.match(before.lines[0], /⚙ needs: node fake-install/);
    // A satisfied prerequisite is the normal case and costs no tokens.
    const { claims } = loadManual(root);
    assert.equal(claims[0].setup.run, installCmd);
    await ensureSetup(root, claims[0].setup, { quiet: true });
    resetSetupMemo();
    const after = brief(root, ['test/run.js'], { state, quiet: true });
    assert.ok(!/⚙/.test(after.lines[0]), after.lines[0]);
  });
});

describe('init: discovering a prerequisite', () => {
  test('a command candidate on a checkout without dependencies requires the named one', () => {
    const { root } = makeDepRepo();
    const { findings, prereqs } = detect(root);
    // The command is written down once, in manual.yaml, and the claim refers to
    // it by name — so ten claims that need an install say ten words, not ten
    // copies of the same command.
    assert.equal(prereqs.node.run, 'npm ci');
    assert.deepEqual(prereqs.node.cache, ['node_modules']);
    assert.deepEqual(prereqs.node.evidence, ['package.json', 'package-lock.json']);
    const suite = findings.find((f) => f.id === 'tests.suite');
    assert.equal(suite.requires, 'node');
    assert.equal(suite.setup, null);
  });

  test('an installed checkout gets no requirement — nothing to declare', () => {
    const { root } = makeDepRepo();
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const { findings, prereqs } = detect(root);
    assert.equal(findings.find((f) => f.id === 'tests.suite').requires, null);
    // The prerequisite is still a fact about the repo: `manual setup` shows it
    // whether or not a claim needed it today.
    assert.equal(prereqs.node.run, 'npm ci');
  });

  test('the install command follows the repo, not a default', () => {
    const { root } = makeDepRepo();
    assert.equal(installCommand(root).run, 'npm ci');
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    assert.match(installCommand(root).run, /^pnpm install --frozen-lockfile/);
    fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
    fs.writeFileSync(path.join(root, 'yarn.lock'), '# yarn\n');
    assert.match(installCommand(root).run, /^yarn install --frozen-lockfile/);
  });

  test('missing-dependency output is distinguished from a failing assertion', () => {
    assert.ok(looksLikeMissingDeps("Error: Cannot find module 'mocha'\n"));
    assert.ok(looksLikeMissingDeps('bash: jest: command not found\n'));
    assert.ok(looksLikeMissingDeps('npm error code ENOENT\n'));
    assert.ok(looksLikeMissingDeps('exit 127'));
    assert.ok(!looksLikeMissingDeps('AssertionError [ERR_ASSERTION]: 1 !== 2\n# fail 1\n'));
    assert.ok(!looksLikeMissingDeps(''));
  });

  test('the probe declares what it learned and tries again', async () => {
    // A repo whose check needs something that isn't installed, but which does
    // not obviously depend on a package manager (no lockfile, no dependencies):
    // discovery alone cannot see the prerequisite, so the probe has to learn it
    // from the failure.
    const { root, counter } = makeDepRepo();
    fs.rmSync(path.join(root, 'package-lock.json'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dep-repo', version: '1.0.0', scripts: { test: 'node test/run.js' } }, null, 2));
    await init(root);
    const inferInstall = () => ({ run: `node fake-install.js ${counter}`, evidence: ['package.json'], cache: ['node_modules'] });

    const probes = await probeCandidates(root, { quiet: true, inferInstall });
    const suite = probes.find((p) => p.file === 'init-tests.suite.md');
    assert.equal(suite.state, 'fresh', 'the second probe is the one that says something');
    assert.equal(countInstalls(counter), 1);

    const text = fs.readFileSync(path.join(root, '.manual', 'inbox', 'init-tests.suite.md'), 'utf8');
    assert.match(text, /setup:/);
    assert.match(text, /fake-install\.js/);
    assert.match(text, /setup_status: ran/);
    // The candidate now parses as a real claim with a prerequisite, so
    // accepting it does not require a human to hand-edit the frontmatter.
    const parsed = parseClaim(text, path.join(root, '.manual', 'claims', 'tests.suite.md'));
    assert.equal(parsed.setup.cache[0], 'node_modules');
  });

  test('a repo with no dependencies gets no invented prerequisite', async () => {
    const { root } = makeDepRepo({ claim: { id: 'tests.suite', setup: false } });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: "node -e \"console.error('AssertionError: 1 !== 2'); process.exit(1)\"" } }, null, 2),
    );
    fs.rmSync(path.join(root, 'package-lock.json'));
    await init(root);
    const probes = await probeCandidates(root, { quiet: true });
    const suite = probes.find((p) => p.file === 'init-tests.suite.md');
    // The check fails because the code is wrong, not because npm is — proposing
    // an install here would be an invented prerequisite.
    assert.equal(suite.state, 'broken');
    const text = fs.readFileSync(path.join(root, '.manual', 'inbox', 'init-tests.suite.md'), 'utf8');
    assert.ok(!/setup:/.test(text));
  });
});

describe('manual setup: the command', () => {
  test('reports what is declared, and --force satisfies it', async () => {
    const { root, counter } = makeDepRepo({ claim: { id: 'tests.suite', setup: true } });
    const bin = path.resolve('bin/manual.js');
    const listed = JSON.parse(execSync(`node "${bin}" setup --json`, { cwd: root, encoding: 'utf8' }));
    assert.equal(listed.setups.length, 1);
    assert.match(listed.setups[0].run, /fake-install\.js/);
    assert.deepEqual(listed.setups[0].claims, ['tests.suite']);
    assert.equal(listed.setups[0].cached, false);
    assert.deepEqual(listed.setups[0].missing, ['node_modules']);
    assert.equal(countInstalls(counter), 0, 'listing must not install');

    const out = execSync(`node "${bin}" setup --force`, { cwd: root, encoding: 'utf8' });
    assert.match(out, /✔/);
    assert.equal(countInstalls(counter), 1);
    const after = JSON.parse(execSync(`node "${bin}" setup --json`, { cwd: root, encoding: 'utf8' }));
    assert.equal(after.setups[0].cached, true);

    // Nothing declares a setup: a clean exit, not a failure.
    fs.rmSync(path.join(root, '.manual', 'claims', 'tests.suite.md'));
    assert.match(execSync(`node "${bin}" setup`, { cwd: root, encoding: 'utf8' }), /no prerequisites declared/);
  });
});

// ---------------------------------------------------------------------------
// A repository's prerequisites are not a flat list: an install comes first, a
// build sits on top of it, codegen sits on top of that. Writing the edge down
// (`build.requires: [node]`) means the order is computed from the graph, so a
// claim that lists its requirements in the wrong order still runs them in the
// only order that can work — and a graph with no valid order is refused rather
// than guessed at.
// ---------------------------------------------------------------------------
describe('repo-level prerequisites: edges between steps', () => {
  const writeConfig = (root, text) => fs.writeFileSync(path.join(root, '.manual', 'manual.yaml'), text);

  const claimRequiring = (id, requires) => `---
schema: manual/v1
id: ${id}
kind: command
statement: The suite passes once its dependencies exist.
priority: high
applies_to: ["**"]
evidence:
  files:
    - "package.json"
check:
  requires: ${Array.isArray(requires) ? `[${requires.join(', ')}]` : requires}
  run: "node test/run.js"
  expect:
    exit: 0
verify: on_change
provenance:
  author: test
  origin: authored
  evidence: "prerequisite edges"
lifecycle: accepted
---

The suite passes once its dependencies exist.
`;

  // node installs, build depends on it, and they are different commands so the
  // install log can show which ran when.
  const dagConfig = (counter, extra = '') =>
    `schema: manual/v1\nsetup:\n` +
    `  node:\n    run: "node fake-install.js ${counter} node"\n    evidence: ["package.json"]\n    cache: ["node_modules"]\n` +
    `  build:\n    run: "node fake-install.js ${counter} build"\n    evidence: ["package.json"]\n    cache: ["node_modules"]\n    requires: [node]\n` +
    extra;

  test('a dependency edge orders the steps, whatever order the claim wrote', async () => {
    const { root, counter } = makeDepRepo();
    writeConfig(root, dagConfig(counter));
    // Written in the order it is *not* safe to run in.
    fs.writeFileSync(path.join(root, '.manual', 'claims', 'tests.suite.md'), claimRequiring('tests.suite', ['build', 'node']));
    const res = await verify(root, { state: new State(root), force: true });
    assert.equal(res.results[0].stamp.state, 'fresh');
    // node before build, and node only once: the edge is an ordering constraint,
    // not a second reason to install.
    assert.deepEqual(fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean), ['node', 'build']);
    assert.deepEqual(res.results[0].stamp.setups.map((s) => s.name), ['node', 'build']);
  });

  test('a claim that requires only the build still gets the install it sits on', async () => {
    const { root, counter } = makeDepRepo();
    writeConfig(root, dagConfig(counter));
    fs.writeFileSync(path.join(root, '.manual', 'claims', 'tests.suite.md'), claimRequiring('tests.suite', 'build'));
    const res = await verify(root, { state: new State(root), force: true });
    assert.equal(res.results[0].stamp.state, 'fresh');
    assert.deepEqual(fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean), ['node', 'build'], 'the edge is what makes the order correct, not the claim');
  });

  test('a cycle is refused, not resolved into a wrong order', async () => {
    const config = { setup: { a: { requires: ['b'] }, b: { requires: ['a'] } } };
    const g = prereqOrder(config);
    assert.deepEqual(g.order, [], 'no order exists, so none is invented');
    assert.equal(g.cycles.length, 1);
    assert.deepEqual(g.cycles[0], ['a', 'b', 'a']);

    const { root, counter } = makeDepRepo();
    writeConfig(
      root,
      `schema: manual/v1\nsetup:\n  a:\n    run: "node fake-install.js ${counter} a"\n    cache: ["node_modules"]\n    requires: [b]\n  b:\n    run: "node fake-install.js ${counter} b"\n    cache: ["node_modules"]\n    requires: [a]\n`,
    );
    fs.writeFileSync(path.join(root, '.manual', 'claims', 'tests.suite.md'), claimRequiring('tests.suite', 'a'));
    const res = await verify(root, { state: new State(root), force: true });
    assert.equal(res.results[0].stamp.state, 'blocked');
    assert.match(res.results[0].stamp.note, /cycle/i);
    assert.equal(countInstalls(counter), 0, 'neither step of a cycle runs: there is no first one');
  });

  test('a dependency on a name nobody declares is reported like a typo in the claim', () => {
    const g = prereqOrder({ setup: { build: { requires: ['node'] } } });
    assert.deepEqual(g.order, ['build']);
    assert.deepEqual(g.unknown, [{ name: 'node', required_by: 'build' }]);
  });

  test('the plan is the run: deduped across claims, in the computed order', () => {
    const { root, counter } = makeDepRepo();
    writeConfig(root, dagConfig(counter));
    const config = loadConfig(root);
    const claims = [
      { fm: { id: 'tests.a' }, check: { requires: ['build'] } },
      { fm: { id: 'tests.b' }, check: { requires: ['build', 'node'] } },
    ];
    const plan = planPrereqs(claims, config);
    assert.deepEqual(plan.steps.map((s) => s.name), ['node', 'build']);
    assert.deepEqual(plan.steps[0].claims, ['tests.a', 'tests.b'], 'both claims are listed against the install they share');
    assert.deepEqual(plan.steps[1].spec.requires, ['node']);
    assert.deepEqual(plan.unknown, []);
  });

  test('manual setup --plan prints the order and establishes nothing', async () => {
    const { root, counter } = makeDepRepo();
    const bin = path.resolve('bin/manual.js');
    writeConfig(root, dagConfig(counter));
    fs.writeFileSync(path.join(root, '.manual', 'claims', 'tests.suite.md'), claimRequiring('tests.suite', 'build'));

    const run = (args) => {
      try {
        return { status: 0, out: execSync(`node "${bin}" ${args}`, { cwd: root, encoding: 'utf8' }) };
      } catch (e) {
        return { status: Number(e.status), out: String(e.stdout || '') };
      }
    };

    const before = run('setup --plan --json');
    assert.equal(before.status, 1, 'an unsatisfied plan is not a success');
    const planned = JSON.parse(before.out);
    assert.deepEqual(planned.plan.map((s) => s.name), ['node', 'build']);
    assert.deepEqual(planned.plan.map((s) => s.cached), [false, false]);
    assert.deepEqual(planned.plan.find((s) => s.name === 'build').requires, ['node']);
    assert.equal(countInstalls(counter), 0, 'a plan that installed something would not be a plan');

    const human = run('setup --plan').out;
    assert.match(human, /1\. node → .*fake-install\.js .* node/);
    assert.match(human, /2\. build → .*fake-install\.js .* build.*needs node/);

    // Satisfy it, and the same plan now reads as done — with the order intact.
    assert.equal(run('setup --force').status, 0);
    const after = run('setup --plan --json');
    assert.equal(after.status, 0);
    assert.deepEqual(JSON.parse(after.out).plan.map((s) => s.cached), [true, true]);
  });
});

// ---------------------------------------------------------------------------
// "It ran once" is not evidence that the tree is still there. The lockfile
// builtin answers the question a marker cannot — is this install still the one
// the lockfile describes? — and the store lets another checkout on this machine
// borrow a tree that was verified, right now, where it was built.
// ---------------------------------------------------------------------------
describe('setup: a satisfied install is verified, not merely remembered', () => {
  const LOCK = JSON.stringify({
    name: 'dep-repo',
    lockfileVersion: 3,
    packages: {
      '': { name: 'dep-repo' },
      'node_modules/fake-dep': { version: '1.0.0' },
      'node_modules/fake-dep/node_modules/inner': { version: '1.0.0' },
    },
  }) + '\n';

  // The nested package is the point: losing it does not change the immediate
  // contents of node_modules, so the cheap witness cannot see it.
  const installNested = (root, counter) =>
    fs.writeFileSync(
      path.join(root, 'fake-install.js'),
      "const fs = require('node:fs');\n" +
        "fs.mkdirSync('node_modules/fake-dep/node_modules/inner', { recursive: true });\n" +
        "fs.writeFileSync('node_modules/fake-dep/ok.txt', 'ok');\n" +
        "fs.writeFileSync('node_modules/fake-dep/node_modules/inner/index.js', '');\n" +
        `fs.appendFileSync(${JSON.stringify(counter)}, 'install\\n');\n`,
    );

  const spec = (run, verify) =>
    normalizeSetup({ setup: { run, evidence: ['package.json', 'package-lock.json'], cache: ['node_modules'], ...(verify ? { verify } : {}) } });

  test('the lockfile builtin compares the tree against the lockfile, cheaply', async () => {
    const { root, counter, installCmd } = makeDepRepo({ lockfile: LOCK });
    installNested(root, counter);

    const s = spec(installCmd, { builtin: 'lockfile' });
    const first = await ensureSetup(root, s, { quiet: true });
    assert.equal(first.status, 'ran');
    const ok = verifyLockfile(root);
    assert.equal(ok.ok, true);
    assert.match(ok.note, /2 package\(s\) present/);

    // Cached, and re-checked: the second ask pays for the verifier, not installs.
    assert.equal((await ensureSetup(root, s, { quiet: true })).status, 'cached');
    assert.equal(countInstalls(counter), 1);

    // A subtree disappears without touching the top level of node_modules.
    fs.rmSync(path.join(root, 'node_modules/fake-dep/node_modules'), { recursive: true });
    const v = verifyLockfile(root);
    assert.equal(v.ok, false);
    assert.match(v.note, /1\/2 installed package\(s\) missing/);

    // So the cached install is distrusted — by the verifier, which is the only
    // layer that could have noticed — and rebuilt. (A later verify is a later
    // process, so the in-run memo is cleared first.)
    resetSetupMemo();
    let distrusted = null;
    const third = await ensureSetup(root, s, {
      quiet: true,
      onRun: () => {
        distrusted = readSetupCache(root).entries[setupKey(root, s)].invalidated;
      },
    });
    assert.equal(third.status, 'ran');
    assert.equal(countInstalls(counter), 2);
    assert.equal(distrusted.by, 'verify');
    assert.match(distrusted.note, /missing/);
    const entry = readSetupCache(root).entries[setupKey(root, s)];
    assert.match(entry.reason, /distrusted \(verify\)/);
    assert.ok(fs.existsSync(path.join(root, 'node_modules/fake-dep/node_modules/inner/index.js')), 'and the install repaired it');
  });

  test('a verifier with nothing to compare says so, and does not force a reinstall', async () => {
    // Real shape: express ships .npmrc with package-lock=false, so there is no
    // lockfile to compare against. "No" here would mean reinstalling on every
    // verify — the same symptom as a verifier that cannot run at all.
    const { root, counter, installCmd } = makeDepRepo();
    fs.rmSync(path.join(root, 'package-lock.json'));
    const s = spec(installCmd, { builtin: 'lockfile' });
    assert.deepEqual(verifyLockfile(root), { ok: null, ms: 0, note: 'no package lockfile to compare the install against' });

    assert.equal((await ensureSetup(root, s, { quiet: true })).status, 'ran');
    resetSetupMemo();
    assert.equal((await ensureSetup(root, s, { quiet: true })).status, 'cached', 'unverifiable is not the same as false');
    assert.equal(countInstalls(counter), 1);

    // And the gap is reportable rather than silent.
    const st = setupStatus(root, s);
    assert.equal(st.cached, true);
    assert.match(st.verify_unavailable, /no package-lock\.json or npm-shrinkwrap\.json/);
  });

  test('without a verifier, the same stale tree stays trusted — the boundary is explicit', async () => {
    const { root, counter, installCmd } = makeDepRepo({ lockfile: LOCK });
    installNested(root, counter);
    // A different command, so this is a different install with its own key.
    const s = spec(`${installCmd} unverified`, null);
    assert.equal((await ensureSetup(root, s, { quiet: true })).status, 'ran');
    fs.rmSync(path.join(root, 'node_modules/fake-dep/node_modules'), { recursive: true });
    assert.equal(await ensureSetup(root, s, { quiet: true }).then((r) => r.status), 'cached');
    assert.equal(countInstalls(counter), 1, 'a marker cannot see inside a directory it only hashed the names of');
  });

  test('a verifier declared in manual.yaml survives resolution and is not run as a command', async () => {
    const { root, counter, installCmd } = makeDepRepo({ lockfile: LOCK });
    installNested(root, counter);
    fs.writeFileSync(
      path.join(root, '.manual', 'manual.yaml'),
      `schema: manual/v1\nsetup:\n  node:\n    run: ${JSON.stringify(installCmd)}\n    evidence: ["package.json", "package-lock.json"]\n    cache: ["node_modules"]\n    verify:\n      builtin: lockfile\n`,
    );
    const config = loadConfig(root);
    const { specs } = resolvePrereqs({ check: { requires: ['node'] } }, config);
    assert.equal(specs[0].spec.verifyBuiltin, 'lockfile', 'the declared verifier reaches the runner intact');

    assert.equal((await ensureSetup(root, specs[0].spec, { quiet: true })).status, 'ran');
    resetSetupMemo();
    assert.equal((await ensureSetup(root, specs[0].spec, { quiet: true })).status, 'cached');
    assert.equal(countInstalls(counter), 1, 'a verifier that is run as a command fails, and every verify reinstalls');

    // The verifier is what notices a loss the witness cannot see.
    fs.rmSync(path.join(root, 'node_modules/fake-dep/node_modules'), { recursive: true });
    resetSetupMemo();
    assert.equal((await ensureSetup(root, specs[0].spec, { quiet: true })).status, 'ran');
    assert.equal(countInstalls(counter), 2);
  });

  test('an install another checkout verified is borrowed, and re-verified before it is', async () => {
    const { base, root: a, counter, installCmd } = makeDepRepo({ lockfile: LOCK });
    installNested(a, counter);
    const store = path.join(base, 'store');
    const prevStore = process.env.MANUAL_STORE;
    process.env.MANUAL_STORE = store;
    try {
      const s = spec(installCmd, { builtin: 'lockfile' });
      s.share = true;
      assert.equal((await ensureSetup(a, s, { quiet: true })).status, 'ran');
      assert.equal(countInstalls(counter), 1);

      // A second checkout of the same repository: same files, same evidence,
      // nothing installed, and this checkout's cache knows nothing.
      const b = path.join(base, 'clone');
      fs.cpSync(a, b, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(path.join('.manual', 'cache')) });
      assert.ok(!fs.existsSync(path.join(b, 'node_modules')));

      const borrowed = await ensureSetup(b, s, { quiet: true });
      assert.equal(borrowed.status, 'adopted');
      assert.equal(borrowed.link, a);
      assert.equal(countInstalls(counter), 1, 'the second checkout never ran the install');
      assert.equal(fs.readFileSync(path.join(b, 'node_modules/fake-dep/ok.txt'), 'utf8'), 'ok', 'and the tree is really there');
      assert.equal(setupStatus(b, s).cached, true);

      // A third checkout that has not adopted yet: the plan says the work is
      // already done elsewhere, before it spends anything finding that out.
      const c = path.join(base, 'clone-2');
      fs.cpSync(a, c, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(path.join('.manual', 'cache')) });
      assert.equal(setupStatus(c, s).cached, false);
      assert.equal(setupStatus(c, s).borrowable_from, a);

      // If the tree it would borrow is damaged, there is nothing to borrow: the
      // store records where an install was verified, not a promise it still is.
      fs.rmSync(path.join(a, 'node_modules/fake-dep'), { recursive: true });
      assert.equal(setupStatus(c, s).borrowable_from, null);
      const fresh = await ensureSetup(c, s, { quiet: true });
      assert.equal(fresh.status, 'ran');
      assert.equal(countInstalls(counter), 2, 'so it installs for itself instead of borrowing a broken tree');
    } finally {
      if (prevStore === undefined) delete process.env.MANUAL_STORE;
      else process.env.MANUAL_STORE = prevStore;
    }
  });
});
