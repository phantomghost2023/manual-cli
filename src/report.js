import fs from 'node:fs';
import path from 'node:path';
import { loadManual } from './claims.js';
import { buildGraph, impactOf } from './graph.js';
import { doctor } from './doctor.js';
import { readInbox } from './inbox.js';
import { nowIso } from './util.js';

// A single self-contained HTML artifact: no CDN, no build step, no server
// required. It renders the evidence graph as inline SVG, every claim as a
// card, the flywheel inbox, and whatever doctor is worried about. The same
// HTML is what `manual serve` hands to a browser, with a live re-verify
// button wired in when it was served over http.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

const KIND_ICON = { fact: '📘', command: '⏱', trap: '🪤', policy: '🛡', ownership: '👤' };
const STATE_ICON = { fresh: '✅', stale: '🕰️', broken: '❌', blocked: '🚫', unknown: '❔' };
const STATE_ORDER = ['fresh', 'stale', 'broken', 'blocked', 'unknown'];

const NODE_W = 190;
const NODE_H = 48;
const COL_W = 280;
const ROW_H = 76;

export function layout(graph) {
  const pos = new Map();
  graph.layers.forEach((layer, col) => {
    layer.forEach((id, row) => {
      pos.set(id, { x: 16 + col * COL_W, y: 16 + row * ROW_H, col, row });
    });
  });
  const maxRows = Math.max(1, ...graph.layers.map((l) => l.length));
  return {
    pos,
    width: Math.max(560, 32 + Math.max(1, graph.width) * COL_W),
    height: 32 + maxRows * ROW_H,
  };
}

