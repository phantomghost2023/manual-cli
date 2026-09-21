import { freemem, loadavg } from 'node:os';
import { evidenceDigest } from './hash.js';
import { evaluateExpr } from './expr.js';
import { Sandbox } from './sandbox.js';
import { nowIso } from './util.js';
import { ledgerStats, mergeTrust, machineName } from './ledger.js';

// Executes a claim's check and interprets the result by kind.
// States: fresh | stale | broken | blocked | unknown.

export async function runCheck(claim, root, { sandbox, timeoutMs }) {
  const { check } = claim;
  const fm = claim.fm;

  if (check.expr && !check.run) {
    const t0 = Date.now();
    const r = evaluateExpr(root, check.expr);
    // Expr checks are measured too: without a runtime there is no trend line
    // and no flywheel signal for the claims that are cheapest to run.
    return { ...r, ms: Date.now() - t0, ok: r.ok && r.value === true }; // spread first: ok must not be clobbered
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
      // Parsed from the *untruncated* output: the slowest test is exactly the
      // line most likely to be past the 4000-char cut.
      timings: parseTestTimings(out),
      expect,
      sandboxMode: sb.mode,
    };
  } finally {
    if (own) await sb.exit();
  }
}

// Per-test timings out of a check's output, when the runner emits them.
// Without this, a command claim's runtime is a single opaque number: you can
// see that the suite got slower but not that one test is 90% of it. Parses the
// two shapes that actually show up — node's TAP reporter ("# Subtest: name"
// followed by an indented "duration_ms: N") and the spec reporters used by
// mocha / jest / node's default (`✔ name (123ms)`).
export function parseTestTimings(out) {
  if (!out) return null;
  const found = [];
  let pending = null;
  for (const line of out.split('\n')) {
    const sub = /^\s*# Subtest:\s*(.+?)\s*$/.exec(line);
    if (sub) {
      pending = sub[1];
      continue;
    }
    const tap = /^\s+duration_ms:\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (tap && pending) {
      found.push({ name: pending, ms: Number(tap[1]) });
      pending = null;
      continue;
    }
    const spec = /^\s*[✔✓√]\s+(.+?)\s+\((\d+(?:\.\d+)?)\s*ms\)\s*$/.exec(line);
    if (spec) found.push({ name: spec[1], ms: Number(spec[2]) });
  }
  if (found.length === 0) return null;
  const total = found.reduce((n, t) => n + t.ms, 0);
  const slowest = found.reduce((a, b) => (b.ms > a.ms ? b : a));
  return { slowest, total: Math.round(total), count: found.length };
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

  // Environment at the moment of measurement. Without it, a spiky series can
  // only be respected (widen the bound) — it cannot be explained ("the slow
  // runs were the ones with 200MB free instead of 3GB").
  const env = {
    freemem_mb: Math.round(freemem() / 1048576),
    loadavg1: Number(loadavg()[0]?.toFixed?.(2) ?? 0),
  };
  const prev = state.stamp(claim.fm.id);
  let tier = prev?.tier || 'bronze';
  const host = machineName();
  // Trust earned on other machines lives in the git-tracked ledger; merge it so
  // a pass count is the repository's history, not this checkout's.
  const merged = mergeTrust({ passes: prev?.passes || 0, machines: prev?.machines || {} }, ledgerStats(root, claim.fm.id));
  const machines = merged.machines;
  let passes = merged.passes;
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
    env,
    origin: claim.fm.provenance?.origin || 'authored',
    author: claim.fm.provenance?.author || null,
  });
  state.pushHistory({
    id: claim.fm.id,
    state: st,
    at: nowIso(),
    ms: result.ms ?? null,
    ...env,
    // Whether this run followed a change to the claim's evidence. Caches and
    // compiled artifacts are invalidated by exactly that, so it is the cheapest
    // available explanation for a spike.
    digest_changed: prev && prev.digest !== claim.digest ? 1 : 0,
    // Only when the runner actually reported per-test timings; absent keys
    // keep old history entries and non-test commands honest.
    ...(result.timings
      ? {
          slowest_test: result.timings.slowest.name,
          slowest_ms: Math.round(result.timings.slowest.ms),
          test_count: result.timings.count,
          test_total_ms: result.timings.total,
        }
      : {}),
  });
  return { claim, result, stamp, prevStamp: prev, elapsed: Date.now() - t0 };
}
