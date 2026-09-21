import fs from 'node:fs';
import path from 'node:path';
import { loadManual } from './claims.js';
import { matchAny } from './glob.js';
import { verifyOne } from './runner.js';
import { Sandbox } from './sandbox.js';
import { c } from './color.js';

// Watch mode: on file change, re-verify only the claims whose evidence globs
// match the changed file (plus their dependency closure). The fs.watch loop
// is thin glue; selection logic is exported for tests and editor integrations.

export function affectedClaims(root, files) {
  const { claims } = loadManual(root);
  const byId = new Map(claims.map((cl) => [cl.fm.id, cl]));
  const hits = new Set();
  for (const cl of claims) {
    const ev = (cl.fm.evidence?.files || []).concat(cl.fm.applies_to || []);
    if (matchAny(ev.length ? ev : ['**'], files)) hits.add(cl.fm.id);
  }
  // dependency closure: anything a hit depends on, plus anything depending on a hit
  const closure = new Set(hits);
  let grew = true;
  while (grew) {
    grew = false;
    for (const cl of claims) {
      for (const d of cl.fm.depends_on ?? []) {
        if (closure.has(d.id) && !closure.has(cl.fm.id)) { closure.add(cl.fm.id); grew = true; }
      }
      if (closure.has(cl.fm.id)) {
        for (const d of cl.fm.depends_on ?? []) {
          if (byId.has(d.id) && !closure.has(d.id)) { closure.add(d.id); grew = true; }
        }
      }
    }
  }
  return claims.filter((cl) => closure.has(cl.fm.id));
}

const STATE_ICON = { fresh: '✅', stale: '🕰️', broken: '❌', blocked: '🚫', unknown: '❔' };

export async function watchOnce(root, files, state, { quiet = false } = {}) {
  const selected = affectedClaims(root, files);
  if (selected.length === 0) return [];
  const results = [];
  const sb = await new Sandbox(root).enter();
  try {
    for (const cl of selected) {
      const { stamp } = await verifyOne(cl, root, state, { sandbox: sb, timeoutMs: 120000 });
      results.push(stamp);
      if (!quiet) {
        console.log(
          `${STATE_ICON[stamp.state] || '❔'} ${cl.fm.id.padEnd(34)} ${stamp.state.padEnd(7)} ${stamp.note || ''}`,
        );
      }
    }
  } finally {
    await sb.exit();
  }
  return results;
}

export function startWatch(root, { debounceMs = 400, quiet = false, onEvent } = {}) {
  let state = null;
  let timer = null;
  let pending = new Set();

  const flush = async () => {
    const files = [...pending];
    pending = new Set();
    if (files.length === 0) return;
    try {
      if (!state) state = new State(root);
      const stamps = await watchOnce(root, files, state, { quiet });
      state.save();
      if (onEvent) onEvent({ files, stamps });
      if (!quiet && stamps.length) {
        const broken = stamps.filter((s) => s.state === 'broken').length;
        console.log(
          c.grey(
            `— ${stamps.length} claim(s) re-checked after ${files.length} file change(s)` +
              (broken ? `, ${c.red(String(broken))} broken` : ''),
          ),
        );
      }
    } catch (e) {
      if (!quiet) console.error(c.red(`watch: ${e.message}`));
    }
  };

  const schedule = (rel) => {
    if (rel.includes('.manual') && rel.endsWith('state.json')) return; // our own writes
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.split(path.sep).join('/');
    if (rel.startsWith('.git/')) return;
    schedule(rel);
  });

  return {
    stop() {
      clearTimeout(timer);
      watcher.close();
      if (state) state.save();
    },
    flush,
  };
}
