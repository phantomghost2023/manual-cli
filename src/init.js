import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.js';
import { parseYaml, stringifyYaml } from './yaml.js';
import { splitFrontmatter } from './md.js';
import { runCheck } from './runner.js';
import { Sandbox } from './sandbox.js';
import { normalizeSetup } from './setup.js';
import { VENDORED_CLI } from './eject.js';

// Init: discover facts about a repo by inspection and scaffold a .manual/
// with confident, executable claims. Only emits claims it can back with
// evidence found on disk; everything is marked origin: observed.

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// How to install this repo's dependencies, when it has any.
//
// Only ecosystems whose install lands in a project-local directory are
// proposed: an install that writes to a shared or global location (pip without
// a venv, `go install`) is not something a discovery command should do to a
// machine, so those repos get the failure message and a human decides.
export function installCommand(root, pkg = null) {
  const p = pkg || readJson(path.join(root, 'package.json')) || {};
  const has = (f) => fs.existsSync(path.join(root, f));
  const js = { cache: ['node_modules'] };
  // The verifier each package manager's lockfile is read by. Yarn and bun write
  // lockfiles no builtin reads yet, so those prerequisites declare none rather
  // than one that can only ever answer "cannot tell" — a permanently
  // unverifiable line on every report is worse than an absent one.
  const npmVerify = { builtin: 'npm' };
  const pnpmVerify = { builtin: 'pnpm' };
  if (String(p.packageManager || '').startsWith('pnpm') || has('pnpm-lock.yaml')) {
    return { run: 'pnpm install --frozen-lockfile', evidence: ['package.json', 'pnpm-lock.yaml'], ...js, verify: pnpmVerify };
  }
  if (String(p.packageManager || '').startsWith('yarn') || has('yarn.lock')) {
    return { run: 'yarn install --frozen-lockfile', evidence: ['package.json', 'yarn.lock'], ...js };
  }
  if (String(p.packageManager || '').startsWith('bun') || has('bun.lockb')) {
    return { run: 'bun install --frozen-lockfile', evidence: ['package.json', 'bun.lockb'], ...js };
  }
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) {
    return { run: 'npm ci', evidence: ['package.json', 'package-lock.json'], ...js, verify: npmVerify };
  }
  if (depCount(p) > 0) return { run: 'npm install', evidence: ['package.json'], ...js };
  return null;
}

