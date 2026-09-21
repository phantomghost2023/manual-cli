import { loadManual, loadConfig } from './claims.js';
import { claimsAtRef } from './history.js';
import { matches } from './glob.js';
import { short, estimateTokens } from './util.js';
import { c } from './color.js';
import { requiredNames, resolvePrereqs, setupStatus } from './setup.js';

// Token-budgeted session briefing: claims relevant to the files in play,
// weighted by priority, glob specificity, trust tier, and trap-ness.

const KIND_ICON = { fact: '📘', command: '⏱', trap: '🪤', policy: '🛡', ownership: '👤' };
const STATE_ICON = { fresh: '✅', stale: '🕰️', broken: '❌', blocked: '🚫', unknown: '❔' };
const TIER_W = { gold: 1.0, silver: 0.9, bronze: 0.5, ghost: 0.4 };

function tierOf(claim, state) {
  const s = state?.stamp(claim.fm.id);
  return s?.tier || claim.fm.provenance?.tier || 'bronze';
}

// 0 = irrelevant; 1 = exact file; 0.8 literal dir; 0.6 single-star; 0.4 deep glob.
function globSpecificity(patterns, touched) {
  let best = 0;
  for (const f of touched) {
    for (const p of [].concat(patterns)) {
      if (!matches(p, f)) continue;
      let s = 0.4;
      if (!/[*{?]/.test(p)) s = p === f ? 1 : 0.8;
      else if (!p.includes('**')) s = 0.6;
      if (s > best) best = s;
    }
  }
  return best;
}

export function renderLine(claim, state, atRef = null) {
  const fm = claim.fm;
  const st = state?.stamp(fm.id);
  const tier = tierOf(claim, state);
  const tierTxt = TIER_W[tier] ? `${tier} ` : '';
  if (atRef) {
    // Historical brief: trust is the tier recorded at that time — approximate
    // with the present stamp when the id still exists, else bronze.
    return `${KIND_ICON[fm.kind] || '•'} ${fm.id} — ${short(fm.statement, 110)} [${tierTxt}🕰 @${atRef}]`;
  }
  const stateIcon = STATE_ICON[st?.state] || '❔';
  return `${KIND_ICON[fm.kind] || '•'} ${fm.id} — ${short(fm.statement, 110)} [${tierTxt}${stateIcon}]`;
}

// A prerequisite that isn't satisfied here is the one thing an agent must know
// before running a claim's command, so it rides on the line. A satisfied one
// costs no tokens: it is the normal case. A name nobody declares is worse than
// missing — an agent would run the check unprepared — so it is named too.
function setupSuffix(claim, root, config = {}) {
  if (!root || (!claim.setup && requiredNames(claim).length === 0)) return '';
  try {
    const { specs, unknown } = resolvePrereqs(claim, config);
    const parts = [];
    for (const n of unknown) parts.push(`${n} (undeclared — see .manual/manual.yaml)`);
    for (const { name, spec } of specs) {
      const st = setupStatus(root, spec);
      if (st.cached) continue;
      parts.push(`${name ? `${name}: ` : ''}${st.run}${st.missing.length ? ` (missing ${st.missing.join(', ')})` : ''}`);
    }
    return parts.length ? ` ⚙ needs: ${parts.join(' + ')}` : '';
  } catch {
    return '';
  }
}

export function brief(root, paths, opts = {}) {
  const at = opts.at || null;
  const { claims, errors } = at
    ? claimsAtRef(root, at)
    : loadManual(root);
  const config = loadConfig(root);
  const budget = opts.budget || config.brief.budget_tokens || 2000;
  const state = opts.state;
  const touched = paths.filter((p) => !p.startsWith('-'));

  const scored = [];
  for (const cl of claims) {
    const always = cl.fm.when === true;
    const spec = touched.length ? globSpecificity(cl.fm.applies_to || ['**'], touched) : 0;
    if (!always && spec <= 0) continue;

    const weight = { critical: 8, high: 5, normal: 2 }[cl.fm.priority || 'normal'];
    let score = weight * (0.3 + 0.7 * spec) * (TIER_W[tierOf(cl, state)] || 0.5);
    if (cl.fm.kind === 'trap') score *= 2;
    if (always) score += 1000;
    scored.push({ cl, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const lines = [];
  let used = 0;
  for (const { cl } of scored) {
    const line = renderLine(cl, state, at) + (at ? '' : setupSuffix(cl, root, config));
    const t = estimateTokens(line);
    if (used + t > budget && lines.length > 0) break;
    lines.push(line);
    used += t;
  }

  if (!opts.quiet) {
    console.log(c.bold(`manual brief${at ? ` @ ${at}` : ''} — ${touched.length || 0} files in scope, budget ${budget} tokens\n`));
    for (const l of lines) console.log(l);
    if (lines.length === 0) console.log(c.grey('(no relevant claims — scope everything you touch)'));
    console.log(
      c.grey(`\n${lines.length}/${scored.length} relevant claims shown, ~${used}/${budget} tokens`),
    );
    for (const e of errors) console.log(c.red(`load error: ${e}`));
  }
  return { lines, used, budget, considered: scored.length, shown: lines.length, errors };
}
