import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  ensureSetup,
  normalizeSetup,
  readSetupCache,
  resetSetupMemo,
  setupKey,
  setupStatus,
} from '../src/setup.js';
import { loadManual, parseClaim } from '../src/claims.js';
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
      `fs.appendFileSync(${JSON.stringify(counter)}, 'install\\n');\n`,
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
    assert.deepEqual(cl.setup, { run: 'make deps', evidence: ['Makefile'], cache: ['vendor'], timeout_s: 30 });
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
    assert.equal(r.stamp.setup.status, 'ran');
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
    assert.equal(again.results[0].stamp.setup.status, 'cached');
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
    assert.equal(r.stamp.setup.status, 'failed');

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
    assert.equal(r.stamp.setup.status, 'skipped');

    // When the environment really does have them, --no-setup is a normal green
    // verify with no install at all (this is the CI path).
    assert.ok(installCmd);
    await ensureSetup(root, loadManual(root).claims[0].setup, { quiet: true });
    resetSetupMemo();
    const ok = await verify(root, { state, force: true, noSetup: true });
    assert.equal(ok.results[0].stamp.state, 'fresh');
    assert.equal(ok.results[0].stamp.setup.status, 'skipped');
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
    assert.equal(row.setup.cached, false);
    assert.deepEqual(row.setup.missing, ['node_modules']);
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
  test('a command candidate on a checkout without dependencies declares one', () => {
    const { root } = makeDepRepo();
    const { findings } = detect(root);
    const suite = findings.find((f) => f.id === 'tests.suite');
    assert.equal(suite.setup.run, 'npm ci');
    assert.deepEqual(suite.setup.cache, ['node_modules']);
    assert.deepEqual(suite.setup.evidence, ['package.json', 'package-lock.json']);
  });

  test('an installed checkout gets no setup — nothing to declare', () => {
    const { root } = makeDepRepo();
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const { findings } = detect(root);
    assert.equal(findings.find((f) => f.id === 'tests.suite').setup, null);
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
    assert.match(text, /setup_state: ran/);
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
    assert.match(execSync(`node "${bin}" setup`, { cwd: root, encoding: 'utf8' }), /nothing to install/);
  });
});
