import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { verify } from '../src/verify.js';
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