// The prerequisite each detected ecosystem needs, named so that claims can
// reference it instead of restating the command.
//
// A repository rarely has one install: a JS frontend and a Python service have
// two, and every command claim that touches either would otherwise carry its own
// copy of the same command — the same command written twice is two chances to
// disagree. Discovery writes them here once; claims say `requires: node`.
export function ecosystemPrereqs(root, pkg = null) {
  const p = pkg || readJson(path.join(root, 'package.json')) || {};
  const has = (f) => fs.existsSync(path.join(root, f));
  const out = {};
  const node = installCommand(root, p);
  if (node && depCount(p) > 0) out.node = node;
  // A virtualenv is project-local by construction — `python -m venv .venv`
  // writes inside the checkout — so an install into one is a step a verifier may
  // take, and the lockfile it installs from is the thing the venv builtin
  // compares. A bare `pip install` into the system Python is shared machine
  // state and is still not proposed.
  const win = process.platform === 'win32';
  const venv = has('.venv') ? '.venv' : has('venv') ? 'venv' : '.venv';
  if (has('requirements.txt') || (has('pyproject.toml') && has('poetry.lock'))) {
    out.python = has('pyproject.toml') && has('poetry.lock')
      ? { run: 'poetry install', evidence: ['pyproject.toml', 'poetry.lock'], cache: [venv], verify: { builtin: 'venv' } }
      : {
        // The interpreter and the script directory differ per platform
        // (`Scripts` on Windows, `bin` elsewhere), and a prerequisite that only
        // works on the machine that discovered it is a prerequisite that fails
        // on the next one.
        run: `${win ? 'python' : 'python3'} -m venv ${venv} && ${venv}/${win ? 'Scripts' : 'bin'}/pip install -r requirements.txt`,
        evidence: ['requirements.txt'],
        cache: [venv],
        verify: { builtin: 'venv' },
      };
  }
  // A Makefile that declares a dependency target is the repo telling us its own
  // install story; `cache` is empty because the target decides where it lands.
  if (has('Makefile') && /^deps:/m.test(safeRead(path.join(root, 'Makefile')))) {
    out.make = { run: 'make deps', evidence: ['Makefile'], cache: [] };
  }
  return out;
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// Commands that a shell can run without the package manager's PATH injection.
const SYSTEM_BINS = /^(node|nodejs|deno|bun|python|python3|pytest|go|cargo|make|cmake|bash|sh|zsh|ruby|rake|php|dotnet|java|mvn|gradle|ant|npm|pnpm|yarn)$/;

// The repo's own "run the tests" entry point, in whatever manager it uses.
// `bun run test`, never `bun test`: the latter is bun's built-in runner and
// would silently ignore the script the repository actually wrote.
export function packageManagerTestCommand(root, pkg = null) {
  const p = pkg || readJson(path.join(root, 'package.json')) || {};
  if (!p.scripts || typeof p.scripts.test !== 'string' || !p.scripts.test.trim()) return null;
  const has = (f) => fs.existsSync(path.join(root, f));
  const pm = String(p.packageManager || '');
  if (pm.startsWith('pnpm') || has('pnpm-lock.yaml')) return 'pnpm test';
  if (pm.startsWith('yarn') || has('yarn.lock')) return 'yarn test';
  if (pm.startsWith('bun') || has('bun.lockb')) return 'bun run test';
  return 'npm test';
}

export function depCount(pkg = {}) {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .reduce((n, k) => n + Object.keys(pkg[k] || {}).length, 0);
}

// Output shapes that mean "the tool is missing", not "the assertion failed".
// This is the signal that turns a false-looking probe into a declared
// prerequisite: exit 127 (command not found) and node's module resolution
// errors are both about the environment, never about the repository.
export function looksLikeMissingDeps(out) {
  return /cannot find module|module_not_found|err_module_not_found|command not found|jest: not found|mocha: not found|vitest: not found|npm error code enoent|exit 127|\b127\b(?!\d)/i.test(
    String(out || ''),
  );
}

export function detect(root) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const findings = [];
  const pm = pkg.packageManager || '';
  const hasPnpmLock = fs.existsSync(path.join(root, 'pnpm-lock.yaml'));
  const hasYarnLock = fs.existsSync(path.join(root, 'yarn.lock'));
  const hasNpmLock = fs.existsSync(path.join(root, 'package-lock.json'));

  if (pm.startsWith('pnpm') || hasPnpmLock) {
    findings.push({
      kind: 'fact',
      id: 'tooling.package-manager',
      statement: 'This repo uses pnpm; other installers exit 0 but produce a broken tree.',
      priority: 'critical',
      applies_to: ['**'],
      evidence: { files: ['package.json', 'pnpm-lock.yaml'] },
      check: { expr: 'manifest("package.json").packageManager.startsWith("pnpm@") || exists("pnpm-lock.yaml")' },
      note: 'Install with `pnpm install --frozen-lockfile`.',
    });
  } else if (hasNpmLock && !hasYarnLock) {
    findings.push({
      kind: 'fact',
      id: 'tooling.package-manager',
      statement: 'This repo uses npm.',
      priority: 'normal',
      applies_to: ['**'],
      evidence: { files: ['package.json', 'package-lock.json'] },
      check: { expr: 'exists("package-lock.json") && !exists("yarn.lock")' },
      note: 'Use `npm ci` for reproducible installs.',
    });
  }

  const isEsm = pkg.type === 'module';
  if (isEsm) {
    findings.push({
      kind: 'fact',
      id: 'tooling.modules',
      statement: 'This repo is pure ESM (`"type": "module"`); CJS requires crash at import time.',
      priority: 'critical',
      applies_to: ['**'],
      evidence: { files: ['package.json'] },
      check: { expr: 'manifest("package.json").type === "module"' },
      note: 'Use `import` everywhere, including scripts.',
    });
  }

  const scripts = pkg.scripts || {};
  const testScript = scripts.test || '';
  const pmRunTest = packageManagerTestCommand(root, pkg);
  const hasTests = ['test', 'tests', 'src', 'lib'].some((d) =>
    fs.existsSync(path.join(root, d)),
  );
  if (testScript && hasTests) {
    // What the check runs must be what the statement says, and it must be able
    // to run outside `npm run`.
    //
    // Found on a real repo (express): `scripts.test` is `mocha --require …`,
    // and mocha lives in node_modules/.bin, which npm puts on PATH and a plain
    // shell does not. Running the script body directly therefore exited 127 —
    // after an install that had already succeeded, which reads as "the tests
    // fail" when nothing was ever tested. A script whose first word is a
    // system binary (node, pytest, make) is runnable as-is; anything else is a
    // local binary and has to go through the package manager's own entry
    // point, which is also what the README and CI tell a human to type.
    const firstWord = (testScript.trim().split(/\s+/)[0] || '').replace(/^npx$/, '');
    const local = firstWord === '' || !SYSTEM_BINS.test(firstWord);
    const throughPm = local && pmRunTest;
    const checkRun = throughPm || testScript;
    const runner = throughPm || firstWord || testScript.trim();
    // A command claim whose dependencies are not installed is false about the
    // checkout, not about the repo. When the checkout is missing them the claim
    // references the prerequisite declared in manual.yaml by name — discovery
    // does not restate the command it just wrote down.
    const missingDeps = depCount(pkg) > 0 && !fs.existsSync(path.join(root, 'node_modules'));
    const declared = ecosystemPrereqs(root, pkg);
    const named = missingDeps && declared.node ? 'node' : null;
    const install = missingDeps && !named ? installCommand(root, pkg) : null;
    findings.push({
      kind: 'command',
      id: 'tests.suite',
      // The prose names the runner too, because "npm test" alone doesn't tell a
      // reader that mocha is what will actually be run.
      statement: throughPm
        ? `The test suite runs with \`${runner}\` (${firstWord}).`
        : `The test suite runs with \`${runner}\`.`,
      priority: 'high',
      applies_to: ['src/**', 'test/**', 'lib/**'],
      evidence: { files: ['package.json', 'src/**', 'test/**'] },
      check: { run: checkRun, expect: { exit: 0, max_ms: 120000 } },
      setup: install,
      requires: named,
      note: [
        `Discovered from package.json scripts.test = "${testScript}".`,
        throughPm
          ? `The script calls a local binary (${firstWord}), so the check runs it through \`${throughPm}\` — the way node_modules/.bin reaches PATH.`
          : null,
        named
          ? `Dependencies are not installed in this checkout, so the candidate requires the \`${named}\` prerequisite declared in .manual/manual.yaml (${declared.node.run}); verify runs it before the check.`
          : install
            ? `Dependencies are not installed in this checkout, so the candidate declares a setup (${install.run}); verify runs it before the check.`
            : null,
      ].filter(Boolean).join(' '),
    });
  }

  if (fs.existsSync(path.join(root, 'migrations'))) {
    findings.push({
      kind: 'policy',
      id: 'policy.migrations-shippable',
      statement: 'Migrations directory contents must remain loadable — the check re-runs the repo migration self-test.',
      priority: 'high',
      applies_to: ['migrations/**'],
      evidence: { files: ['migrations/**'] },
      check: { run: 'ls migrations >/dev/null', expect: { exit: 0 } },
      enforce: { stage: 'pre-commit', paths: ['migrations/**'], severity: 'warn' },
      note: 'Placeholder policy — replace the run with your real migration self-test.',
    });
  }

  if (fs.existsSync(path.join(root, '.github', 'CODEOWNERS'))) {
    findings.push({
      kind: 'ownership',
      id: 'ownership.default',
      statement: 'CODEOWNERS is present and non-empty.',
      priority: 'normal',
      applies_to: ['**'],
      evidence: { files: ['.github/CODEOWNERS'] },
      check: { expr: 'codeowners().length > 0' },
      note: 'Coordination claims should reference specific owners.',
    });
  }

  return { pkg, findings, prereqs: ecosystemPrereqs(root, pkg) };
}

