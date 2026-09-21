import { loadManual, loadConfig } from './claims.js';
import { evidenceDigest } from './hash.js';
import { parseTtl } from './util.js';
import { verifyOne } from './runner.js';
import { Sandbox } from './sandbox.js';
import { c } from './color.js';
import { changedFiles, findBase, selectForDiff } from './diff.js';

// Verify orchestrator: dependency resolution, digest gating, TTL, execution order.

function topoOrder(claims) {
  const byId = new Map(claims.map((cl) => [cl.fm.id, cl]));
  const order = [];
  const seen = new Set();
  const visit = (cl, stack) => {
    const id = cl.fm.id;
    if (seen.has(id)) return;
    if (stack.has(id)) return; // cycle: tolerate, verify in file order
    stack.add(id);
    for (const d of cl.fm.depends_on ?? []) {
      const dep = byId.get(d.id);
      if (dep) visit(dep, stack);
    }
    stack.delete(id);
    seen.add(id);
    order.push(cl);
  };
  for (const cl of claims) visit(cl, new Set());
  return order;
}

function depState(claim, byId, stamps) {
  for (const d of claim.fm.depends_on ?? []) {
    const s = stamps[d.id]?.state;
    if (s === undefined || s === 'unknown') return 'unknown';
    if (d.required !== false && s !== 'fresh') return s; // broken/stale/blocked
  }
  return null;
}

export async function verify(root, opts = {}) {
  const { claims, errors } = loadManual(root);
  const config = loadConfig(root);
  const state = opts.state; // provided by CLI (owns save)
  const force = opts.force || false;

  // Digest claims up front (cheap: hashing only; deduped per evidence spec).
  const digestCache = new Map();
  for (const cl of claims) {
    const d = evidenceDigest(root, cl.fm.evidence || {}, state.salt, digestCache);
    cl.digest = d.digest;
    cl.fileCount = d.files;
  }

  // `only` narrows the run to named claims (used after a proposal is accepted,
  // so the check the proposal changed is the one that has to prove itself) plus
  // their transitive dependencies: a claim whose dependencies are unstamped or
  // stale would report `blocked`, which says nothing about the claim itself.
  let pool = claims;
  if (opts.only?.length) {
    const byId = new Map(claims.map((cl) => [cl.fm.id, cl]));
    const want = new Set();
    const walk = (id) => {
      if (want.has(id) || !byId.has(id)) return;
      want.add(id);
      for (const d of byId.get(id).fm.depends_on ?? []) walk(d.id);
    };
    for (const id of opts.only) walk(id);
    pool = claims.filter((cl) => want.has(cl.fm.id));
  }
  const ordered = topoOrder(
    opts.diff
      ? selectForDiff(pool, changedFiles(root, opts.diff === true ? findBase(root) : opts.diff))
      : pool,
  );
  const results = [];
  let sharedSandbox = null;

  for (const cl of ordered) {
    const id = cl.fm.id;
    const prev = state.stamp(id);

    // Dependency gate.
    const dep = depState(cl, orderedById(ordered), state.data.stamps);
    if (dep) {
      results.push({
        claim: cl,
        stamp: state.set(id, { state: 'blocked', tier: prev?.tier || 'bronze', note: `dependency ${dep}` }),
        skipped: true,
      });
      continue;
    }

    // Digest gate: skip when evidence unchanged, stamp fresh, and within TTL.
    const ttlMs = parseTtl(cl.fm.ttl);
    const age = prev?.verified_at ? Date.now() - Date.parse(prev.verified_at) : Infinity;
    const digestSame = prev?.digest === cl.digest;
    if (!force && digestSame && prev?.state === 'fresh' && (!ttlMs || age < ttlMs)) {
      results.push({ claim: cl, stamp: prev, skipped: true });
      continue;
    }

    if (!sharedSandbox) sharedSandbox = await new Sandbox(root).enter();
    const r = await verifyOne(cl, root, state, {
      sandbox: sharedSandbox,
      timeoutMs: (config.verify.default_timeout_s || 60) * 1000,
    });
    results.push(r);
  }

  if (sharedSandbox) await sharedSandbox.exit();
  return { claims, errors, results, config };
}

function orderedById(ordered) {
  const m = new Map();
  for (const cl of ordered) m.set(cl.fm.id, cl);
  return m;
}

export function printVerifyReport(res) {
  const icon = { fresh: '✅', stale: '🕰️', broken: '❌', blocked: '🚫', unknown: '❔' };
  const color = {
    fresh: c.green, stale: c.amber, broken: c.red, blocked: c.grey, unknown: c.grey,
  };
  for (const r of res.results) {
    const s = r.stamp;
    const line = `${icon[s.state] || '❔'} ${r.claim.fm.id.padEnd(34)} ${color[s.state] ? color[s.state](s.state.padEnd(7)) : s.state}  ${s.note || ''}`;
    console.log(line);
  }
  const counts = {};
  for (const r of res.results) counts[r.stamp.state] = (counts[r.stamp.state] || 0) + 1;
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  console.log(c.bold(`\n${res.results.length} claims: ${parts.join(', ')}`));
  if (res.errors.length) {
    console.log(c.red('\nload errors:'));
    for (const e of res.errors) console.log(c.red(`  - ${e}`));
  }
  return counts.broken ? 1 : 0;
}
