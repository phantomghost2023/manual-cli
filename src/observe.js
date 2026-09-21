import fs from 'node:fs';
import path from 'node:path';
import { nowIso, parseTtl } from './util.js';
import { loadManual } from './claims.js';

// The automated flywheel: read verify stamps + measurement history from
// state.json, and write inbox candidates when reality diverges from claims.
//
//  - Tighten: p50 of recent runs is far under the claim's max_ms bound.
//  - Relax:   the claim broke on its own max_ms bound; propose headroom.

const SAMPLES = 5;

function p50(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function recentMs(state, id) {
  return state
    .history(200)
    .filter((h) => h.id === id && typeof h.ms === 'number' && h.ms > 0)
    .slice(-SAMPLES)
    .map((h) => h.ms);
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
    const ms = recentMs(state, id);
    const bound = cl.fm.check?.expect?.max_ms || null;
    const median = p50(ms);

    // Tighten needs a stable picture: at least 3 measured runs.
    if (ms.length >= 3 && bound && median !== null && median < bound * 0.5) {
      const proposed = roundBound(Math.max(median * 3, 100));
      if (proposed < bound) {
        proposals.push({
          kind: 'tighten',
          id,
          measured: median,
          bound,
          proposed,
          samples: ms.length,
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
          bound,
          proposed: roundBound(last.ms * 2),
          samples: ms.length,
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
        ? `Recent runs put p50 at ${p.measured}ms over ${p.samples} samples; the claim allows ${p.bound}ms.
Propose tightening to ${p.proposed}ms (~3x headroom) so a future slowdown fails the claim instead of hiding.`
        : `A recent run measured ${p.measured}ms against a ${p.bound}ms bound and broke the claim.
Propose relaxing to ${p.proposed}ms (~2x observed) to stop the flapping while still catching real regressions.`;
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
  if (!quiet && written.length === 0) console.log('no divergence between measurements and claim bounds');
  return written;
}
