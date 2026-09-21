import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Sandbox for `check.run` commands. Preferred mode: throwaway git worktree of
// HEAD + overlay of the current diff, so mutating checks can't dirty the user's
// checkout. Fallback: run in place (non-git roots) with a warning.

export class Sandbox {
  constructor(root) {
    this.root = root;
    this.mode = 'inplace';
    this.wt = null;
  }

  gitOk() {
    const r = spawnSync('git', ['-C', this.root, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    });
    return r.status === 0 && (r.stdout || '').trim() === 'true';
  }

  async enter() {
    if (!this.gitOk()) return this; // inplace fallback
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-wt-'));
    const add = spawnSync(
      'git',
      ['-C', this.root, 'worktree', 'add', '--detach', tmp, 'HEAD'],
      { encoding: 'utf8' },
    );
    if (add.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return this;
    }
    // Overlay uncommitted modifications (tracked files only).
    const diff = spawnSync('git', ['-C', this.root, 'diff', '--binary'], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (diff.status === 0 && diff.stdout.length > 0) {
      spawnSync('git', ['-C', tmp, 'apply', '--whitespace=nowarn'], {
        input: diff.stdout,
        encoding: 'buffer',
      });
    }
    this.mode = 'worktree';
    this.wt = tmp;
    return this;
  }

  get cwd() {
    return this.mode === 'worktree' ? this.wt : this.root;
  }

  exec(cmd, { timeoutMs = 60000 } = {}) {
    // Checks must not inherit test-runner context from the parent process:
    // NODE_TEST_CONTEXT changes node:test CLI behavior (e.g. reporter flags
    // silently stop erroring), which would corrupt verify results.
    const env = { ...process.env, MANUAL_ROOT: this.root, MANUAL_SANDBOX: this.mode };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', cmd], {
      cwd: this.cwd,
      encoding: 'buffer',
      timeout: timeoutMs,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    const dec = (b) => Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? '');
    return {
      exit: r.status,
      stdout: dec(r.stdout),
      stderr: dec(r.stderr),
      timedOut: r.status === null && r.error?.code === 'ETIMEDOUT',
      killed: r.status === null,
    };
  }

  async exit() {
    if (this.mode === 'worktree' && this.wt) {
      spawnSync('git', ['-C', this.root, 'worktree', 'remove', '--force', this.wt], {
        encoding: 'utf8',
      });
      fs.rmSync(this.wt, { recursive: true, force: true });
      this.wt = null;
      this.mode = 'inplace';
    }
  }
}
