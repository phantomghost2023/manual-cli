import { spawnSync } from 'node:child_process';
import { matchAny } from './glob.js';
import { verifyOne } from './runner.js';
import { loadManual } from './claims.js';

// Enforcement: policy claims compile to pre-commit / PR gates.
// The claim's check IS the gate — enforcement and documentation share one
// source of truth and cannot drift apart.

function stagedPaths(root) {
  const r = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
  if (r.status !== 0) return null; // not a git repo or git missing: gate everything
  return (r.stdout || '').split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
}

export async function enforce(root, state, { stage = 'pre-commit' } = {}) {
  const { claims, errors } = loadManual(root);
  const failures = [];
  const ran = [];

  const staged = stage === 'pre-commit' ? stagedPaths(root) : null;

  for (const cl of claims) {
    if (cl.fm.kind !== 'policy') continue;
    const enf = cl.fm.check?.enforce || cl.fm.enforce;
    if (!enf || (enf.stage && enf.stage !== stage)) continue;
    if (stage === 'pre-commit') {
      // Only fire when staged files intersect the policy's paths; if we can't
      // read the index, fall back to gating everything.
      if (staged && staged.length > 0 && !matchAny(enf.paths || cl.fm.applies_to || ['**'], staged)) {
        continue;
      }
    }
    ran.push(cl.fm.id);
    const { stamp } = await verifyOne(cl, root, state, { timeoutMs: 120000 });
    // Anything that is not fresh fails the gate. Treating only `broken` as a
    // failure let a `blocked` policy — a dependency that is not fresh, or a
    // prerequisite that could not be installed — pass a pre-commit gate
    // silently, which is a gate that reports success for a check it never ran.
    if (stamp.state !== 'fresh') {
      const why = stamp.state === 'blocked' ? `blocked — ${stamp.note}` : stamp.note;
      failures.push({ id: cl.fm.id, severity: enf.severity || 'block', note: why });
    }
  }
  return { ran, failures, errors };
}
