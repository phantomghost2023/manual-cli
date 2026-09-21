import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Sandbox for `check.run` commands. Preferred mode: throwaway git worktree of
// HEAD + overlay of the current diff, so mutating checks can't dirty the user's
// checkout. Fallback: run in place (non-git roots) with a warning.

const DEFAULT_DEPS = ['node_modules', '.venv', 'venv', 'vendor/bundle'];

// Unlink a directory link without touching what it points at. `unlink` is the
// POSIX move and fails on Windows junctions; `rmdir` removes the reparse point
// itself, never the target — which is the whole point.
function unlinkLink(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch { /* junctions and directory symlinks land here on Windows */ }
  try {
    fs.rmdirSync(p);
    return true;
  } catch {
    return false;
  }
}

export class Sandbox {
  constructor(root) {
    this.root = root;
    this.mode = 'inplace';
    this.wt = null;
    this.toplevel = root;
    this.linked = [];
    this.extraDeps = [];
    this.cwdBase = root;
    this.rel = '';
  }

  gitOk() {
    const r = spawnSync('git', ['-C', this.root, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    });
    return r.status === 0 && (r.stdout || '').trim() === 'true';
  }

  async enter() {
    if (!this.gitOk()) return this; // inplace fallback
    const top = spawnSync('git', ['-C', this.root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    });
    const toplevel = top.status === 0 ? (top.stdout || '').trim() : this.root;
    // If the manual lives in a subdirectory of the repo, checks must run from
    // that subdirectory inside the worktree — not from the worktree root.
    this.rel = path.relative(toplevel, this.root) || '';
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
    // Overlay untracked files too (excluding gitignored ones) — brand-new
    // source files are precisely what mid-work checks must be able to see.
    const others = spawnSync(
      'git',
      // --full-name: paths relative to the repo top, regardless of -C subdir
      ['-C', this.root, 'ls-files', '--others', '--exclude-standard', '--full-name', '-z'],
      { encoding: 'buffer' },
    );
    if (others.status === 0) {
      for (const rel of others.stdout.toString('utf8').split('\0')) {
        if (!rel) continue;
        const src = path.join(toplevel, rel);
        const dst = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try { fs.copyFileSync(src, dst); } catch { /* vanished mid-copy: skip */ }
      }
    }
    this.toplevel = toplevel;
    this.mode = 'worktree';
    this.wt = tmp;
    this.cwdBase = this.rel ? path.join(tmp, this.rel) : tmp;
    this.linkDeps();
    return this;
  }

  // Link dependency trees that git ignores.
  //
  // Found on a real repo: `node_modules/` is gitignored, so it is neither in
  // the worktree nor in the untracked overlay, and every check that needs an
  // installed dependency failed in the sandbox while passing in the working
  // tree. A verifier that cannot run the repo's own tests is not verifying
  // anything, so these directories are linked from the source checkout.
  // They are shared, not copied: a check that mutates one mutates the
  // developer's, exactly as running the command by hand would.
  //
  // Idempotent, and called again after a setup runs: a prerequisite install
  // creates the directory the check needs, and it has to exist *before* the
  // check runs, not only on the next verify.
  linkDeps() {
    if (!this.wt) return [];
    this.linked = this.linked || [];
    const extra = this.extraDeps || [];
    for (const rel of [...new Set([...DEFAULT_DEPS, ...extra])]) {
      const src = path.join(this.toplevel, rel);
      const dst = path.join(this.wt, rel);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
        this.linked.push(rel);
      } catch {
        // Linking can fail (permissions, filesystems); the check simply runs
        // without it, exactly as before this existed.
      }
    }
    // A directory a setup declares as its cache is the check's prerequisite
    // even when its name is unusual (dist/, .venv/, target/).
    return this.linked;
  }

  // Tell the sandbox which cache directories the claims in this run will need,
  // so a setup that creates one is visible to the checks that follow it.
  addDeps(dirs) {
    this.extraDeps = [...new Set([...(this.extraDeps || []), ...dirs])];
    return this.linkDeps();
  }

  get cwd() {
    return this.mode === 'worktree' ? this.cwdBase : this.root;
  }

  // Where a project's own binaries live. npm, pnpm, yarn and pip all put these
  // on PATH for the commands they run; a check spawned from a plain shell gets
  // none of it, so `mocha test/` — a perfect description of how to run the
  // suite — exits 127 while `npm test` passes. Found on a real repo, where the
  // failure looked like a broken test suite instead of a missing PATH entry.
  localBins() {
    const dirs = [];
    for (const cwd of [this.cwd, this.wt]) {
      if (!cwd) continue;
      for (const rel of ['node_modules/.bin', '.venv/bin', 'venv/bin', 'vendor/bundle/bin', 'vendor/bin']) {
        const p = path.join(cwd, rel);
        if (fs.existsSync(p) && !dirs.includes(p)) dirs.push(p);
      }
    }
    return dirs;
  }

  exec(cmd, { timeoutMs = 60000 } = {}) {
    // Checks must not inherit test-runner context from the parent process:
    // NODE_TEST_CONTEXT changes node:test CLI behavior (e.g. reporter flags
    // silently stop erroring), which would corrupt verify results.
    const env = { ...process.env, MANUAL_ROOT: this.root, MANUAL_SANDBOX: this.mode };
    delete env.NODE_TEST_CONTEXT;
    const bins = this.localBins();
    if (bins.length) env.PATH = [...bins, env.PATH || ''].join(path.delimiter);
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
      // Remove our own links before the worktree is torn down.
      //
      // Found by a test that verified twice: the second verify reported a
      // missing dependency even though the install had succeeded, because the
      // first teardown emptied the *target* of the node_modules link. On
      // Windows a junction is followed by a recursive delete — so removing the
      // worktree deleted the developer's node_modules contents, leaving the
      // directory present and empty, which is the worst kind of failure: the
      // sandbox appears to work, and the repo is broken afterwards. The links
      // are ours, so we unlink them ourselves while the target is untouched.
      for (const rel of this.linked || []) {
        unlinkLink(path.join(this.wt, rel));
      }
      spawnSync('git', ['-C', this.root, 'worktree', 'remove', '--force', this.wt], {
        encoding: 'utf8',
      });
      // Belt and braces: anything the worktree still contains is now real
      // files, so a recursive delete cannot reach outside it.
      fs.rmSync(this.wt, { recursive: true, force: true });
      this.linked = [];
      this.wt = null;
      this.mode = 'inplace';
    }
  }
}
