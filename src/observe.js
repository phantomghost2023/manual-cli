import fs from 'node:fs';
import path from 'node:path';
import { nowIso, parseTtl } from './util.js';
import { loadManual } from './claims.js';
import { readInbox } from './inbox.js';

// The automated flywheel: read verify stamps + measurement history from
// state.json, and write inbox candidates when reality diverges from claims.
//
//  - Tighten: the claim's max_ms bound is far above what runs actually cost.
//  - Relax:   the claim broke on its own max_ms bound; propose headroom.
//
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

// Exported for tests and for `history`, which wants the same numbers.
export function seriesStats(state, id, n = SAMPLES) {
  const ms = state
    .history(500)
    .filter((h) => h.id === id && typeof h.ms === 'number' && h.ms > 0)
    .slice(-n)
    .map((h) => h.ms);
  if (ms.length === 0) return { samples: 0, ms: [], p50: null, p90: null, max: null };
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    samples: ms.length,
    ms,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    max: sorted[sorted.length - 1],
  };
}

// Tighten: a bound that keeps headroom over the median AND the tail AND the
// worst run actually observed on this machine.
export function proposeBound({ p50, p90, max }) {
  return roundBound(Math.max((p50 || 0) * 3, (p90 || 0) * 1.5, (max || 0) * 1.1));
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
    const bound = cl.fm.check?.expect?.max_ms || null;

    // Tighten needs a stable picture: at least 3 measured runs.
    if (st.samples >= 3 && bound && st.p50 !== null && st.p50 < bound * 0.5) {
      const proposed = proposeBound(st);
      if (proposed < bound) {
        proposals.push({
          kind: 'tighten',
          id,
          measured: st.p50,
          p50: st.p50,
          p90: st.p90,
          max: st.max,
          bound,
          proposed,
          samples: st.samples,
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
    const body =
      p.kind === 'tighten'
        ? `Recent runs: p50 ${p.p50}ms, p90 ${p.p90}ms, worst ${p.max}ms over ${p.samples} samples. The claim allows ${p.bound}ms.
Propose tightening to ${p.proposed}ms — at least 3x the median, 1.5x the 90th percentile, and
1.1x the worst run seen here — so a real slowdown fails the claim while ordinary
variance does not.`
        : `A run measured ${p.measured}ms against a ${p.bound}ms bound and broke the claim.
History: p50 ${p.p50}ms, p90 ${p.p90}ms, worst ${p.max}ms over ${p.samples} samples.
Propose relaxing to ${p.proposed}ms to stop the flapping while still catching real regressions.`;
    const fm = `---
schema: manual/v1
id: ${cid}
kind: candidate
proposes:
  update: ${p.id}
  patch:
    check.expect.max_ms: ${p.proposed}
observation:
  at: ${nowIso()}
  by: agent:manual-cli
  samples: ${p.samples}
  measured_ms: ${p.measured}
  p50_ms: ${p.p50}
  p90_ms: ${p.p90}
  worst_ms: ${p.max}
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