function svgGraph(graph) {
  if (graph.nodes.size === 0) return '<p class="muted">no claims</p>';
  const { pos, width, height } = layout(graph);
  const parts = [];
  parts.push(`<svg class="graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="claim dependency graph">`);
  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#90a4ae"/></marker></defs>');
  for (const e of graph.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    // Dependencies sit in lower-depth (left) columns, so an edge always runs
    // right-to-left: it leaves the dependent's LEFT edge and arrives at the
    // dependency's RIGHT edge. (Routing from the dependent's right edge would
    // make every arrow wrap around both boxes.)
    const x1 = a.x;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x + NODE_W;
    const y2 = b.y + NODE_H / 2;
    const dx = Math.max(20, (x1 - x2) / 2);
    const st = graph.nodes.get(e.from).state;
    parts.push(
      `<path class="edge edge-${st}${e.required ? '' : ' optional'}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" ` +
      `d="M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}" ` +
      `marker-end="url(#arrow)"><title>${esc(e.from)} depends on ${esc(e.to)}${e.required ? '' : ' (optional)'}</title></path>`,
    );
  }
  for (const n of graph.nodes.values()) {
    const p = pos.get(n.id);
    const cyc = graph.cyclic.includes(n.id);
    parts.push(`<a href="#card-${esc(n.id)}" class="node-link">`);
    parts.push(`<g class="node node-${n.state}${cyc ? ' node-cycle' : ''}" data-id="${esc(n.id)}" data-state="${esc(n.state)}">`);
    parts.push(`<title>${esc(n.id)} — ${esc(n.statement)}</title>`);
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="8"/>`);
    parts.push(`<circle cx="${p.x + 16}" cy="${p.y + NODE_H / 2 - 6}" r="5" class="dot"/>`);
    parts.push(`<text x="${p.x + 28}" y="${p.y + 20}" class="node-id">${esc(n.id.length > 24 ? n.id.slice(0, 23) + '…' : n.id)}</text>`);
    parts.push(`<text x="${p.x + 28}" y="${p.y + 36}" class="node-sub">${STATE_ICON[n.state] || '❔'} ${esc(n.tier)} · ${esc(n.kind)}</text>`);
    parts.push('</g></a>');
  }
  parts.push('</svg>');
  return parts.join('');
}

// Mirrors runner.runCheck exactly: `run` is a shell string, `expr` is an
// expression string, and `expect` is a *sibling* of them under `check`.
// Describing a different shape here would make the report lie about what runs.
function describeExpect(expect) {
  const e = expect || {};
  const bits = [];
  if (e.exit !== undefined) bits.push(`exit ${e.exit}`);
  if (e.stdout_matches) bits.push(`stdout ~ /${e.stdout_matches}/`);
  if (e.stderr_matches) bits.push(`stderr ~ /${e.stderr_matches}/`);
  if (e.max_ms !== undefined) bits.push(`≤ ${e.max_ms}ms`);
  return bits.join(', ');
}

function checkHtml(claim) {
  const check = claim.check || {};
  const expect = describeExpect(check.expect || claim.fm.check?.expect);
  const enf = check.enforce || claim.fm.enforce;
  // A policy's gate is extra context, not an alternative to its check.
  const enfHtml = enf
    ? ` <span class="muted">· enforce ${esc(enf.stage || 'pre-commit')} · ${esc(enf.severity || 'warn')}${enf.paths ? ' on ' + esc([].concat(enf.paths).join(' ')) : ''}</span>`
    : '';
  if (typeof check.run === 'string') {
    return `<code>run ${esc(check.run)}</code>${expect ? ` <span class="muted">expects ${esc(expect)}</span>` : ''}${enfHtml}`;
  }
  if (typeof check.expr === 'string') {
    return `<code>expr ${esc(check.expr)}</code>${enfHtml}`;
  }
  if (enf) {
    return `<code>enforce ${esc(enf.stage || 'pre-commit')} · ${esc(enf.severity || 'warn')}</code>`;
  }
  return '<span class="muted">no check (ownership claim)</span>';
}

function evidenceHtml(claim) {
  const ev = claim.fm.evidence || {};
  const keys = Object.keys(ev);
  if (keys.length === 0) return '<span class="muted">none</span>';
  return keys
    .map((k) => {
      const v = ev[k];
      const txt = Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      return `<span class="chip">${esc(k)}: ${esc(txt)}</span>`;
    })
    .join(' ');
}

function linkList(ids) {
  if (!ids || ids.length === 0) return '<span class="muted">—</span>';
  return ids.map((id) => `<a class="chip link" href="#card-${esc(id)}">${esc(id)}</a>`).join(' ');
}

function ageText(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return esc(iso);
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function renderReport(data) {
  const { repoName, claims, graph, doctorRes, inbox, generatedAt, served, version } = data;
  const counts = {};
  for (const n of graph.nodes.values()) counts[n.state] = (counts[n.state] || 0) + 1;
  const total = graph.nodes.size;
  const kinds = {};
  for (const n of graph.nodes.values()) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  const byId = new Map(claims.map((cl) => [cl.fm.id, cl]));
  const suspectIds = new Set(doctorRes?.suspect.map((r) => r.id) || []);

  const stat = (label, value, cls = '') =>
    `<div class="stat ${cls}"><div class="stat-v">${esc(value)}</div><div class="stat-l">${esc(label)}</div></div>`;

  const cards = claims
    .slice()
    .sort((a, b) => a.fm.id.localeCompare(b.fm.id))
    .map((cl) => {
      const id = cl.fm.id;
      const node = graph.nodes.get(id);
      const state = node?.state || 'unknown';
      const tier = node?.tier || 'bronze';
      const deps = (cl.fm.depends_on || []).map((d) => d.id);
      const impact = impactOf(graph, id);
      const searchText = `${id} ${cl.fm.statement} ${cl.fm.kind}`.toLowerCase();
      return `<article class="card" id="card-${esc(id)}" data-state="${esc(state)}" data-kind="${esc(cl.fm.kind)}" data-tier="${esc(tier)}" data-text="${esc(searchText)}">
  <header class="card-h">
    <span class="kicon" title="${esc(cl.fm.kind)}">${KIND_ICON[cl.fm.kind] || '•'}</span>
    <h3>${esc(id)}</h3>
    <span class="badge state-${esc(state)}">${STATE_ICON[state] || '❔'} ${esc(state)}</span>
    <span class="badge tier-${esc(tier)}">${esc(tier)}</span>
    ${suspectIds.has(id) ? '<span class="badge warn" title="doctor flagged this claim">▲ needs attention</span>' : ''}
  </header>
  <p class="statement">${esc(cl.fm.statement)}</p>
  <p class="prose">${esc(cl.intro)}</p>
  <dl class="meta">
    <dt>check</dt><dd>${checkHtml(cl)}</dd>
    <dt>applies_to</dt><dd>${(cl.fm.applies_to || []).length ? [].concat(cl.fm.applies_to).map((p) => `<span class="chip">${esc(p)}</span>`).join(' ') : '<span class="muted">—</span>'}</dd>
    <dt>evidence</dt><dd>${evidenceHtml(cl)}</dd>
    <dt>depends on</dt><dd>${linkList(deps)}</dd>
    <dt>affects</dt><dd>${linkList(impact)}</dd>
    <dt>ttl</dt><dd>${cl.fm.ttl ? esc(cl.fm.ttl) : '<span class="muted">none</span>'} · verify: ${esc(cl.fm.verify || 'always')} · priority: ${esc(cl.fm.priority || 'normal')}</dd>
    <dt>last verified</dt><dd>${ageText(node?.verified_at)}${node?.measured_ms != null ? ` <span class="muted">(${esc(node.measured_ms)}ms)</span>` : ''}${cl.fm.provenance ? ` · <span class="muted">origin ${esc(cl.fm.provenance.origin || 'written')}, confidence ${esc(cl.fm.provenance.confidence ?? '?')}</span>` : ''}</dd>
  </dl>
  ${cl.gotchas ? `<div class="gotchas"><strong>${esc('\u26a0 gotchas')}</strong><div>${esc(cl.gotchas).replace(/\n/g, '<br/>')}</div></div>` : ''}
  <details><summary>full prose</summary><pre class="md">${esc(cl.body)}</pre></details>
  <div class="src">${esc(path.basename(cl.file))}</div>
</article>`;
    })
    .join('\n');

  const issues = [];
  for (const cy of graph.cycles) issues.push(`dependency cycle: ${cy.join(' → ')} → ${cy[0]}`);
  for (const m of graph.missing) issues.push(`dangling edge: ${m.from} → ${m.to} (no such claim)`);
  for (const row of doctorRes?.suspect || []) {
    for (const i of row.issues) issues.push(`${row.id}: ${i}`);
  }
  const issueHtml = issues.length
    ? `<ul class="issues">${issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '<p class="ok">No issues — every claim is verified, fresh, and its evidence is unchanged.</p>';

  const inboxHtml = inbox.length
    ? inbox
      .map(
        (c) => `<li class="candidate">
      <code>${esc(c.file)}</code>
      <span class="muted">${esc(c.proposes?.update ? `proposes update → ${c.proposes.update}` : c.id ? `new claim → ${c.id}` : 'candidate')}</span>
      ${c.observation?.by ? `<span class="muted">observed by ${esc(c.observation.by)} ${esc(ageText(c.observation.at))}</span>` : ''}
      <div class="muted small">accept with <code>manual inbox accept ${esc(c.file)}</code></div>
    </li>`,
      )
      .join('')
    : '<li class="muted">inbox empty — nothing proposed</li>';

  const filterButtons = ['all', ...STATE_ORDER.filter((s) => counts[s])]
    .map((s) => `<button class="fb" data-filter="${esc(s)}">${s === 'all' ? 'all' : `${STATE_ICON[s]} ${s}`} ${s === 'all' ? total : counts[s]}</button>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>manual — ${esc(repoName)}</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#262b35; --fg:#e6e9ef; --muted:#8b93a3;
          --fresh:#4caf50; --stale:#ff9800; --broken:#f44336; --blocked:#9e9e9e; --unknown:#607d8b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  a { color:#8ab4f8; text-decoration:none; } a:hover { text-decoration:underline; }
  code, pre, .chip { font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header.top { padding:22px 26px 10px; border-bottom:1px solid var(--line); }
  header.top h1 { margin:0 0 4px; font-size:19px; }
  header.top h1 span { color:var(--muted); font-weight:400; }
  .sub { color:var(--muted); font-size:12px; }
  .stats { display:flex; flex-wrap:wrap; gap:10px; padding:14px 26px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:8px 14px; min-width:84px; }
  .stat-v { font-size:18px; font-weight:600; }
  .stat-l { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  section { padding:10px 26px 22px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:18px 0 10px; }
  .graph-wrap { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px; overflow:auto; }
  svg.graph { display:block; }
  .node rect { fill:#1b1f27; stroke:var(--unknown); stroke-width:1.5; }
  .node-fresh rect { stroke:var(--fresh); } .node-broken rect { stroke:var(--broken); }
  .node-stale rect { stroke:var(--stale); } .node-blocked rect { stroke:var(--blocked); }
  .node-cycle rect { stroke-dasharray:5 3; }
  .node .dot { fill:var(--unknown); } .node-fresh .dot { fill:var(--fresh); }
  .node-broken .dot { fill:var(--broken); } .node-stale .dot { fill:var(--stale); }
  .node-blocked .dot { fill:var(--blocked); }
  .node text { fill:var(--fg); } .node .node-id { font-size:12px; font-weight:600; }
  .node .node-sub { font-size:10px; fill:var(--muted); }
  .node-link:hover .node rect { fill:#222836; }
  .edge { fill:none; stroke:#90a4ae; stroke-width:1.2; opacity:.55; }
  .edge.optional { stroke-dasharray:4 3; opacity:.35; }
  .edge-fresh { stroke:var(--fresh); } .edge-broken { stroke:var(--broken); }
  .edge-stale { stroke:var(--stale); } .edge-blocked { stroke:var(--blocked); }
  .node.dim, .edge.dim { opacity:.12; }
  .controls { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:12px 0 4px; }
  .fb { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:999px; padding:5px 12px; cursor:pointer; font-size:12px; }
  .fb.on { border-color:#8ab4f8; color:#8ab4f8; }
  input[type=search] { background:var(--panel); border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:7px 11px; min-width:230px; }
  #reverify { background:#1e3a8a; border:1px solid #3b5bdb; color:#fff; border-radius:8px; padding:7px 13px; cursor:pointer; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:13px 15px; }
  .card:target { border-color:#8ab4f8; box-shadow:0 0 0 2px #8ab4f833; }
  .card-h { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
  .card-h h3 { margin:0; font-size:14px; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .statement { margin:6px 0; }
  .prose { color:#c3cad6; margin:6px 0 10px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); background:#1b1f27; }
  .state-fresh { color:var(--fresh); border-color:#2e5d31; } .state-broken { color:var(--broken); border-color:#6b2b2b; }
  .state-stale { color:var(--stale); border-color:#6b4a1e; } .state-blocked { color:var(--blocked); }
  .state-unknown { color:var(--unknown); } .badge.warn { color:var(--stale); border-color:#6b4a1e; }
  .tier-gold { color:#ffd54f; border-color:#6b5a1e; } .tier-silver { color:#cfd8dc; } .tier-bronze { color:#bc8f6f; }
  dl.meta { display:grid; grid-template-columns:96px 1fr; gap:4px 10px; margin:8px 0 0; font-size:12.5px; }
  dl.meta dt { color:var(--muted); }
  dl.meta dd { margin:0; overflow-wrap:anywhere; }
  .chip { display:inline-block; background:#1b1f27; border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-size:11.5px; margin:0 3px 3px 0; }
  .chip.link { color:#8ab4f8; }
  .muted { color:var(--muted); } .small { font-size:11px; }
  .gotchas { margin-top:10px; padding:8px 11px; border-left:3px solid var(--stale); background:#221c12; border-radius:0 8px 8px 0; font-size:12.5px; }
  details { margin-top:10px; } summary { cursor:pointer; color:var(--muted); font-size:12px; }
  pre.md { white-space:pre-wrap; background:#12151b; border:1px solid var(--line); border-radius:8px; padding:10px; font-size:12px; max-height:340px; overflow:auto; }
  .src { color:var(--muted); font-size:11px; margin-top:8px; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .issues { margin:0; padding-left:20px; color:var(--stale); }
  .ok { color:var(--fresh); }
  ul.inbox { list-style:none; margin:0; padding:0; }
  .candidate { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 13px; margin-bottom:8px; display:flex; flex-direction:column; gap:4px; }
  footer { padding:18px 26px 40px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); margin-top:14px; }
  .path { color:var(--muted); }
</style>
</head>
<body>
<header class="top">
  <h1>manual <span>· ${esc(repoName)}</span></h1>
  <div class="sub">${total} claims · ${graph.edges.length} dependency edges · generated ${esc(generatedAt)}${version ? ` · manual-cli v${esc(version)}` : ''}</div>
</header>

<div class="stats">
  ${stat('claims', total)}
  ${STATE_ORDER.filter((s) => counts[s]).map((s) => stat(s, counts[s], `s-${s}`)).join('')}
  ${Object.entries(kinds).map(([k, v]) => stat(k, v)).join('')}
  ${stat('inbox', inbox.length)}
</div>

<section>
  <h2>Evidence graph</h2>
  <div class="graph-wrap">${svgGraph(graph)}</div>
  <p class="sub">Arrows point from a claim to the claims it depends on. Solid = required, dashed = optional. Click a node to jump to its card.</p>
</section>

<section>
  <h2>Attention</h2>
  ${issueHtml}
</section>

<section>
  <h2>Flywheel inbox (${inbox.length})</h2>
  <ul class="inbox">${inboxHtml}</ul>
</section>

<section>
  <h2>Claims</h2>
  <div class="controls">
    ${filterButtons}
    <input type="search" id="q" placeholder="filter by id, statement, kind…">
    <button id="reverify" hidden>↻ re-verify now</button>
  </div>
  <div class="grid" id="cards">
${cards}
  </div>
</section>

<footer>
  <div class="path">${esc(data.root || '')}/.manual</div>
  <div>verify: <code>manual verify</code> · diff: <code>manual verify --diff</code> · brief: <code>manual brief &lt;files…&gt;</code> · health: <code>manual doctor</code></div>
</footer>

<script>
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var nodes = Array.prototype.slice.call(document.querySelectorAll('.node'));
  var edges = Array.prototype.slice.call(document.querySelectorAll('.edge'));
  var active = 'all';
  var q = document.getElementById('q');
  var counter = null;

  function apply() {
    var needle = (q.value || '').toLowerCase();
    var visible = 0;
    var shownIds = {};
    cards.forEach(function (card) {
      var okState = active === 'all' || card.dataset.state === active;
      var okText = !needle || (card.dataset.text || '').indexOf(needle) !== -1;
      var show = okState && okText;
      card.hidden = !show;
      if (show) { visible++; shownIds[card.id.replace('card-', '')] = 1; }
    });
    nodes.forEach(function (n) { n.classList.toggle('dim', !shownIds[n.dataset.id]); });
    edges.forEach(function (e) {
      var dim = (e.dataset.from && !shownIds[e.dataset.from]) || (e.dataset.to && !shownIds[e.dataset.to]);
      e.classList.toggle('dim', !!dim);
    });
    if (counter) counter.textContent = visible + ' / ' + cards.length;
  }

  var buttons = Array.prototype.slice.call(document.querySelectorAll('.fb'));
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      active = b.dataset.filter;
      buttons.forEach(function (o) { o.classList.toggle('on', o === b); });
      apply();
    });
  });
  if (buttons[0]) buttons[0].classList.add('on');
  q.addEventListener('input', apply);

  var btn = document.getElementById('reverify');
  if (btn && location.protocol.indexOf('http') === 0) {
    btn.hidden = false;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = '↻ verifying…';
      fetch('/api/verify', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function () { location.reload(); })
        .catch(function () { btn.textContent = 'verify failed'; btn.disabled = false; });
    });
  }
  if (location.hash) {
    var t = document.querySelector(location.hash);
    if (t) t.scrollIntoView();
  }
})();
</script>
</body>
</html>
`;
}

export function buildReportData(root, opts = {}) {
  const { claims, errors } = opts.claims ? { claims: opts.claims, errors: [] } : loadManual(root);
  const state = opts.state || null;
  const graph = buildGraph(claims, state?.data?.stamps || {});
  const doctorRes = opts.skipDoctor ? { rows: [], suspect: [], healthy: claims.length, errors } : doctor(root, state);
  return {
    root,
    repoName: path.basename(path.resolve(root)) || root,
    claims,
    graph,
    doctorRes,
    inbox: readInbox(root),
    generatedAt: nowIso(),
    version: opts.version || null,
    served: !!opts.served,
    loadErrors: errors,
  };
}

export function writeReport(root, opts = {}) {
  const data = buildReportData(root, opts);
  const html = renderReport(data);
  const out = opts.out || path.join(root, '.manual', 'report.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return { out, html, data };
}
