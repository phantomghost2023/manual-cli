// Multi-machine timing history, from the ledger.
//
// state.json's history is one machine's story: the laptop that wrote it. The
// committed ledger carries the same timing for every machine that ever changed
// the claim's trust state — including CI runners, which are usually *slower*
// than a dev machine and are usually the place a calibrated bound first fails.
// A bound computed without it describes the fastest machine in the room.
//
// This module composes with src/observe.js: the ledger's timing events for a
// claim are merged into the local series, deduplicated against it, and kept
// attributable to their machine, so the proposal can say whose story the bound
// now tells. The ledger is not a full log — it records state changes, first
// verifications and milestones — so entries are sparse by design; what it has,
// every machine can see.

import { readLedger } from './ledger.js';
import { machineName } from './ledger.js';

const hasTiming = (e) => e && typeof e.ms === 'number' && e.ms > 0;

// Ledger timing events for one claim, most recent last, with machine names.
export function ledgerEvents(root, id, n = 200) {
  return readLedger(root)
    .filter((e) => e.id === id && hasTiming(e))
    .slice(-n)
    .map((e) => ({
      at: e.at,
      ms: e.ms,
      machine: e.machine || 'unknown-machine',
      state: e.state,
    }));
}

// Ledger entries that carry *no* duration: runs stopped at the bound itself
// (verify stamps such runs `blocked — untested, not false`). A timed-out CI run
// is the strongest raise signal there is, and it must not need a duration to be
// heard. Only other machines' entries count here — this machine's bounded runs
// are already visible to the relax path through state.json.
export function boundedLedgerRuns(root, id, n = 200) {
  return readLedger(root)
    .filter((e) => e.id === id && !hasTiming(e) && e.machine && e.machine !== machineName())
    .slice(-n)
    .map((e) => ({ at: e.at, machine: e.machine, state: e.state, note: e.note || null }));
}

// Merge the ledger's view into the local series. The local history is the
// truth for this machine — so it is tagged with this machine's name, and the
// ledger's entries *from this same machine* are dropped in its favor: they
// would otherwise look like a second machine (the local entries of an older
// run carry no machine field at all) and invent a spread that does not exist.
// Remaining cross-machine duplicates are dropped by (at, ms).
export function mergedEvents(state, root, id, n = 20) {
  const local = state
    .history(500)
    .filter((h) => h.id === id && hasTiming(h))
    .map((h) => ({ ...h, machine: machineName() }));
  const localKeys = new Set(local.map((h) => `${String(h.at)}|${h.ms}`));
  const here = machineName();
  const foreign = ledgerEvents(root, id, 200).filter(
    (e) => e.machine !== here && !localKeys.has(`${String(e.at)}|${e.ms}`),
  );
  return [...local, ...foreign].slice(-n);
}

// The slowest machine's share of the merged series. Returns null while there
// is nothing multi-machine to say: one machine in the ledger, or no meaningful
// separation. The comparator is the slowest machine's p90 against every other
// machine's p90 — not against the pooled p90, which for small samples is just
// the maximum (with n<=10, nearest-rank p90 IS the max), so the slowest machine
// always "equals" it and nothing would ever separate.
export function slowestMachineShare(events) {
  if (!events || events.length === 0) return null;
  const byMachine = new Map();
  for (const e of events) {
    const cur = byMachine.get(e.machine) || [];
    cur.push(e);
    byMachine.set(e.machine, cur);
  }
  if (byMachine.size < 2) return null;
  const machines = [...byMachine.entries()]
    .map(([machine, evts]) => ({ machine, p90: quantileP90(evts.map((e) => e.ms)) }))
    .sort((a, b) => b.p90 - a.p90);
  const worst = machines[0];
  const rest = machines.slice(1);
  const restP90 = quantileP90(rest.flatMap((m) => byMachine.get(m.machine).map((e) => e.ms)));
  if (restP90 <= 0 || worst.p90 <= restP90 * 1.2) return null;
  return { machine: worst.machine, p90: worst.p90, othersP90: restP90, samples: events.length };
}

function quantileP90(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1))];
}
