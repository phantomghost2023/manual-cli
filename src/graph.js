// The evidence graph: claims as nodes, depends_on as directed edges
// (dependent -> dependency). Exposes cycle detection, layered depth for
// rendering, and exporters (dot, mermaid, json). Pure functions only, so the
// graph can be tested and rendered without touching the filesystem.

const KIND_ICON = { fact: '📘', command: '⏱', trap: '🪤', policy: '🛡', ownership: '👤' };
const STATE_ICON = { fresh: '✅', stale: '🕰️', broken: '❌', blocked: '🚫', unknown: '❔' };

export function buildGraph(claims, stamps = {}) {
  const nodes = new Map();
  for (const cl of claims) {
    const id = cl.fm.id;
    const stamp = stamps[id] || null;
    nodes.set(id, {
      id,
      kind: cl.fm.kind,
      statement: cl.fm.statement,
      priority: cl.fm.priority || 'normal',
      ttl: cl.fm.ttl || null,
      verify: cl.fm.verify || 'always',
      origin: cl.fm.provenance?.origin || 'written',
      tier: stamp?.tier || cl.fm.provenance?.tier || 'bronze',
      state: stamp?.state || 'unknown',
      verified_at: stamp?.verified_at || null,
      measured_ms: stamp?.measured_ms ?? null,
      applies_to: cl.fm.applies_to || [],
      evidence: Object.keys(cl.fm.evidence || {}),
      deps: [],
      dependents: [],
      depth: 0,
    });
  }

  const edges = [];
  const missing = [];
  for (const cl of claims) {
    const from = cl.fm.id;
    for (const d of cl.fm.depends_on ?? []) {
      if (!nodes.has(d.id)) {
        missing.push({ from, to: d.id, required: d.required !== false });
        continue;
      }
      edges.push({ from, to: d.id, required: d.required !== false });
      nodes.get(from).deps.push(d.id);
      nodes.get(d.id).dependents.push(from);
    }
  }

  const cycles = findCycles(nodes, edges);
  const cyclic = new Set(cycles.flat());
  // Depth = longest path from a root, computed iteratively so cycles cannot
  // make it diverge: nodes inside a cycle collapse to depth 0.
  const depth = new Map();
  const compute = (id, stack = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id) || cyclic.has(id)) return 0;
    const n = nodes.get(id);
    let max = 0;
    for (const d of n.deps) {
      if (cyclic.has(d)) continue;
      max = Math.max(max, compute(d, new Set([...stack, id])) + 1);
    }
    depth.set(id, max);
    return max;
  };
  for (const id of nodes.keys()) {
    nodes.get(id).depth = compute(id);
  }

  const layers = [];
  for (const n of nodes.values()) {
    while (layers.length <= n.depth) layers.push([]);
    layers[n.depth].push(n.id);
  }
  for (const l of layers) l.sort();

  const isolated = [...nodes.values()]
    .filter((n) => n.deps.length === 0 && n.dependents.length === 0)
    .map((n) => n.id)
    .sort();

  const orphans = [...nodes.values()]
    .filter((n) => n.dependents.length === 0 && n.deps.length === 0)
    .map((n) => n.id)
    .sort();

  return {
    nodes,
    edges,
    layers,
    cycles,
    cyclic: [...cyclic].sort(),
    missing,
    isolated,
    orphans,
    width: layers.length,
  };
}

function findCycles(nodes, edges) {
  const out = [];
  const color = new Map(); // 0 unvisited, 1 in-stack, 2 done
  const adj = new Map();
  for (const id of nodes.keys()) adj.set(id, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);

  const stack = [];
  const seenKey = new Set();
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) || []) {
      const c = color.get(next) ?? 0;
      if (c === 1) {
        const cycle = stack.slice(stack.indexOf(next));
        const key = [...cycle].sort().join('>');
        if (!seenKey.has(key)) {
          seenKey.add(key);
          out.push(cycle);
        }
      } else if (c === 0) {
        visit(next);
      }
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of nodes.keys()) if ((color.get(id) ?? 0) === 0) visit(id);
  return out;
}

