import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../src/graph.js';
import { layout, renderReport, writeReport, buildReportData } from '../src/report.js';
import { startServer } from '../src/serve.js';
import { State } from '../src/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.join(here, '..', 'demo');

function fakeClaim(id, extra = {}) {
  return {
    file: path.join('/x/.manual/claims', `${id}.md`),
    fm: {
      schema: 'manual/v1',
      id,
      kind: extra.kind || 'fact',
      statement: extra.statement || `statement for ${id}`,
      applies_to: extra.applies_to || ['src/**'],
      evidence: extra.evidence || { files: ['package.json'] },
      depends_on: extra.depends_on || [],
      priority: 'normal',
      ...extra.fm,
    },
    intro: extra.intro || `Explanation for ${id}.`,
    gotchas: extra.gotchas || null,
    body: extra.body || `Explanation for ${id}.\n\n## Details\nmore`,
    check: extra.check || { run: { cmd: 'echo hi', expect: { code: 0 } } },
  };
}

function renderFixture(claims, stamps = {}, inbox, { journal = [], served = false } = {}) {
  const graph = buildGraph(claims, stamps);
  return renderReport({
    journal,
    served,
    root: '/repo',
    repoName: 'fixture',
    claims,
    graph,
    doctorRes: { rows: [], suspect: [], healthy: claims.length, errors: [] },
    inbox: inbox ?? [
      { file: '2026-01-01-tighten.md', id: 'x', kind: 'fact', proposes: { update: 'x' }, observation: { by: 'session', at: new Date().toISOString(), evidence: 'p50 4000ms' } },
    ],
    generatedAt: '2026-01-01T00:00:00.000Z',
    version: '0.1.0',
  });
}

test('the card shows a declared prerequisite and whether this machine has it', () => {
  const claim = fakeClaim('alpha');
  const graph = buildGraph([claim], {});
  const render = (setup) =>
    renderReport({
      root: '/repo',
      repoName: 'fixture',
      claims: [claim],
      graph,
      doctorRes: { rows: [{ id: 'alpha', state: 'unknown', tier: null, issues: [], setup }], suspect: [], healthy: 1, errors: [] },
      inbox: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
      version: '0.1.0',
    });
  const satisfied = render({ run: 'npm ci', cached: true, missing: [] });
  assert.match(satisfied, /<dt>setup<\/dt><dd><code>npm ci<\/code>/);
  assert.match(satisfied, /satisfied here/);
  const pending = render({ run: 'make deps', cached: false, missing: ['vendor'] });
  assert.match(pending, /runs on next verify/);
  assert.match(pending, /missing vendor/);
  // A claim with no prerequisite still gets the row, so the absence is stated
  // rather than left to the reader.
  assert.match(render(null), /<dt>setup<\/dt><dd><span class="muted">—<\/span>/);
});

