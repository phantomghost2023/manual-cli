import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.js';
import { parseYaml, stringifyYaml } from './yaml.js';
import { splitFrontmatter } from './md.js';
import { runCheck } from './runner.js';
import { Sandbox } from './sandbox.js';
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
  const hasTests = ['test', 'tests', 'src', 'lib'].some((d) =>
    fs.existsSync(path.join(root, d)),
  );
  if (testScript && hasTests) {
    // The statement must describe the command that actually runs. Falling back
    // to "npm test" for an unrecognized runner produced a claim whose prose and
    // whose check disagreed (found on a real repo: mocha!).
    const known = /vitest/.test(testScript)
      ? 'vitest run'
      : /jest/.test(testScript)
        ? 'npx jest'
        : /--test/.test(testScript)
          ? 'node --test'
          : null;
    const runner = known || testScript.trim().split(/\s+/)[0];
    findings.push({
      kind: 'command',
      id: 'tests.suite',
      statement: `The test suite runs with \`${runner}\`.`,
      priority: 'high',
      applies_to: ['src/**', 'test/**', 'lib/**'],
      evidence: { files: ['package.json', 'src/**', 'test/**'] },
      check: { run: testScript, expect: { exit: 0, max_ms: 120000 } },
      note: `Discovered from package.json scripts.test = "${testScript}".`,
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

  return { pkg, findings };
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
${f.check.expr ? `  expr: ${JSON.stringify(f.check.expr)}` : `  run: ${JSON.stringify(f.check.run)}\n  expect:\n    exit: ${f.check.expect?.exit ?? 0}\n    max_ms: ${f.check.expect?.max_ms ?? 120000}`}
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
export async function probeCandidates(root, { timeoutMs = 20000, quiet = false } = {}) {
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
      const claim = { fm, check: fm.check };
      let probe;
      try {
        const r = await runCheck(claim, root, { sandbox, timeoutMs });
        probe = { state: r.ok ? 'fresh' : 'broken', note: r.ok ? `${r.ms ?? '?'}ms` : (r.error || `exit ${r.exit}`), ms: r.ms ?? null };
      } catch (e) {
        probe = { state: 'untested', note: e.message, ms: null };
      }
      const next = { ...fm, observation: { ...(fm.observation || {}), ...{ at: nowIso(), by: 'agent:manual-cli', probe_state: probe.state, probe_note: probe.note } } };
      const noteLine = probe.state === 'fresh'
        ? `Probed before proposing: the check passes on this checkout (${probe.note}).`
        : `Probed before proposing: **the check does not pass here** (${probe.note}). It may need dependencies installed, a build step, or a different command. Do not accept it as-is.`;
      fs.writeFileSync(full, `---\n${stringifyYaml(next)}---\n${body.trim()}\n\n${noteLine}\n`);
      results.push({ file: f, ...probe });
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

export function init(root, { dryRun = false } = {}) {
  const dir = path.join(root, '.manual');
  const claimsDir = path.join(dir, 'claims');
  const inboxDir = path.join(dir, 'inbox');
  const created = [];
  const existed = fs.existsSync(claimsDir);

  const { pkg, findings } = detect(root);

  if (!dryRun) {
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    if (!fs.existsSync(path.join(dir, 'manual.yaml'))) {
      fs.writeFileSync(
        path.join(dir, 'manual.yaml'),
        `schema: manual/v1\nbrief:\n  budget_tokens: 2000\nverify:\n  default_timeout_s: 120\n  ci:\n    required:\n      - policy.*\n    diff_base: origin/main\n`,
      );
    }
    if (!fs.existsSync(path.join(root, '.gitignore')) ||
        !fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.manual/state.json')) {
      fs.appendFileSync(path.join(root, '.gitignore'), '\n# manual verify stamps are machine state, not truth\n.manual/state.json\n');
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
        `name: manual\non: [push, pull_request]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with: { fetch-depth: 0 }\n      - uses: actions/setup-node@v4\n        with: { node-version: 22 }\n      - name: Verify claims relevant to this diff\n        run: |\n          # Self-contained when the CLI is vendored (manual eject).\n          if [ -f "${VENDORED_CLI}" ]; then\n            node ${VENDORED_CLI} verify --diff "\${{ github.event.pull_request.base.sha || 'HEAD~1' }}"\n          else\n            echo "manual-cli not vendored; run: node <path-to-manual-cli>/bin/manual.js eject --root ." >&2\n            exit 1\n          fi\n`,
      );
      created.push('.github/workflows/manual.yml');
    }
  }

  return { created, existed, scripts: pkg.scripts || {}, findings: findings.length, dryRun };
}
