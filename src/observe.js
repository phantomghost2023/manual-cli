import fs from 'node:fs';
import path from 'node:path';
import { nowIso, parseTtl } from './util.js';
import { loadManual } from './claims.js';
import { readInbox } from './inbox.js';

// The automated flywheel: read verify stamps + measurement history from
// state.json, and write inbox candidates when reality diverges from claims.
//
//  - Tighten: the claim's max_ms bound is far above what runs actually cost.
//  - Raise:   a once-fast suite grew slower and the bound is about to be wrong,
//             before a legitimate run trips it and gets filed as a regression.
//  - Relax:   the claim broke on its own max_ms bound; propose headroom.
//
// Every proposal also rewrites the claim's recorded measurement. `max_ms` came
// from a single probe at init; a bound is a statement about accumulated runs, so
// the number a human reads next to it must come from the same history that
// justified the bound — otherwise the claim keeps advertising a measurement the
// tool stopped believing. Tighten, raise and relax differ only in direction:
// all three patch `check.expect.max_ms` and `observation.measured_ms` together.

// Proposed bounds respect the TAIL, not just the median. An earlier version
// proposed 3x p50, which for a spiky series (p50 9s, p90 25s, worst 47s)
// produced a bound below the 90th percentile — a claim that is guaranteed to
// flap. A bound the tool cannot keep is worse than a loose one, because a
// flapping claim teaches everyone to ignore broken claims.

const SAMPLES = 20;

// Nearest-rank quantile over an ascending array.
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

// Exported for tests and for `history`, which wants the same numbers. Events
// (not just millisecond values) are kept so the spread can be explained.
export function seriesEvents(state, id, n = SAMPLES) {
  return state
    .history(500)
    .filter((h) => h.id === id && typeof h.ms === 'number' && h.ms > 0)
    .slice(-n);
}

export function seriesStats(state, id, n = SAMPLES) {
  const events = seriesEvents(state, id, n);
  const ms = events.map((h) => h.ms);
  if (ms.length === 0) return { samples: 0, ms: [], events: [], p50: null, p90: null, max: null };
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    samples: ms.length,
    ms,
    events,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    max: sorted[sorted.length - 1],
  };
}

const median = (xs) => quantile([...xs].sort((a, b) => a - b), 0.5);

