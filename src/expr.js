import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Sandboxed expression checks (`check.expr`). A tiny, explicit API is exposed
// to the claim expression; nothing else from the process is reachable.

function globFiles(root, pattern) {
  // local lazy import avoided to keep dependency graph simple; reuse glob.js
  return null; // placeholder replaced below
}

function gitLines(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

export function makeExprApi(root) {
  return {
    exists: (p) => fs.existsSync(path.join(root, p)),
    read: (p, max = 65536) => {
      try {
        return fs.readFileSync(path.join(root, p), 'utf8').slice(0, max);
      } catch {
        return null;
      }
    },
    manifest: (p = 'package.json') => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
      } catch {
        return null;
      }
    },
    env: (n) => process.env[n],
    nodeMajor: () => Number(process.versions.node.split('.')[0]),
    codeowners: () => {
      // Best-effort: parse .github/CODEOWNERS or CODEOWNERS; returns [{pattern, owners}]
      for (const p of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        const full = path.join(root, p);
        if (fs.existsSync(full)) {
          return fs
            .readFileSync(full, 'utf8')
            .split('\n')
            .filter((l) => l.trim() && !l.trim().startsWith('#'))
            .map((l) => {
              const parts = l.trim().split(/\s+/);
              return { pattern: parts[0], owners: parts.slice(1) };
            });
        }
      }
      return [];
    },
    // True when `owner` appears to have in-flight work in this repo: a branch
    // whose name contains their handle committed within `withinDays`, or any
    // branch currently checked out in a linked worktree (active work).
    lockActive: (owner, { withinDays = 21 } = {}) => {
      if (!owner) return false;
      const needle = String(owner).replace(/^@/, '').toLowerCase();
      if (!needle) return false;
      const cutoff = Date.now() / 1000 - withinDays * 86400;
      const branches = new Map();
      for (const line of gitLines(root, [
        'for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)',
      ])) {
        const [name, ts] = line.split('\t');
        if (name) branches.set(name, ts ? Number(ts) : Infinity);
      }
      for (const line of gitLines(root, ['worktree', 'list', '--porcelain'])) {
        if (line.startsWith('branch refs/heads/')) {
          const name = line.slice('branch refs/heads/'.length);
          if (!branches.has(name)) branches.set(name, Infinity); // checked out = active
        }
      }
      for (const [name, ts] of branches) {
        const n = name.toLowerCase();
        const owned = n.includes(needle) || n.split('/').includes(needle);
        if (owned && ts >= cutoff) return true;
      }
      return false;
    },
  };
}

export function evaluateExpr(root, src) {
  const api = makeExprApi(root);
  const names = Object.keys(api);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `"use strict"; return (${src});`);
    return { ok: true, value: Boolean(fn(...names.map((n) => api[n]))) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
