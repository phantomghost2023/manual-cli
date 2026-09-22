import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { verify } from '../src/verify.js';
import { Sandbox } from '../src/sandbox.js';
import { State } from '../src/state.js';

// Regression: the manual lives in a subdirectory of a git repo, and its
// checks depend on a file that is untracked. The worktree sandbox must (a)
// run checks from the subdirectory, not the worktree root, and (b) overlay
// untracked files so mid-work checks see them.
describe('sandbox: subdir offset + untracked overlay', () => {
  test('nested manual sees untracked files at the right cwd', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-sbx-'));
    const nested = path.join(repo, 'nested');
    fs.mkdirSync(path.join(nested, '.manual', 'claims'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'untracked.txt'), 'hello-overlay');
    fs.writeFileSync(
      path.join(nested, '.manual', 'claims', 'probe.untracked.md'),
      `---
schema: manual/v1
id: probe.untracked
kind: command
statement: The overlay file is visible from the nested working directory.
priority: normal
applies_to: ["**"]
evidence:
  files: ["untracked.txt"]
check:
  run: cat untracked.txt
  expect:
    exit: 0
    stdout_matches: hello-overlay
verify: on_change
provenance:
  author: test
  origin: authored
  evidence: "regression test for sandbox cwd/overlay"
lifecycle: accepted
---
The overlay file is visible from the nested working directory.
`,
    );
    const g = (args) =>
      execSync(`git ${args}`, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    g('init -q');
    g('-c user.email=t@t -c user.name=t add nested/.manual');
    g('-c user.email=t@t -c user.name=t commit -qm manual-only');

    const state = new State(nested);
    const res = await verify(nested, { state, force: true });
    const probe = res.results.find((r) => r.claim.fm.id === 'probe.untracked');
    assert.equal(probe.stamp.state, 'fresh'); // would be broken without cwd/overlay fixes
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

// Regression from a real drill on vuejs/core: on Windows the check's node.exe
// can still hold handles when teardown's recursive delete runs, so rmSync died
// with EBUSY *after* the checks had run — and because exit() runs before the
// caller saves state, the whole verify crashed and lost the stamps it had just
// computed. Teardown must be best-effort, never fatal.
describe('sandbox: teardown is best-effort', () => {
  test('exit() survives a worktree that cannot be deleted', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-sbx2-'));
    fs.mkdirSync(path.join(repo, '.manual'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.manual', 'keep.md'), 'so the fixture has something to commit');
    const g = (args) =>
      execSync(`git ${args}`, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    g('init -q');
    g('-c user.email=t@t -c user.name=t add .manual');
    g('-c user.email=t@t -c user.name=t commit -qm init');

    const sb = new Sandbox(repo);
    await sb.enter();
    assert.equal(sb.mode, 'worktree');
    const wt = sb.wt;

    let child = null;
    if (process.platform === 'win32') {
      // A live process whose cwd is inside the worktree holds it: the
      // recursive delete dies with EBUSY. This is exactly the shape of the
      // original failure (a check's node.exe still exiting).
      child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
        cwd: wt,
        stdio: 'ignore',
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    await sb.exit(); // must not throw — the failure must stay a warning

    if (child) {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      // The locked directory legitimately survives exit(); clean it up here
      // so the temp dir does not fill across runs.
      fs.rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
      assert.ok(!fs.existsSync(wt), 'posix: worktree should be fully removed');
    }
    execSync('git worktree prune', { cwd: repo, stdio: 'ignore' });
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("sandbox: the repo's own virtualenv reaches PATH", () => {
  // A check written `python -m pytest` must mean the *project's* interpreter.
  // The bin list only knew `.venv/bin` — the POSIX layout — so on Windows the
  // system interpreter answered every `python`, `pytest` and `pip` a check ran,
  // and the fresh venv the prerequisite had just built sat unused. Found by the
  // wild canary on encode/httpx: a 64s install succeeded and the check still
  // died on a missing dependency, because pytest imported against the wrong tree.
  test('both venv layouts are put on PATH, whichever exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-sbx-'));
    fs.mkdirSync(path.join(dir, '.venv', 'Scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.venv', 'Scripts', 'python.exe'), '');
    fs.writeFileSync(path.join(dir, '.venv', 'bin', 'pytest'), '');
    try {
      const sb = new Sandbox(dir); // inplace mode: cwd is root, wt is null
      const bins = sb.localBins();
      assert.ok(bins.some((p) => p.endsWith(path.join('.venv', 'Scripts'))), `Scripts missing from ${bins.join(', ')}`);
      assert.ok(bins.some((p) => p.endsWith(path.join('.venv', 'bin'))), `bin missing from ${bins.join(', ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