// The check block, including the prerequisite when one was discovered.
function checkBlock(f) {
  if (f.check.expr) return `  expr: ${JSON.stringify(f.check.expr)}`;
  const requires = f.requires
    ? Array.isArray(f.requires)
      ? `  requires:\n${f.requires.map((n) => `    - ${n}`).join('\n')}\n`
      : `  requires: ${f.requires}\n`
    : '';
  const setup = f.setup
    ? `  setup:\n    run: ${JSON.stringify(f.setup.run)}\n    evidence:\n${(f.setup.evidence || []).map((p) => `      - "${p}"`).join('\n')}\n    cache:\n${(f.setup.cache || []).map((p) => `      - ${p}`).join('\n')}\n${verifyBlock(f.setup, '    ')}`
    : '';
  return `${requires}${setup}  run: ${JSON.stringify(f.check.run)}\n  expect:\n    exit: ${f.check.expect?.exit ?? 0}\n    max_ms: ${f.check.expect?.max_ms ?? 120000}`;
}

function claimFile(f) {
  const fm = `---
schema: manual/v1
id: ${f.id}
kind: ${f.kind}
statement: ${f.statement}
priority: ${f.priority}
applies_to:
${(f.applies_to || ['**']).map((p) => `  - "${p}"`).join('\n')}
evidence:
  files:
${(f.evidence.files || ['**']).map((p) => `    - "${p}"`).join('\n')}
check:
${checkBlock(f)}
verify: on_change
provenance:
  author: agent:manual-cli
  origin: observed
  evidence: "discovered by manual init at ${nowIso().slice(0, 10)}"
lifecycle: candidate
---

${f.statement}

## Notes
${f.note || 'Discovered automatically. Review, adjust, and accept.'}
`;
  return fm;
}

