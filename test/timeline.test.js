import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTimeline, stats, recoveries, sparkline, fmtDuration, describeTimeline } from '../src/timeline.js';

const at = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

const fakeState = (history) => ({ data: { history, stamps: {}, salt: 'x', version: 1 } });

function gitRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-tl-'));
  fs.mkdirSync(path.join(dir, '.manual', 'claims'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'tl@test');
  git('config', 'user.name', 'Timeline Tester');
  git('add', '-A');
  git('commit', '-q', '-m', 'add claims');
  return { dir, git, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('stats reports p50/p90/max over measured runs', () => {
  const s = stats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(s.n, 10);
  assert.equal(s.min, 10);
  assert.equal(s.max, 100);
  assert.ok(s.p50 >= 50 && s.p50 <= 60);
  assert.ok(s.p90 >= 90);
  assert.equal(stats([]), null);
  assert.equal(stats([undefined, null, NaN]), null);
});

test('recoveries measure broken -> fresh durations only', () => {
  const events = [
    { at: at(50), state: 'fresh' },
    { at: at(40), state: 'broken' },
    { at: at(30), state: 'fresh' },
    { at: at(20), state: 'broken' },
    { at: at(19), state: 'stale' },
    { at: at(10), state: 'fresh' },
  ];
  const r = recoveries(events);
  assert.equal(r.length, 2);
  assert.equal(Math.round(r[0].ms / 60000), 10);
  // broken -> stale -> fresh still counts once, from the break
  assert.equal(Math.round(r[1].ms / 60000), 10);
});

test('an unclosed break yields no recovery', () => {
  const r = recoveries([{ at: at(10), state: 'fresh' }, { at: at(5), state: 'broken' }]);
  assert.deepEqual(r, []);
});

test('sparkline normalizes to block characters and survives flat series', () => {
  assert.equal(sparkline([5, 5, 5]), '▄▄▄');
  assert.equal(sparkline([]), '');
  const ramp = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(ramp.length, 8);
  assert.equal(ramp[0], '▁');
  assert.equal(ramp[7], '█');
  assert.equal(sparkline([1, 2, 3, 4, 5, 6, 7, 8], 3).length, 3);
  assert.equal(ramp.length, [...ramp].length, 'no surrogate pairs');
});

test('buildTimeline collects events, transitions, stats, and git provenance', () => {
  const { dir, cleanup } = gitRepo({
    '.manual/claims/a.claim.md': '---\nid: a.claim\n---\nbody\n',
    '.manual/claims/b.claim.md': '---\nid: b.claim\n---\nbody\n',
  });
  try {
    const state = fakeState([
      { id: 'a.claim', state: 'fresh', at: at(30), ms: 100 },
      { id: 'a.claim', state: 'broken', at: at(20), ms: 120 },
      { id: 'a.claim', state: 'fresh', at: at(10), ms: 140 },
      { id: 'other.claim', state: 'broken', at: at(5), ms: null },
    ]);
    const tl = buildTimeline(dir, state);
    const a = tl.claims.get('a.claim');
    assert.equal(a.events.length, 3);
    assert.deepEqual(a.transitions.map((t) => `${t.from}>${t.to}`), ['fresh>broken', 'broken>fresh']);
    assert.equal(a.lastState, 'fresh');
    assert.equal(a.brokeCount, 1);
    assert.equal(a.stats.p50, 120);
    assert.equal(a.recoveries.length, 1);
    assert.equal(a.files.commits, 1);
    assert.equal(a.files.introduced.author, 'Timeline Tester');
    assert.equal(tl.claims.get('b.claim').events.length, 0, 'git-known claim with no runs still gets a row');
    assert.ok(tl.summary.git);
    assert.equal(tl.summary.transitions, 2);
    assert.equal(tl.summary.claims, 3);
  } finally {
    cleanup();
  }
});

test('a root without git still produces a timeline from state history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-tl-nogit-'));
  try {
    const tl = buildTimeline(dir, fakeState([{ id: 'x', state: 'fresh', at: at(1), ms: 5 }]));
    assert.equal(tl.summary.git, false);
    assert.equal(tl.claims.get('x').files, null, 'no git columns without git');
    assert.equal(tl.claims.get('x').lastState, 'fresh');
    // and describeTimeline must not throw on a claim git has never seen
    assert.ok(describeTimeline(tl.claims.get('x')).some((l) => l.includes('no git history')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a claim already broken when the window opens still reports a break', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-tl-open-'))
  try {
    const tl = buildTimeline(dir, fakeState([
      { id: 'x', state: 'broken', at: at(9), ms: 10 },
      { id: 'x', state: 'fresh', at: at(8), ms: 10 },
    ]));
    const t = tl.claims.get('x');
    assert.equal(t.brokeCount, 1, 'a leading broken state counts as an observed break');
    assert.equal(t.transitions.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('describeTimeline explains a claim in plain lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-tl-desc-'));
  try {
    const tl = buildTimeline(dir, fakeState([{ id: 'x', state: 'broken', at: at(3), ms: 900 }]));
    const lines = describeTimeline(tl.claims.get('x'));
    assert.ok(lines.some((l) => l.includes('last state broken')));
    assert.ok(lines.some((l) => l.includes('no git history')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fmtDuration is human at every scale', () => {
  assert.equal(fmtDuration(250), '250ms');
  assert.equal(fmtDuration(2500), '2.5s');
  assert.equal(fmtDuration(120000), '2m');
  assert.equal(fmtDuration(7200000), '2.0h');
  assert.equal(fmtDuration(172800000), '2.0d');
  assert.equal(fmtDuration(null), '—');
});
