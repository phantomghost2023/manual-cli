import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Claim archaeology: what actually happened to each claim over time.
//
// Two independent records are joined here:
//   1. state.json history — machine-local verify events {id, state, at, ms},
//      capped at 500 entries. This is an operational record, not an audit log:
//      it tells you what this machine ran, not everything that ever happened.
//   2. git history of the claim file itself — when it was introduced, by whom,
//      and how often it has been edited.
//
// A claim's state transitions are where the interesting signal lives: a claim
// that flips broken and back twice is telling you something the current stamp
// cannot.

export function gitLogForClaims(root, claimsDir = '.manual/claims') {
  const r = spawnSync(
    'git',
    ['-C', root, 'log', '--format=%x01%h%x1f%aI%x1f%an%x1f%s', '--name-only', '--', claimsDir],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (r.status !== 0) return null; // not a git repo, or no history
  const out = new Map();
  let commit = null;
  for (const raw of (r.stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('\x01')) {
      const [hash, date, author, subject] = line.slice(1).split('\x1f');
      commit = { hash, date, author, subject };
      continue;
    }
    if (!commit) continue;
    if (!line.startsWith(claimsDir)) continue;
    const file = path.basename(line);
    if (!file.endsWith('.md')) continue;
    if (!out.has(file)) out.set(file, []);
    out.get(file).push(commit);
  }
  return out;
}

const byAt = (a, b) => String(a.at).localeCompare(String(b.at));

export function stats(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pick = (q) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))];
  return {
    n: xs.length,
    min: xs[0],
    p50: pick(0.5),
    p90: pick(0.9),
    max: xs[xs.length - 1],
    avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
  };
}

// Broken -> back-to-fresh durations. The number a maintainer actually cares
// about: how long does a claim stay wrong once it is discovered wrong?
export function recoveries(events) {
  const out = [];
  let brokeAt = null;
  for (const ev of events.slice().sort(byAt)) {
    if (ev.state === 'broken') {
      if (!brokeAt) brokeAt = ev.at;
    } else if (ev.state === 'fresh' && brokeAt) {
      const ms = Date.parse(ev.at) - Date.parse(brokeAt);
      if (Number.isFinite(ms)) out.push({ broke_at: brokeAt, fixed_at: ev.at, ms });
      brokeAt = null;
    }
  }
  return out;
}

export function buildTimeline(root, state, opts = {}) {
  const history = state?.data?.history || [];
  const gitIndex = opts.gitLog === false ? null : gitLogForClaims(root);

  const claims = new Map();
  const ensure = (id) => {
    if (!claims.has(id)) {
      claims.set(id, {
        id,
        events: [],
        transitions: [],
        series: [],
        stats: null,
        recoveries: [],
        lastState: null,
        brokeCount: 0,
        files: null, // set only when git knows the file
      });
    }
    return claims.get(id);
  };

  for (const e of history) {
    if (!e || !e.id) continue;
    const t = ensure(e.id);
    t.events.push({ at: e.at, state: e.state, ms: e.ms ?? null });
    if (typeof e.ms === 'number') t.series.push({ at: e.at, ms: e.ms });
  }

  // Claims with no verify events still deserve a row: from git when it knows
  // the file, and from the caller's claim list when the file is on disk but
  // never verified or never committed.
  if (gitIndex) {
    for (const file of gitIndex.keys()) ensure(file.replace(/\.md$/, ''));
  }
  for (const id of opts.claimIds || []) ensure(id);

  for (const t of claims.values()) {
    t.events.sort(byAt);
    let prev = null;
    for (const ev of t.events) {
      if (prev && ev.state !== prev) t.transitions.push({ from: prev, to: ev.state, at: ev.at });
      prev = ev.state;
    }
    t.lastState = prev;
    // Count observed breaks, including a claim that was already broken when the
    // history window opens — otherwise a visible broken -> fresh transition can
    // sit next to a "0 breaks" label.
    t.brokeCount = t.transitions.filter((x) => x.to === 'broken').length
      + (t.events[0]?.state === 'broken' ? 1 : 0);
    t.stats = stats(t.series.map((s) => s.ms));
    t.recoveries = recoveries(t.events);
    const commits = gitIndex?.get(`${t.id}.md`) || null;
    if (commits) {
      // git log is newest-first; the last entry is the introduction.
      t.files = { commits: commits.length, introduced: commits[commits.length - 1], last: commits[0] };
    }
  }

  const allRecoveries = [...claims.values()].flatMap((t) => t.recoveries);
  const summary = {
    claims: claims.size,
    events: history.length,
    transitions: [...claims.values()].reduce((n, t) => n + t.transitions.length, 0),
    broken: [...claims.values()].filter((t) => t.lastState === 'broken').length,
    meanTimeToRecoveryMs: allRecoveries.length
      ? Math.round(allRecoveries.reduce((n, r) => n + r.ms, 0) / allRecoveries.length)
      : null,
    slowest: [...claims.values()]
      .filter((t) => t.stats)
      .sort((a, b) => b.stats.p50 - a.stats.p50)
      .slice(0, 5)
      .map((t) => ({ id: t.id, p50: t.stats.p50, n: t.stats.n })),
    git: !!gitIndex,
  };
  return { claims, summary, history };
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// Unicode sparkline for terminals. Values are min-max normalized; a flat
// series renders as mid-height bars rather than a misleading ramp.
export function sparkline(values, width = 20) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (xs.length === 0) return '';
  const tail = xs.slice(-width);
  const min = Math.min(...tail);
  const max = Math.max(...tail);
  if (max === min) return BLOCKS[3].repeat(tail.length);
  return tail.map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((v - min) / (max - min)) * (BLOCKS.length - 1)))]).join('');
}

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`;
  return `${(ms / 86400000).toFixed(1)}d`;
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  if (ms < 60000) return 'just now';
  return `${fmtDuration(ms)} ago`;
}

export function describeTimeline(t) {
  const lines = [];
  if (t.files?.introduced) {
    lines.push(`first committed ${fmtWhen(t.files.introduced.date)} by ${t.files.introduced.author} (${t.files.introduced.hash})`);
    lines.push(`${t.files.commits} commit(s) touched this claim; last ${fmtWhen(t.files.last.date)} (${t.files.last.hash})`);
  } else {
    lines.push('no git history for this claim file');
  }
  if (t.events.length === 0) {
    lines.push('no verify events recorded on this machine');
  } else {
    lines.push(`last state ${t.lastState} · ${t.events.length} verify event(s) · ${t.brokeCount} break(s)`);
    if (t.stats) lines.push(`runtime p50 ${fmtDuration(t.stats.p50)} · p90 ${fmtDuration(t.stats.p90)} · max ${fmtDuration(t.stats.max)} (n=${t.stats.n})`);
  }
  for (const tr of t.transitions) lines.push(`  ${fmtWhen(tr.at).padEnd(12)} ${tr.from} → ${tr.to}`);
  return lines;
}
