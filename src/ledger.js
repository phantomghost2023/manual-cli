import fs from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { nowIso } from './util.js';

// Cross-machine trust.
//
// state.json is machine-local and gitignored, which means trust earned on one
// laptop is invisible everywhere else — so the gold tier (>=5 passes across >=2
// machines) could never promote, and every recovery timeline was one machine's
// story. The ledger is the portable half: a git-tracked JSONL file of the
// verify outcomes that actually change trust.
//
// It is deliberately not a log of every run. A line is appended only when the
// claim's state changes, when a machine verifies a claim for the first time, or
// when a claim crosses the pass milestone that promotion depends on. Those are
// exactly the events another machine needs to compute the same tier.

export const GOLD_PASSES = 5;
export const GOLD_MACHINES = 2;

export function ledgerPath(root) {
  // MANUAL_MACHINE lets a CI container identify itself instead of inheriting
  // the host's name from every job on the same runner pool.
  return path.join(root, '.manual', 'ledger.jsonl');
}

export function machineName() {
  return process.env.MANUAL_MACHINE || hostname();
}

export function readLedger(root) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath(root), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // A malformed line is ignored rather than fatal: the ledger is a record,
      // and refusing to verify because a record is corrupt would be backwards.
    }
  }
  return out;
}

// Trust earned across every machine that has ever written to the ledger.
export function ledgerStats(root, id) {
  const entries = readLedger(root).filter((e) => e.id === id);
  const machines = new Set();
  let passes = 0;
  let last = null;
  for (const e of entries) {
    if (e.machine) machines.add(e.machine);
    if (typeof e.passes === 'number' && e.passes > passes) passes = e.passes;
    if (!last || String(e.at) > String(last.at)) last = e;
  }
  return { passes, machines: [...machines].sort(), entries: entries.length, last };
}

export function allLedgerStats(root) {
  const map = new Map();
  for (const e of readLedger(root)) {
    if (!e.id) continue;
    const cur = map.get(e.id) || { passes: 0, machines: new Set(), last: null, entries: 0 };
    if (e.machine) cur.machines.add(e.machine);
    if (typeof e.passes === 'number' && e.passes > cur.passes) cur.passes = e.passes;
    if (!cur.last || String(e.at) > String(cur.last.at)) cur.last = e;
    cur.entries += 1;
    map.set(e.id, cur);
  }
  return new Map([...map.entries()].map(([id, v]) => [id, { ...v, machines: [...v.machines].sort() }]));
}

// Decide which outcomes are worth recording, and write them in one append.
// `results` are verify results carrying the new stamp and the stamp it replaced.
export function recordLedger(root, results, { at = nowIso(), machine = machineName(), quiet = true } = {}) {
  const written = [];
  for (const r of results) {
    const stamp = r.stamp;
    if (!stamp || r.skipped) continue;
    const prev = r.prevStamp || null;
    const reasons = [];
    if (prev && prev.state !== stamp.state) reasons.push('state-change');
    if (!prev && stamp.state === 'fresh') reasons.push('first-verified');
    const machinesNow = Object.keys(stamp.machines || {});
    const machinesBefore = Object.keys(prev?.machines || {});
    if (stamp.state === 'fresh' && machine && !machinesBefore.includes(machine)) reasons.push('new-machine');
    const passes = stamp.passes || 0;
    const prevPasses = prev?.passes || 0;
    if (passes >= GOLD_PASSES && prevPasses < GOLD_PASSES) reasons.push('pass-milestone');
    if (reasons.length === 0) continue;
    written.push({
      at,
      machine,
      id: stamp.id,
      state: stamp.state,
      tier: stamp.tier,
      ms: stamp.measured_ms ?? null,
      passes,
      machines: machinesNow.sort(),
      reason: reasons.join(','),
    });
  }
  if (written.length === 0) return [];
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, written.map((w) => JSON.stringify(w)).join('\n') + '\n');
  if (!quiet) for (const w of written) console.log(`ledger: ${w.id} ${w.state} (${w.reason})`);
  return written;
}

// Merge ledger-earned trust into the local counters. Passes are maxed rather
// than summed, because a single run can appear in both records.
export function mergeTrust(local, ledger) {
  const machines = { ...(local?.machines || {}) };
  for (const m of ledger?.machines || []) if (!machines[m]) machines[m] = 1;
  return {
    passes: Math.max(local?.passes || 0, ledger?.passes || 0),
    machines,
  };
}
