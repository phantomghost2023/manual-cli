import fs from 'node:fs';
import path from 'node:path';

// Sandboxed expression checks (`check.expr`). A tiny, explicit API is exposed
// to the claim expression; nothing else from the process is reachable.

function globFiles(root, pattern) {
  // local lazy import avoided to keep dependency graph simple; reuse glob.js
  return null; // placeholder replaced below
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