// Which claims are reachable if `id` is taken out of service? (dependents,
// transitively) — used for impact analysis in reports and by watch mode.
export function impactOf(graph, id) {
  const seen = new Set();
  const walk = (cur) => {
    for (const dep of graph.nodes.get(cur)?.dependents || []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      walk(dep);
    }
  };
  walk(id);
  return [...seen].sort();
}

export function graphToJson(graph) {
  return {
    nodes: [...graph.nodes.values()].map((n) => ({
      id: n.id, kind: n.kind, state: n.state, tier: n.tier, depth: n.depth,
      deps: n.deps, dependents: n.dependents,
    })),
    edges: graph.edges,
    layers: graph.layers,
    cycles: graph.cycles,
    missing: graph.missing,
    isolated: graph.isolated,
  };
}

const dotEscape = (s) => String(s).replace(/["\\]/g, '\\$&');

export function toDot(graph, { name = 'manual' } = {}) {
  const lines = [`digraph ${name} {`, '  rankdir=LR;', '  node [shape=box, style=rounded, fontname="Helvetica"];'];
  const style = {
    fresh: 'color="#2e7d32", fontcolor="#1b5e20"',
    broken: 'color="#c62828", fontcolor="#b71c1c"',
    stale: 'color="#ef6c00", fontcolor="#e65100"',
    blocked: 'color="#9e9e9e", fontcolor="#757575"',
    unknown: 'color="#616161", fontcolor="#424242"',
  };
  for (const n of graph.nodes.values()) {
    const label = `${KIND_ICON[n.kind] || '•'} ${n.id}\\n[${n.tier}/${n.state}]`;
    lines.push(`  "${dotEscape(n.id)}" [label="${dotEscape(label)}", ${style[n.state] || style.unknown}];`);
  }
  for (const e of graph.edges) {
    const attrs = e.required ? '' : ' [style=dashed]';
    lines.push(`  "${dotEscape(e.from)}" -> "${dotEscape(e.to)}"${attrs};`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function toMermaid(graph, { direction = 'LR' } = {}) {
  const cls = {
    fresh: ':::fresh', broken: ':::broken', stale: ':::stale',
    blocked: ':::blocked', unknown: ':::unknown',
  };
  const id = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
  const lines = [`graph ${direction}`];
  for (const n of graph.nodes.values()) {
    lines.push(`  ${id(n.id)}["${n.id}<br/>${n.kind} · ${n.tier}/${n.state}"]${cls[n.state] || ''}`);
  }
  for (const e of graph.edges) {
    lines.push(e.required ? `  ${id(e.from)} --> ${id(e.to)}` : `  ${id(e.from)} -.-> ${id(e.to)}`);
  }
  for (const s of ['fresh', 'broken', 'stale', 'blocked', 'unknown']) {
    const fill = { fresh: '#c8e6c9', broken: '#ffcdd2', stale: '#ffe0b2', blocked: '#e0e0e0', unknown: '#eeeeee' }[s];
    const stroke = { fresh: '#2e7d32', broken: '#c62828', stale: '#ef6c00', blocked: '#9e9e9e', unknown: '#616161' }[s];
    lines.push(`  classDef ${s} fill:${fill},stroke:${stroke},color:#111;`);
  }
  return lines.join('\n') + '\n';
}

export function printGraphSummary(graph, { color = null } = {}) {
  const counts = {};
  for (const n of graph.nodes.values()) counts[n.state] = (counts[n.state] || 0) + 1;
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  const lines = [
    `${graph.nodes.size} claims, ${graph.edges.length} edges, ${graph.width} layer(s)`,
    parts.join(', '),
  ];
  if (graph.cycles.length) {
    lines.push(`⚠ ${graph.cycles.length} cycle(s):`);
    for (const cy of graph.cycles) lines.push(`    ${cy.join(' → ')} → ${cy[0]}`);
  }
  if (graph.missing.length) {
    lines.push(`⚠ ${graph.missing.length} dangling edge(s):`);
    for (const m of graph.missing) lines.push(`    ${m.from} → ${m.to} (missing claim)`);
  }
  if (graph.isolated.length) lines.push(`• ${graph.isolated.length} isolated claim(s): ${graph.isolated.join(', ')}`);
  return lines;
}