test('report is a complete standalone document with no external references', () => {
  const html = renderFixture([fakeClaim('alpha', { depends_on: [{ id: 'beta' }] }), fakeClaim('beta')]);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /id="card-alpha"/);
  assert.match(html, /id="card-beta"/);
  assert.match(html, /<svg class="graph"/);
  assert.doesNotMatch(html, /src="https?:/);
  assert.doesNotMatch(html, /href="https?:\/\/(?!localhost)/);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
  assert.match(html, /alpha depends on beta/);
});

test('untrusted claim text is escaped, never interpolated as markup', () => {
  const evil = fakeClaim('evil', {
    statement: '</h3><img src=x onerror="alert(1)"><svg onload=alert(2)>',
    intro: 'intro with <script>alert("x")</script> inside',
  });
  const html = renderFixture([evil]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert\("x"\)/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

test('cards carry filter metadata and state badges', () => {
  const html = renderFixture(
    [fakeClaim('alpha', { kind: 'trap' }), fakeClaim('beta')],
    { alpha: { state: 'broken', tier: 'gold', verified_at: '2026-01-01T00:00:00Z' } },
  );
  assert.match(html, /data-state="broken"/);
  assert.match(html, /data-kind="trap"/);
  assert.match(html, /data-tier="gold"/);
  assert.match(html, /class="badge state-broken"/);
  assert.match(html, /class="badge tier-gold"/);
  assert.match(html, /data-filter="broken"/);
});

test('an empty manual renders without crashing', () => {
  const html = renderFixture([], {}, []);
  assert.match(html, /no claims/);
  assert.match(html, /inbox empty/);
  assert.match(html, /No issues/);
});

test('a populated inbox is rendered with its acceptance command and a review button', () => {
  const html = renderFixture([fakeClaim('alpha')]);
  assert.match(html, /2026-01-01-tighten\.md/);
  assert.match(html, /proposes update → x/);
  assert.match(html, /manual inbox accept 2026-01-01-tighten\.md/);
  assert.match(html, /<button class="accept" data-file="2026-01-01-tighten\.md" hidden>/, 'serve wires the button; the static file leaves it hidden');
  assert.match(html, /class="patch" data-patch="2026-01-01-tighten\.md" hidden/);
});

test('layout places every node without overlap inside its layer', () => {
  const claims = [];
  for (let i = 0; i < 12; i++) claims.push(fakeClaim(`n${i}`));
  const graph = buildGraph(claims);
  const { pos, width, height } = layout(graph);
  assert.equal(pos.size, 12);
  const ys = [...pos.values()].map((p) => p.y);
  assert.equal(new Set(ys).size, 12);
  assert.ok(width > 0 && height > 12 * 40);
});

test('graph edges leave the dependent and arrive at the dependency', () => {
  // beta sits in column 0 and alpha (which depends on beta) in column 1, so the
  // arrow must run right-to-left: alpha's left edge -> beta's right edge.
  const claims = [fakeClaim('alpha', { depends_on: [{ id: 'beta' }] }), fakeClaim('beta')];
  const graph = buildGraph(claims);
  const { pos } = layout(graph);
  const html = renderFixture(claims);
  const path = html.match(/<path class="edge[^"]*" data-from="alpha" data-to="beta"\s+d="([^"]+)"/);
  assert.ok(path, 'no edge path rendered for alpha -> beta');
  const [x1, y1] = path[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
  const nums = path[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
  const x2 = nums[nums.length - 2];
  assert.equal(x1, pos.get('alpha').x, 'edge starts at the dependent\u2019s left edge');
  assert.equal(x2, pos.get('beta').x + 190, 'edge ends at the dependency\u2019s right edge');
  assert.ok(x1 > x2, 'the dependent sits to the right of its dependency');
  assert.equal(y1, pos.get('alpha').y + 24, 'edge starts at the node\u2019s vertical center');
});

test('check rows mirror the real check schema, not a guess', () => {
  const html = renderReport(buildReportData(demo, { skipDoctor: true }));
  // command claim: run string + sibling expect keys from the runner
  assert.match(html, /run node --test/);
  assert.match(html, /expects exit 0, ≤ 30000ms/);
  // expr claim: the expression itself, escaped
  assert.match(html, /expr manifest\(&quot;package.json&quot;\)\.type === &quot;module&quot;/);
  // policy claim: its enforce block
  assert.match(html, /enforce pre-commit · block/);
  // and never an empty check cell
  assert.doesNotMatch(html, /<code>expr<\/code>/);
  assert.doesNotMatch(html, /<code>run<\/code>/);
});

test('the timeline section renders transitions and a runtime sparkline', () => {
  const claims = [fakeClaim('alpha')];
  const graph = buildGraph(claims);
  const now = new Date().toISOString();
  const timeline = {
    summary: { claims: 1, events: 3, transitions: 1, broken: 0, meanTimeToRecoveryMs: 65000, slowest: [], git: true },
    claims: new Map([['alpha', {
      id: 'alpha',
      events: [],
      transitions: [{ from: 'fresh', to: 'broken', at: now }],
      series: [{ at: now, ms: 10 }, { at: now, ms: 40 }],
      stats: { n: 2, min: 10, p50: 25, p90: 40, max: 40, avg: 25 },
      recoveries: [],
      lastState: 'fresh',
      brokeCount: 1,
      files: { commits: 2, introduced: { hash: 'abc1234', date: now, author: 'mira' }, last: { hash: 'def5678', date: now } },
    }]]),
  };
  const html = renderReport({
    root: '/repo', repoName: 'fixture', claims, graph,
    doctorRes: { rows: [], suspect: [], healthy: 1, errors: [] },
    inbox: [], timeline, generatedAt: now,
  });
  assert.match(html, /mean time to recovery 1m/);
  assert.match(html, /<code>alpha<\/code> fresh → <b class="to-broken">broken<\/b>/);
  assert.match(html, /<polyline points=/);
  assert.match(html, /p50 25ms/);
  assert.match(html, /1 break\(s\)/);
  assert.match(html, /introduced .* by mira \(abc1234\)/);
});

test('a report without a timeline degrades quietly', () => {
  const html = renderFixture([fakeClaim('alpha')]);
  assert.match(html, /no history recorded/);
  assert.match(html, /not in git/);
  assert.doesNotMatch(html, /<polyline points=/);
});

test('a claim with too few runs shows a placeholder instead of a fake trend', () => {
  const claims = [fakeClaim('alpha')];
  const timeline = {
    summary: { claims: 1, events: 1, transitions: 0, broken: 0, meanTimeToRecoveryMs: null, slowest: [], git: false },
    claims: new Map([['alpha', { id: 'alpha', series: [{ at: 'x', ms: 5 }], stats: { n: 1, p50: 5, p90: 5, max: 5, avg: 5 }, transitions: [], brokeCount: 0, files: null, events: [], recoveries: [] }]]),
  };
  const html = renderReport({
    root: '/repo', repoName: 'fixture', claims, graph: buildGraph(claims),
    doctorRes: { rows: [], suspect: [], healthy: 1, errors: [] },
    inbox: [], timeline, generatedAt: 'now',
  });
  assert.match(html, /no runs yet/);
  assert.match(html, /no state transitions recorded/);
});

test('doctor issues appear in the attention section', () => {
  const claims = [fakeClaim('alpha')];
  const graph = buildGraph(claims);
  const html = renderReport({
    root: '/repo',
    repoName: 'fixture',
    claims,
    graph,
    doctorRes: { rows: [{ id: 'alpha', state: 'fresh', issues: ['TTL 30d expired 2d ago'] }], suspect: [{ id: 'alpha', state: 'fresh', issues: ['TTL 30d expired 2d ago'] }], healthy: 0, errors: [] },
    inbox: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.match(html, /TTL 30d expired 2d ago/);
});

// The journal is the audit trail: what changed, why, on which machine, and
// whether it held. It is committed, so this section is identical everywhere.
const entry = (over = {}) => ({
  id: '20260921T194044Z-tests.demo',
  entry: 'accept',
  at: '2026-09-21T19:40:44.000Z',
  machine: 'laptop-1',
  claim: 'tests.demo',
  file: 'tighten.md',
  mode: 'patch',
  reason: 'recent runs put p50 at 9s against a 120s bound',
  verdict: { state: 'fresh', note: '12ms' },
  ...over,
});

test('an empty journal says so instead of rendering nothing', () => {
  const html = renderFixture([fakeClaim('alpha')]);
  assert.match(html, /nothing accepted yet/);
  assert.match(html, /<h2>Journal \(0\)<\/h2>/);
});

test('journal entries carry the reason, machine and verdict', () => {
  const html = renderFixture([fakeClaim('alpha')], {}, undefined, { journal: [entry()] });
  assert.match(html, /<h2>Journal \(1\)<\/h2>/);
  assert.match(html, /1 entries/);
  assert.match(html, /laptop-1/);
  assert.match(html, /recent runs put p50 at 9s against a 120s bound/);
  assert.match(html, /verified fresh/);
  assert.match(html, /entry-accept/);
});

test('the static report offers no revert button, the live dashboard does', () => {
  const staticHtml = renderFixture([fakeClaim('alpha')], {}, undefined, { journal: [entry()] });
  assert.doesNotMatch(staticHtml, /button class="revert"/);
  const servedHtml = renderFixture([fakeClaim('alpha')], {}, undefined, { journal: [entry()], served: true });
  assert.match(servedHtml, /button class="revert" data-entry="20260921T194044Z-tests\.demo"/);
});

test('a reverted accept is marked and can no longer be reverted again', () => {
  const journal = [
    entry({ id: 'rev-1', entry: 'revert', reverts: '20260921T194044Z-tests.demo' }),
    entry(),
  ];
  const html = renderFixture([fakeClaim('alpha')], {}, undefined, { journal, served: true });
  assert.match(html, /1 reverted/);
  assert.doesNotMatch(html, /button class="revert" data-entry="20260921T194044Z-tests\.demo"/);
});

test('writeReport writes the artifact and buildReportData reads the demo manual', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manual-report-')), 'report.html');
  const res = writeReport(demo, { out, state: new State(demo), skipDoctor: true });
  assert.equal(res.out, out);
  assert.ok(fs.statSync(out).size > 2000);
  const data = buildReportData(demo, { skipDoctor: true });
  assert.ok(data.claims.length >= 5);
  assert.ok(data.graph.nodes.size >= 5);
  // The demo manual is the reference shape: a real multi-layer evidence graph,
  // not a flat list. If this drops, the demo stopped demonstrating.
  assert.ok(data.graph.edges.length >= 3, `expected >=3 edges, got ${data.graph.edges.length}`);
  assert.ok(data.graph.width >= 3, `expected >=3 layers, got ${data.graph.width}`);
  assert.deepEqual(data.graph.cycles, []);
  assert.deepEqual(data.graph.missing, []);
  assert.equal(data.repoName, 'demo');
});

test('serve responds with the report, JSON APIs, and 404s', async () => {
  const s = await startServer(demo, { port: 0 });
  try {
    assert.ok(s.port > 0);
    const home = await fetch(s.url);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /<svg class="graph"/);
    assert.match(html, /tooling\.node-esm/);
    assert.match(html, /id="reverify"/);

    const graph = await (await fetch(s.url + 'api/graph')).json();
    assert.ok(Array.isArray(graph.nodes));
    assert.ok(graph.nodes.length >= 5);

    const claims = await (await fetch(s.url + 'api/claims')).json();
    assert.ok(claims.claims.every((c) => typeof c.id === 'string' && typeof c.state === 'string'));

    const health = await (await fetch(s.url + 'health')).json();
    assert.equal(health.ok, true);

    const missing = await fetch(s.url + 'nope');
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});