// Run each discovered candidate's check before a human is asked to accept it.
//
// Found on a real repository: `init` proposed "the test suite runs with npm
// test" for a repo whose dependencies were not installed, so the first
// accepted claim in that repo was false on arrival (exit 127). Discovery is
// cheap; claiming is not. Probing turns "observed" into "observed and tried".
// `inferInstall` is how a prerequisite is guessed from a failed check. It is a
// parameter so tests can exercise the inference without a real package manager.
export async function probeCandidates(root, { timeoutMs = 20000, quiet = false, setup = true, inferInstall = installCommand } = {}) {
  const inboxDir = path.join(root, '.manual', 'inbox');
  let files = [];
  try {
    files = fs.readdirSync(inboxDir).filter((f) => f.startsWith('init-') && f.endsWith('.md'));
  } catch {
    return [];
  }
  if (files.length === 0) return [];
  const results = [];
  let sandbox = null;
  try {
    sandbox = await new Sandbox(root).enter();
    for (const f of files) {
      const full = path.join(inboxDir, f);
      const text = fs.readFileSync(full, 'utf8');
      const { fm: fmRaw, body } = splitFrontmatter(text);
      const fm = fmRaw ? parseYaml(fmRaw) : {};
      if (!fm.check) continue;

      const attempt = async () => {
        try {
          return await runCheck({ fm, check: fm.check, setup: normalizeSetup(fm.check) }, root, {
            sandbox,
            // The probe's short cap is a floor, not a ceiling: a real suite
            // that takes 20s is not a broken claim, and reporting it as one is
            // how discovery loses a human's trust. The claim's own bound is
            // what will be asserted later, so it is what we wait for here.
            timeoutMs: Math.max(timeoutMs, fm.check?.expect?.max_ms || 0),
            noSetup: !setup,
            quiet: true,
          });
        } catch (e) {
          return { ok: false, error: e.message, ms: null };
        }
      };

      let r = await attempt();
      // A check that fails because its dependency isn't installed is not a
      // false claim. Infer the prerequisite from the repo's own package
      // manager, declare it in the candidate, and probe again — the second
      // probe is the one that says something about the repository.
      let declared = null;
      let declaredName = null;
      if (!r.ok && !r.blocked && setup && !fm.check.setup && !fm.check.requires) {
        const install = inferInstall(root);
        if (install && looksLikeMissingDeps(`${r.stdout || ''}\n${r.error || ''}`)) {
          // One declared prerequisite for this repo means the install it names
          // is the one the failure is about, so the candidate references it
          // rather than copying the command into its own frontmatter.
          const names = Object.keys(ecosystemPrereqs(root));
          if (names.length === 1) {
            fm.check.requires = names[0];
            declaredName = names[0];
          } else {
            fm.check.setup = { run: install.run, evidence: install.evidence, cache: install.cache };
          }
          declared = install;
          r = await attempt();
        }
      }
      const probe = {
        state: r.ok ? 'fresh' : r.blocked ? 'blocked' : 'broken',
        note: r.ok ? `${r.ms ?? '?'}ms` : (r.error || `exit ${r.exit}`),
        ms: r.ms ?? null,
      };
      const next = {
        ...fm,
        observation: {
          ...(fm.observation || {}),
          ...{ at: nowIso(), by: 'agent:manual-cli', probe_state: probe.state, probe_note: probe.note },
          ...(declared
            ? {
                setup: declared.run,
                setup_status: (r.setups || []).map((s) => s.status).join(', ') || 'unknown',
                ...(declaredName ? { requires: declaredName } : {}),
              }
            : {}),
        },
      };
      const noteLine = probe.state === 'fresh'
        ? `Probed before proposing: the check passes on this checkout (${probe.note})${declared ? `, after declaring its prerequisite (${declaredName ? `requires: ${declaredName} — ` : ''}${declared.run})` : ''}.`
        : probe.state === 'blocked'
          ? `Probed before proposing: **the prerequisite could not be established here** (${probe.note}). The claim is untested — install it, then re-run \`manual verify\`. It is not a false claim, and it will report \`blocked\` rather than \`broken\` until then.`
          : `Probed before proposing: **the check does not pass here** (${probe.note}). It may need dependencies installed, a build step, or a different command. Do not accept it as-is.`;
      fs.writeFileSync(full, `---\n${stringifyYaml(next)}---\n${body.trim()}\n\n${noteLine}\n`);
      results.push({
        file: f,
        ...probe,
        requires: declaredName || fm.check.requires || null,
        setup: declared ? declared.run : (normalizeSetup(fm.check)?.run || null),
      });
      if (!quiet) {
        const icon = probe.state === 'fresh' ? '✔' : '✖';
        console.log(`${icon} probed ${f}: ${probe.state} (${probe.note})`);
      }
    }
  } finally {
    if (sandbox) await sandbox.exit();
  }
  return results;
}