// Explain a series instead of merely summarizing it. A wide bound is a
// symptom; these are the usual causes, and naming one changes what the right
// action is (a cold-start spike wants a warm-up run, a trend wants an
// investigation, an outlier wants more samples, a low-memory correlation is a
// property of the machine rather than of the code).
export function diagnoseSeries(events) {
  const out = [];
  if (!events || events.length < 3) return out;
  const ms = events.map((e) => e.ms);
  const sorted = [...ms].sort((a, b) => a - b);
  const p90 = quantile(sorted, 0.9);
  const max = sorted[sorted.length - 1];
  const p50 = quantile(sorted, 0.5);

  // Cold start: the earliest sample dwarfs everything after it.
  const rest = ms.slice(1);
  if (rest.length >= 2 && ms[0] > median(rest) * 1.5) {
    out.push({
      kind: 'cold-start',
      text: `the first run was ${Math.round(ms[0] / median(rest))}x the median of the rest (${ms[0]}ms vs ${median(rest)}ms) — a warm-up or cache effect, not a code change`,
    });
  }

  // Trend: the second half is meaningfully slower than the first.
  const half = Math.floor(ms.length / 2);
  if (half >= 2) {
    const early = median(ms.slice(0, half));
    const late = median(ms.slice(-half));
    if (late > early * 1.3) {
      out.push({ kind: 'trend-up', text: `runs are trending slower: ${early}ms early vs ${late}ms recent (+${Math.round((late / early - 1) * 100)}%)` });
    } else if (early > late * 1.3) {
      out.push({ kind: 'trend-down', text: `runs are getting faster: ${early}ms early vs ${late}ms recent` });
    }
  }

  // A single outlier dragging the maximum far above the p90.
  if (max > p90 * 2) {
    out.push({ kind: 'outlier', text: `one run took ${max}ms while the 90th percentile is ${p90}ms — a single outlier is inflating the worst case` });
  }

  // One test dominates the run: the useful action is to look at *that* test,
  // and a bound derived from the suite total is really a bound on it.
  const withTiming = events.filter((e) => typeof e.slowest_ms === 'number' && typeof e.test_total_ms === 'number' && e.test_total_ms > 0);
  if (withTiming.length >= 2) {
    const dom = withTiming.map((e) => e.slowest_ms / e.test_total_ms);
    const share = median(dom);
    const latest = withTiming[withTiming.length - 1];
    const same = withTiming.filter((e) => e.slowest_test === latest.slowest_test).length;
    if (share >= 0.5 && same === withTiming.length) {
      out.push({
        kind: 'dominant-test',
        text: `one test dominates the run: "${latest.slowest_test}" is ${Math.round(share * 100)}% of the ${latest.test_total_ms}ms spent across ${latest.test_count} tests — cost lives there, not in the suite`,
      });
    }
  }

  // Cold cache: the slow runs are the ones that followed a change to the
  // claim's evidence, so the work being measured is artifact rebuilding.
  const changed = events.filter((e) => e.digest_changed === 1);
  const unchanged = events.filter((e) => e.digest_changed === 0 && typeof e.ms === 'number');
  if (changed.length >= 2 && unchanged.length >= 2) {
    const cold = median(changed.map((e) => e.ms));
    const warm = median(unchanged.map((e) => e.ms));
    if (cold > warm * 1.4) {
      out.push({
        kind: 'cold-cache',
        text: `runs right after the evidence changed are ${(cold / warm).toFixed(1)}x slower (${cold}ms vs ${warm}ms) — cache or artifact rebuild, not a regression`,
      });
    }
  }

  // Bimodal: a wide internal gap splitting the samples into two clusters.
  let gapAt = -1;
  let gapSize = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > gapSize) { gapSize = gap; gapAt = i; }
  }
  const span = sorted[sorted.length - 1] - sorted[0];
  if (span > 0 && gapSize > span * 0.35 && gapAt >= 2 && sorted.length - gapAt >= 2) {
    out.push({
      kind: 'bimodal',
      text: `two clusters: ${sorted[gapAt - 1]}ms or below (${gapAt} runs) versus ${sorted[gapAt]}ms or above (${sorted.length - gapAt} runs) — the check probably takes two different paths`,
    });
  }

  // Machine correlation: compare the environment of the slow third with the
  // fast third. Only claimed when the numbers actually separate.
  const withEnv = events.filter((e) => typeof e.freemem_mb === 'number' && e.freemem_mb > 0);
  if (withEnv.length >= 4) {
    const bySpeed = [...withEnv].sort((a, b) => a.ms - b.ms);
    const third = Math.max(1, Math.floor(bySpeed.length / 3));
    const fast = bySpeed.slice(0, third);
    const slow = bySpeed.slice(-third);
    const fastMem = fast.reduce((n, e) => n + e.freemem_mb, 0) / fast.length;
    const slowMem = slow.reduce((n, e) => n + e.freemem_mb, 0) / slow.length;
    if (slowMem < fastMem * 0.85) {
      out.push({
        kind: 'memory-correlation',
        text: `the slowest runs had less free memory (${Math.round(slowMem)}MB vs ${Math.round(fastMem)}MB on the fastest) — this spread may be the machine, not the code`,
      });
    }
    const withLoad = withEnv.filter((e) => typeof e.loadavg1 === 'number' && e.loadavg1 > 0);
    if (withLoad.length >= 4) {
      const byLoad = [...withLoad].sort((a, b) => a.ms - b.ms);
      const t2 = Math.max(1, Math.floor(byLoad.length / 3));
      const fastLoad = byLoad.slice(0, t2).reduce((n, e) => n + e.loadavg1, 0) / t2;
      const slowLoad = byLoad.slice(-t2).reduce((n, e) => n + e.loadavg1, 0) / t2;
      if (slowLoad > fastLoad * 1.5 && slowLoad - fastLoad > 0.5) {
        out.push({
          kind: 'load-correlation',
          text: `the slowest runs happened at higher load (${slowLoad.toFixed(1)} vs ${fastLoad.toFixed(1)} 1-min load average)`,
        });
      }
    }
  }

  if (out.length === 0) {
    out.push({ kind: 'stable', text: `no structure in the spread: ${ms.length} runs spanning ${sorted[0]}-${max}ms (p50 ${p50}ms)` });
  }
  return out;
}

// The bound a series' tail actually supports: 3x the median, 1.5x the 90th
// percentile, and 1.1x the worst run seen on this machine. One formula, two
// directions — a tighten is this number landing *below* the declared bound, a
// raise is it landing above. Separate formulas for the two directions would let
// the tool's two answers disagree about the same series.
//
// A dominant test argues against tightening at all: the bound would be
// measuring one test's mood.
export function proposeBound({ p50, p90, max }) {
  return roundBound(Math.max((p50 || 0) * 3, (p90 || 0) * 1.5, (max || 0) * 1.1));
}

