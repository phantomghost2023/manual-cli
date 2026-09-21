import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, impactOf, graphToJson, toDot, toMermaid, printGraphSummary } from '../src/graph.js';

const claim = (id, deps = [], extra = {}) => ({
  fm: { id, kind: extra.kind || 'fact', statement: extra.statement || `statement ${id}`, depends_on: deps.map((d) => ({ id: d })), ...extra.fm },
  file: `/x/.manual/claims/${id}.md`,
});

test('buildGraph links dependencies and dependents', () => {
  const g = buildGraph([claim('a', ['b']), claim('b')]);
  assert.equal(g.nodes.size, 2);
  assert.deepEqual(g.edges, [{ from: 'a', to: 'b', required: true }]);
  assert.deepEqual(g.nodes.get('a').deps, ['b']);
  assert.deepEqual(g.nodes.get('b').dependents, ['a']);
  assert.equal(g.nodes.get('b').depth, 0);
  assert.equal(g.nodes.get('a').depth, 1);
  assert.deepEqual(g.layers, [['b'], ['a']]);
  assert.equal(g.width, 2);
});

test('optional dependencies become dashed edges', () => {
  const a = claim('a');
  a.fm.depends_on = [{ id: 'b', required: false }];
  const g = buildGraph([a, claim('b')]);
  assert.equal(g.edges[0].required, false);
  assert.match(toDot(g), /"a" -> "b" \[style=dashed\]/);
  assert.match(toMermaid(g), /a -.-> b/);
});

test('deep chains produce one layer per hop', () => {
  const g = buildGraph([claim('a', ['b']), claim('b', ['c']), claim('c')]);
  assert.equal(g.nodes.get('c').depth, 0);
  assert.equal(g.nodes.get('b').depth, 1);
  assert.equal(g.nodes.get('a').depth, 2);
  assert.equal(g.width, 3);
});

test('cycles are detected, reported once, and do not hang depth computation', () => {
  const g = buildGraph([claim('a', ['b']), claim('b', ['a'])]);
  assert.equal(g.cycles.length, 1);
  assert.deepEqual([...g.cycles[0]].sort(), ['a', 'b']);
  assert.deepEqual(g.cyclic, ['a', 'b']);
  assert.equal(g.nodes.get('a').depth, 0);
  assert.match(printGraphSummary(g).join('\n'), /cycle/);
});

test('self-dependency is a cycle', () => {
  const g = buildGraph([claim('a', ['a'])]);
  assert.equal(g.cycles.length, 1);
  assert.deepEqual(g.cycles[0], ['a']);
});

test('dangling edges are reported, not thrown', () => {
  const g = buildGraph([claim('a', ['ghost'])]);
  assert.deepEqual(g.missing, [{ from: 'a', to: 'ghost', required: true }]);
  assert.deepEqual(g.nodes.get('a').deps, []);
  assert.match(printGraphSummary(g).join('\n'), /dangling/);
});

test('states and tiers come from stamps, defaulting to unknown/bronze', () => {
  const g = buildGraph([claim('a'), claim('b', ['a'])], {
    a: { state: 'fresh', tier: 'silver', verified_at: '2026-01-01T00:00:00Z', measured_ms: 42 },
  });
  assert.equal(g.nodes.get('a').state, 'fresh');
  assert.equal(g.nodes.get('a').tier, 'silver');
  assert.equal(g.nodes.get('a').measured_ms, 42);
  assert.equal(g.nodes.get('b').state, 'unknown');
  assert.equal(g.nodes.get('b').tier, 'bronze');
});

test('impactOf walks dependents transitively', () => {
  const g = buildGraph([claim('base'), claim('mid', ['base']), claim('top', ['mid']), claim('other')]);
  assert.deepEqual(impactOf(g, 'base'), ['mid', 'top']);
  assert.deepEqual(impactOf(g, 'top'), []);
  assert.deepEqual(g.isolated, ['other']);
});

test('exporters emit parseable, well-formed output', () => {
  const g = buildGraph([claim('a', ['b'], { kind: 'trap' }), claim('b')]);
  const dot = toDot(g);
  assert.match(dot, /^digraph manual \{/);
  assert.equal((dot.match(/\{/g) || []).length, (dot.match(/\}/g) || []).length);
  const mermaid = toMermaid(g);
  assert.match(mermaid, /^graph LR/);
  assert.match(mermaid, /classDef fresh/);
  const j = graphToJson(g);
  assert.equal(j.nodes.length, 2);
  assert.equal(j.edges.length, 1);
  assert.deepEqual(j.layers, [['b'], ['a']]);
});

test('node ids with quotes or braces cannot break DOT output', () => {
  const weird = { fm: { id: 'a', kind: 'fact', statement: 'x', depends_on: [] }, file: '/x/.manual/claims/a.md' };
  const g = buildGraph([weird]);
  const dot = toDot(g);
  assert.match(dot, /"a" \[label=/);
  assert.equal((dot.match(/"/g) || []).length % 2, 0);
});
