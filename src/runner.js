import { hostname } from 'node:os';
import { evidenceDigest } from './hash.js';
import { evaluateExpr } from './expr.js';
import { Sandbox } from './sandbox.js';
import { nowIso } from './util.js';

// Executes a claim's check and interprets the result by kind.
// States: fresh | stale | broken | blocked | unknown.

export async function runCheck(claim, root, { sandbox, timeoutMs }) {
  const { check } = claim;
  const fm = claim.fm;

  if (check.expr && !check.run) {
    const r = evaluateExpr(root, check.expr);
    return { ...r, ok: r.ok && r.value === true }; // spread first: ok must not be clobbered
  }

  const sb = sandbox || (await new Sandbox(root).enter());
  const own = !sandbox;
  try {
    if (!check.run) return { ok: false, error: 'no executable check' };
    const t0 = Date.now();
    const r = sb.exec(check.run, { timeoutMs: timeoutMs || fm.check?.expect?.max_ms || 60000 });
    const ms = Date.now() - t0;
    const expect = fm.check?.expect || {};
    const out = r.stdout + r.stderr;

    let ok = r.exit === (expect.exit ?? 0);
    if (ok && expect.stdout_matches) {
      ok = new RegExp(expect.stdout_matches, 'm').test(r.stdout);
    }
    if (ok && expect.stderr_matches) {
      ok = new RegExp(expect.stderr_matches, 'm').test(r.stderr);
    }
    if (ok && expect.max_ms && ms > expect.max_ms) ok = false;

    return {
      ok,
      value: r.exit,
      exit: r.exit,
      ms,
      stdout: out.slice(0, 4000),
      expect,
      sandboxMode: sb.mode,
    };
  } finally {
    if (own) await sb.exit();
  }
}

// Pure promotion/demotion rule, exported for tests.
export function promoteTier(tier, passes, distinctMachines) {
  if (tier === 'ghost' || tier === 'unknown') return 'bronze';
  if (tier === 'bronze' && passes >= 1) return 'silver';
  if (tier === 'silver' && passes >= 5 && distinctMachines >= 2) return 'gold';
  return tier;
}

// Interpretation matrix per kind (spec: broken meaning depends on kind).
export function interpret(claim, result) {
  const kind = claim.fm.kind;
  if (!result.ok) {
    if (kind === 'trap') return { state: 'broken', note: 'gotcha no longer reproduces' };
    return { state: 'broken', note: result.error || `exit ${result.exit ?? '?'}` };
  }
  return { state: 'fresh', note: result.ms != null ? `${result.ms}ms` : 'ok' };
}

export async function verifyOne(claim, root, state, { sandbox, timeoutMs } = {}) {
  const t0 = Date.now();
  let result;
  try {
    result = await runCheck(claim, root, { sandbox, timeoutMs });
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  const { state: st, note } = interpret(claim, result);

  const prev = state.stamp(claim.fm.id);
  let tier = prev?.tier || 'bronze';
  const host = hostname();
  const machines = { ...(prev?.machines || {}) };
  let passes = prev?.passes || 0;
  if (st === 'fresh') {
    passes += 1;
    machines[host] = (machines[host] || 0) + 1;
    tier = promoteTier(tier, passes, Object.keys(machines).length);
  } else if (st === 'broken') {
    tier = { gold: 'silver', silver: 'bronze', bronze: 'bronze' }[tier] || 'bronze';
    // Broken trust is re-earned: pass history resets, including machines.
    passes = 0;
    for (const k of Object.keys(machines)) delete machines[k];
  }

  const stamp = state.set(claim.fm.id, {
    state: st,
    tier,
    passes,
    machines,
    digest: claim.digest,
    files: claim.fileCount,
    measured_ms: result.ms ?? null,
    note,
    origin: claim.fm.provenance?.origin || 'authored',
    author: claim.fm.provenance?.author || null,
  });
  state.pushHistory({
    id: claim.fm.id,
    state: st,
    at: nowIso(),
    ms: result.ms ?? null,
  });
  return { claim, result, stamp, elapsed: Date.now() - t0 };
}