// When a bound is *about* to be wrong rather than already wrong. A suite that
// drifted from 2s to 25s under a 30s bound has not broken anything yet, but it
// is one busy machine away from flapping — and a bound that only ever moves
// after a false alarm teaches everyone to ignore the alarm. Raise when the
// worst run already meets the bound, or when the 90th percentile is crowding
// it.
const RAISE_P90_SHARE = 0.75;
export function needsRaise({ p90, max }, bound) {
  return (max || 0) >= bound || (p90 || 0) > bound * RAISE_P90_SHARE;
}

// Relax: give the run that broke the claim room, and the tail room, but do not
// inflate it by 3x the median — relaxing is about the observed worst case.
export function proposeRelaxBound({ p90, max, observed }) {
  return roundBound(Math.max((observed || 0) * 2, (p90 || 0) * 1.5, (max || 0) * 1.1));
}

function roundBound(ms) {
  if (ms < 1000) return Math.max(100, Math.ceil(ms / 100) * 100);
  return Math.ceil(ms / 1000) * 1000;
}

export function planProposals(root, state) {
  const { claims } = loadManual(root);
  const proposals = [];

  for (const cl of claims) {
    const id = cl.fm.id;
    const stamp = state.stamp(id);
    if (!stamp) continue;
    const st = seriesStats(state, id);
    const diagnosis = diagnoseSeries(st.events);
    const bound = cl.fm.check?.expect?.max_ms || null;

    // Recalibration needs a stable picture: at least 3 measured runs, and a
    // bound to reason against. `supported` is what the accumulated history
    // argues for; the direction is a comparison, not a second heuristic.
    if (st.samples >= 3 && bound && st.p50 !== null) {
      const supported = proposeBound(st);
      if (supported < bound && st.p50 < bound * 0.5) {
        proposals.push({
          kind: 'tighten',
          id,
          measured: st.p50,
          p50: st.p50,
          p90: st.p90,
          max: st.max,
          bound,
          proposed: supported,
          samples: st.samples,
          diagnosis,
        });
      } else if (supported > bound && needsRaise(st, bound)) {
        // The suite grew slower than the bound without ever breaking it. Waiting
        // for the break means the first honest signal is a false alarm.
        proposals.push({
          kind: 'raise',
          id,
          measured: st.p50,
          p50: st.p50,
          p90: st.p90,
          max: st.max,
          bound,
          proposed: supported,
          samples: st.samples,
          diagnosis,
        });
      }
    }

    // Relax: a single self-inflicted break on the bound is evidence enough.
    if (cl.fm.kind === 'command' && stamp.state === 'broken' && bound) {
      const last = state.history(10).reverse().find((h) => h.id === id);
      if (last && typeof last.ms === 'number' && last.ms > bound) {
        proposals.push({
          kind: 'relax',
          id,
          measured: last.ms,
          p50: st.p50,
          p90: st.p90,
          max: Math.max(last.ms, st.max || 0),
          bound,
          proposed: proposeRelaxBound({ p90: st.p90, max: Math.max(last.ms, st.max || 0), observed: last.ms }),
          samples: st.samples,
          diagnosis,
        });
      }
    }
  }
  return proposals;
}

function candidatePath(inboxDir, kind, id) {
  const safe = id.replace(/[^a-z0-9.-]/gi, '-');
  return path.join(inboxDir, `${nowIso().slice(0, 10)}-${kind}-${safe}.md`);
}

// A candidate already sitting in the inbox can be *stale*: the evidence has
// moved on since it was written, so its proposed bound no longer matches what
// the numbers imply. writeProposals deliberately never rewrites a candidate a
// human may be reviewing, which means a stale one would otherwise block the
// corrected proposal forever, silently. Surface it instead.
export function staleProposals(root, state) {
  const plan = planProposals(root, state);
  if (plan.length === 0) return [];
  const byTarget = new Map(plan.map((p) => [p.id, p]));
  const out = [];
  // Scan what is actually in the inbox rather than guessing at filenames: real
  // candidates are written by hand, renamed, or produced by older naming rules,
  // and a stale one must be found regardless of what it is called.
  for (const cand of readInbox(root)) {
    const target = cand.proposes?.update;
    const p = target ? byTarget.get(target) : null;
    if (!p) continue;
    const inFile = cand.proposes?.patch?.['check.expect.max_ms'];
    if (typeof inFile !== 'number' || inFile === p.proposed) continue;
    out.push({
      file: cand.file,
      id: target,
      kind: p.kind,
      proposes_in_file: inFile,
      proposes_now: p.proposed,
      bound: p.bound,
      p50: p.p50,
      p90: p.p90,
      max: p.max,
      samples: p.samples,
    });
  }
  return out;
}

