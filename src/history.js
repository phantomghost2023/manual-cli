import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { splitFrontmatter } from './md.js';
import { parseClaim, loadManual } from './claims.js';

// Time travel: reconstruct the manual as it existed at a git ref, filtered to
// claims whose lifecycle was accepted at that point in history.

function git(root, args, opts = {}) {
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  return r;
}

export function listManualCommits(root, limit = 50) {
  const r = git(root, [
    'log', `--max-count=${limit}`, '--pretty=format:%H %cI', '--', '.manual/claims',
  ]);
  if (r.status !== 0) return [];
  return (r.stdout || '')
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date] = line.split(' ');
      return { sha, date };
    });
}

// Read every claim file under .manual/claims at a given ref (working tree if ref is null).
export function manualAt(root, ref = null) {
  if (!ref) return loadManual(root);
  const spec = `${ref}:.manual/claims`;
  const r = git(root, ['ls-tree', '--name-only', spec]);
  if (r.status !== 0) {
    throw new Error(`no .manual/claims/ at ref ${ref} — the manual did not exist yet`);
  }
  const names = (r.stdout || '')
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.endsWith('.md'));

  const claims = [];
  const errors = [];
  for (const name of names) {
    const f = git(root, ['show', `${spec}/${name}`]);
    const text = f.status === 0 ? (f.stdout || '').toString('utf8') : '';
    const file = path.join(root, '.manual', 'claims', name);
    try {
      const parsed = parseClaim(text, file);
      claims.push(parsed);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { claims, errors };
}

// Claims considered TRUE at a ref: file existed and lifecycle was not
// candidate/retired at that time, and (if present) valid_from <= ref < valid_until.
export function claimsAtRef(root, ref) {
  const { claims, errors } = manualAt(root, ref);
  const kept = [];
  const retired = [];
  for (const cl of claims) {
    const lf = cl.fm.lifecycle || 'accepted';
    if (lf === 'retired' || lf === 'candidate') { retired.push(cl.fm.id); continue; }
    kept.push(cl);
  }
  return { claims: kept, retired, errors };
}

// Resolve a ref to a commit date for stamping briefs.
export function refDate(root, ref) {
  const r = git(root, ['show', '-s', '--format=%cI', ref]);
  return r.status === 0 ? (r.stdout || '').toString('utf8').trim() : null;
}