// A declared verifier, as YAML at the given indentation. `auto` is never written:
// discovery knows which ecosystem it just found, so the prerequisite names the
// verifier for it and a reader does not have to.
function verifyBlock(spec, indent) {
  if (!spec?.verify?.builtin) return '';
  return `${indent}verify:\n${indent}  builtin: ${spec.verify.builtin}\n`;
}

// The `setup:` block as YAML, indented for manual.yaml.
function setupBlock(prereqs) {
  if (Object.keys(prereqs).length === 0) return '';
  let out = 'setup:\n';
  for (const [name, spec] of Object.entries(prereqs)) {
    out += `  ${name}:\n    run: ${JSON.stringify(spec.run)}\n`;
    if (spec.evidence?.length) out += `    evidence:\n${spec.evidence.map((e) => `      - "${e}"`).join('\n')}\n`;
    if (spec.cache?.length) out += `    cache:\n${spec.cache.map((c) => `      - ${c}`).join('\n')}\n`;
    else out += '    cache: []\n';
    out += verifyBlock(spec, '    ');
  }
  return out;
}

export function init(root, { dryRun = false } = {}) {
  const dir = path.join(root, '.manual');
  const claimsDir = path.join(dir, 'claims');
  const inboxDir = path.join(dir, 'inbox');
  const created = [];
  const existed = fs.existsSync(claimsDir);

  const { pkg, findings, prereqs } = detect(root);
  const cfgPath = path.join(dir, 'manual.yaml');
  const declared = [];

  if (!dryRun) {
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    const block = setupBlock(prereqs);
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(
        cfgPath,
        `schema: manual/v1\nbrief:\n  budget_tokens: 2000\nverify:\n  default_timeout_s: 120\n  ci:\n    required:\n      - policy.*\n    diff_base: origin/main\n${block}`,
      );
      declared.push(...Object.keys(prereqs));
    } else if (block) {
      // An existing manual.yaml is the human's file. It is extended only when it
      // has no setup block at all; merging into one would mean rewriting YAML
      // this tool did not write, losing comments and ordering to add a line.
      const text = fs.readFileSync(cfgPath, 'utf8');
      let existing = {};
      try {
        existing = parseYaml(text) || {};
      } catch {
        existing = {};
      }
      const known = Object.keys(existing.setup || {});
      const missing = Object.keys(prereqs).filter((n) => !known.includes(n));
      if (!existing.setup) {
        fs.appendFileSync(cfgPath, `\n${block}`);
        declared.push(...missing);
      } else if (missing.length) {
        // Say what was found instead of editing: the detected commands are
        // printed so a human can paste them, and nothing is lost if they don't.
        declared.push(...missing.map((n) => `${n} (not written — manual.yaml already declares: ${known.join(', ')})`));
      }
    }
    if (!fs.existsSync(path.join(root, '.gitignore')) ||
        !fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.manual/state.json')) {
      fs.appendFileSync(
        path.join(root, '.gitignore'),
        '\n# manual verify stamps are machine state, not truth\n.manual/state.json\n\n# what has already been installed here (check.setup cache)\n.manual/cache/\n',
      );
    }
  }

  // Candidates go to the inbox (flywheel: humans accept, agents propose).
  for (const f of findings) {
    const dest = path.join(inboxDir, `init-${f.id}.md`);
    if (fs.existsSync(dest)) continue;
    if (!dryRun) fs.writeFileSync(dest, claimFile(f));
    created.push(path.basename(dest));
  }

  // CI workflow (only when a git repo + github dir exist).
  if (!dryRun && fs.existsSync(path.join(root, '.git'))) {
    const wfDir = path.join(root, '.github', 'workflows');
    const wf = path.join(wfDir, 'manual.yml');
    if (fs.existsSync(path.join(root, '.github')) && !fs.existsSync(wf)) {
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(
        wf,
        `name: manual\non: [push, pull_request]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with: { fetch-depth: 0 }\n      - uses: actions/setup-node@v4\n        with: { node-version: 22 }\n      - name: Verify claims relevant to this diff\n        run: |\n          # The workflow installs dependencies for the whole job, so verify --\n          # no-setup trusts the environment instead of repeating an install per\n          # claim's declared prerequisite.\n          if [ -f "${VENDORED_CLI}" ]; then\n            node ${VENDORED_CLI} verify --diff "\${{ github.event.pull_request.base.sha || 'HEAD~1' }}" --no-setup\n          else\n            echo "manual-cli not vendored; run: node <path-to-manual-cli>/bin/manual.js eject --root ." >&2\n            exit 1\n          fi\n`,
      );
      created.push('.github/workflows/manual.yml');
    }
  }

  return {
    created,
    existed,
    scripts: pkg.scripts || {},
    findings: findings.length,
    prereqs,
    declared,
    dryRun,
  };
}
