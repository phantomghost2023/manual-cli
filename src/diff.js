import { spawnSync } from 'node:child_process';
import { matchAny } from './glob.js';

// Diff mode: select claims relevant to a git diff, plus dependency closure
// of anything selected, plus (optionally) all policy claims.

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

// Changed files between two refs, or working tree vs a ref (default HEAD).
export function changedFiles(root, base = 'HEAD') {
  const out = new Set();
  for (const f of git(root, ['diff', '--name-only', base])) out.add(f.replace(/\\/g, '/'));
  for (const f of git(root, ['diff', '--cached', '--name-only'])) out.add(f.replace(/\\/g, '/'));
  // untracked files count as changed too
  for (const f of git(root, ['ls-files', '--others', '--exclude-standard'])) out.add(f.replace(/\\/g, '/'));
  return [...out];
}

export function selectForDiff(claims, files, { includePolicies = true } = {}) {
  const selected = new Set();
  for (const cl of claims) {
    const fm = cl.fm;
    const isPolicy = fm.kind === 'policy';
    const relevant = files.length > 0 && matchAny(fm.applies_to || ['**'], files);
    if ((relevant && !isPolicy) || (includePolicies && isPolicy) || fm.verify === 'always') {
      selected.add(fm.id);
    }
  }
  // dependency closure: verify anything a selected claim depends on
  const byId = new Map(claims.map((c) => [c.fm.id, c]));
  const queue = [...selected];
  while (queue.length) {
    const id = queue.pop();
    const cl = byId.get(id);
    for (const d of cl?.fm.depends_on ?? []) {
      if (!selected.has(d.id) && byId.has(d.id)) {
        selected.add(d.id);
        queue.push(d.id);
      }
    }
  }
  return claims.filter((cl) => selected.has(cl.fm.id));
}

export function findBase(root, explicit) {
  if (explicit) return explicit;
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (git(root, ['rev-parse', '--verify', ref]).length > 0) return ref;
  }
  return 'HEAD~1';
}