export function writeProposals(root, state, { quiet = false } = {}) {
  const inboxDir = path.join(root, '.manual', 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const written = [];
  for (const p of planProposals(root, state)) {
    const file = candidatePath(inboxDir, p.kind, p.id);
    if (fs.existsSync(file)) continue;
    const cid = `candidate.${p.kind}.${p.id}`.toLowerCase();
    const tail = `p50 ${p.p50}ms, p90 ${p.p90}ms, worst ${p.max}ms over ${p.samples} samples`;
    // The measurement the claim publishes, taken from the accumulated history
    // rather than from init's single probe. The tail numbers stay alongside it
    // so the derivation is auditable after the patch lands.
    const provenance = {
      'check.expect.max_ms': p.proposed,
      'observation.measured_ms': p.p50,
      'observation.max_ms': p.proposed,
      'observation.samples': p.samples,
      'observation.measured_from': 'verify history',
    };
    const why = (p.diagnosis || []).length
      ? `\nWhy the spread: ${(p.diagnosis || []).map((d) => d.text).join('; ')}.`
      : '';
    // A dominant test is the one diagnosis that changes the *action*: the bound
    // is a proxy for one test, so say so in the body a reviewer reads.
    const dom = (p.diagnosis || []).find((d) => d.kind === 'dominant-test');
    const dominant = dom
      ? `\nThe runtime is dominated by a single test, so consider fixing or splitting it rather\nthan only adjusting this bound.`
      : '';
    const recalibrated = `This also rewrites the claim's recorded measurement to ${p.p50}ms — the median of
${p.samples} runs — replacing the single probe init took the day the claim was written.`;
    const body =
      p.kind === 'tighten'
        ? `Recent runs: ${tail}. The claim allows ${p.bound}ms.${why}
Propose tightening to ${p.proposed}ms — at least 3x the median, 1.5x the 90th percentile, and
1.1x the worst run seen here — so a real slowdown fails the claim while ordinary
variance does not.${dominant}
${recalibrated}`
        : p.kind === 'raise'
          ? `Recent runs: ${tail}. The claim allows ${p.bound}ms and the tail no longer fits under it.
${p.max >= p.bound ? `The worst run (${p.max}ms) already meets the bound, so this claim is one busy machine
away from breaking on a run that is not a regression.` : `The 90th percentile (${p.p90}ms) is crowding the bound, so the next slow day trips it.`}${why}
Propose raising to ${p.proposed}ms now — before a legitimate run fails and has to be triaged as
one. If the growth is real, the code is the thing to look at; the bound only has to
stop lying about it in the meantime.${dominant}
${recalibrated}`
          : `A run measured ${p.measured}ms against a ${p.bound}ms bound and broke the claim.
History: ${tail}.${why}
Propose relaxing to ${p.proposed}ms to stop the flapping while still catching real regressions.${dominant}
${recalibrated}`;
    const fm = `---
schema: manual/v1
id: ${cid}
kind: candidate
proposes:
  update: ${p.id}
  patch:
${Object.entries(provenance).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
observation:
  at: ${nowIso()}
  by: agent:manual-cli
  samples: ${p.samples}
  measured_ms: ${p.measured}
  p50_ms: ${p.p50}
  p90_ms: ${p.p90}
  worst_ms: ${p.max}
  diagnosis: "${(p.diagnosis || []).map((d) => d.kind).join(', ') || 'none'}"
  evidence: "verify history in state.json; ${p.kind} proposal vs ${p.bound}ms bound"
review:
  needed: human-approve
---
${body}
`;
    fs.writeFileSync(file, fm);
    written.push({ file: path.basename(file), ...p });
    if (!quiet) console.log(`📝 proposed ${p.kind}: ${p.id} → max_ms ${p.proposed} (${path.basename(file)})`);
  }
  for (const s of staleProposals(root, state)) {
    if (!quiet) {
      console.log(`⚠ stale candidate: ${s.file} proposes max_ms ${s.proposes_in_file}, but the evidence now supports ${s.proposes_now} (p90 ${s.p90}ms, worst ${s.max}ms)`);
      console.log('  review it, then delete it so observe can write the corrected proposal');
    }
  }
  if (!quiet && written.length === 0) console.log('no divergence between measurements and claim bounds');
  return written;
}
