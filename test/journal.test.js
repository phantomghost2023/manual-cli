import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJournal, findEntry, appendEntry, restoreFromEntry, verifyEntry, entryId } from '../src/journal.js';
import { readLedger, ledgerStats, allLedgerStats, mergeTrust, recordLedger, GOLD_PASSES, GOLD_MACHINES } from '../src/ledger.js';
import { acceptAndVerify, revertFromJournal, undoAndVerify } from '../src/flywheel.js';
import { State } from '../src/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const tmpCopy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-input-'));
  fs.cpSync(path.join(here, '..', 'demo'), dir, { recursive: true });
  for (const rel of ['state.json', 'ledger.jsonl']) fs.rmSync(path.join(dir, '.manual', rel), { force: true });
  fs.rmSync(path.join(dir, '.manual', 'journal'), { recursive: true, force: true });
  return dir;
};

const candidate = (file, ms) => `---
schema: manual/v1
id: candidate.tighten.tests.demo
kind: candidate
proposes:
  update: tests.demo
  patch:
    check.expect.max_ms: ${ms}
observation:
  at: 2026-09-21T00:00:00Z
  by: agent:test
  evidence: "p50 under the bound"
---
Tighten the demo test bound.
`;

test('an accepted proposal writes a journal entry with the reason and prior bytes', async () => {
  const dir = tmpCopy();
  try {
    const before = fs.readFileSync(path.join(dir, '.manual', 'claims', 'tests.demo.md'), 'utf8');
    fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'tighten.md'), candidate('tighten.md', 60000));
    const res = await acceptAndVerify(dir, 'tighten.md', { state: new State(dir), quiet: true });

    const entries = readJournal(dir);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.entry, 'accept');
    assert.equal(e.claim, 'tests.demo');
    assert.equal(e.file, 'tighten.md');
    assert.equal(e.reason, 'p50 under the bound');
    assert.equal(e.verdict.state, 'fresh');
    assert.equal(e.before_text, before, 'the exact prior content is recorded');
    assert.match(e.body, /Tighten the demo test bound\./);
    assert.match(e.body, /max_ms/);
    assert.ok(e.before_hash && e.after_hash && e.before_hash !== e.after_hash);
    assert.equal(res.journalId, e.id);
    assert.equal(e.machine.length > 0, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('journal revert restores a claim in a later process, with no local snapshot', async () => {
  const dir = tmpCopy();
  try {
    const claimPath = path.join(dir, '.manual', 'claims', 'tests.demo.md');
    const before = fs.readFileSync(claimPath, 'utf8');
    fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'tighten.md'), candidate('tighten.md', 60000));
    const res = await acceptAndVerify(dir, 'tighten.md', { state: new State(dir), quiet: true });
    assert.match(fs.readFileSync(claimPath, 'utf8'), /max_ms: 60000/);

    // Simulate another checkout: the undo snapshot is gone, only the journal
    // (committed to git) remains.
    fs.rmSync(path.join(dir, '.manual', 'undo'), { recursive: true, force: true });
    const reverted = await revertFromJournal(dir, res.journalId, { state: new State(dir), quiet: true });
    assert.equal(reverted.reverted, true);
    assert.equal(reverted.claim, 'tests.demo');
    assert.equal(reverted.verified.state, 'fresh');
    assert.equal(fs.readFileSync(claimPath, 'utf8'), before, 'byte-identical to before the proposal');

    const entries = readJournal(dir);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].entry, 'revert');
    assert.equal(entries[0].reverts, res.journalId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Found on a real repo: reverting a whole-claim accept deleted the claim (the
// correct outcome) and silently lost the candidate file that argued for it, so
// the proposal could not be reviewed or re-applied afterwards.
test('reverting a whole-claim accept puts the candidate back in the inbox', async () => {
  const dir = tmpCopy();
  try {
    const text = `---
schema: manual/v1
id: coverage.new
kind: command
statement: The new module is covered.
priority: low
evidence:
  files:
    - src/**
check:
  run: node --test
  expect:
    exit: 0
---
A brand new claim.
`;
    fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'coverage.new.md'), text);
    const res = await acceptAndVerify(dir, 'coverage.new.md', { state: new State(dir), quiet: true });
    assert.ok(fs.existsSync(path.join(dir, '.manual', 'claims', 'coverage.new.md')));
    fs.rmSync(path.join(dir, '.manual', 'undo'), { recursive: true, force: true }); // other checkout

    const reverted = await revertFromJournal(dir, res.journalId, { state: new State(dir), quiet: true });
    assert.equal(reverted.changed, true);
    assert.equal(fs.existsSync(path.join(dir, '.manual', 'claims', 'coverage.new.md')), false);
    assert.equal(fs.readFileSync(path.join(dir, '.manual', 'inbox', 'coverage.new.md'), 'utf8'), text);
    assert.equal(reverted.inboxRestored, 'coverage.new.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('undoing an accepted proposal is journaled as an undo, not silence', async () => {
  const dir = tmpCopy();
  try {
    fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'tighten.md'), candidate('tighten.md', 60000));
    const res = await acceptAndVerify(dir, 'tighten.md', { state: new State(dir), quiet: true });
    await undoAndVerify(dir, res.token, { state: new State(dir), quiet: true });
    const entries = readJournal(dir);
    assert.equal(entries[0].entry, 'undo');
    assert.equal(entries[0].reverts, res.journalId);
    assert.equal(entries[0].reason, 'the accepted proposal failed its own check');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('journal ids resolve by prefix and reject ambiguity', () => {
  const dir = tmpCopy();
  try {
    appendEntry(dir, { entry: 'accept', at: '2026-01-01T00:00:00Z', claim: 'a', beforeText: 'x', afterText: 'y' });
    appendEntry(dir, { entry: 'accept', at: '2026-01-02T00:00:00Z', claim: 'b', beforeText: 'x', afterText: 'y' });
    const all = readJournal(dir);
    assert.equal(all.length, 2);
    assert.equal(findEntry(dir, all[0].id).claim, all[0].claim);
    assert.equal(findEntry(dir, all[0].id.slice(0, 8)).id, all[0].id);
    assert.equal(findEntry(dir, 'nope'), null);
    assert.throws(() => findEntry(dir, '202601'), /ambiguous/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a journal entry notices when the claim moved on afterwards', () => {
  const dir = tmpCopy();
  try {
    const claimPath = path.join(dir, '.manual', 'claims', 'tests.demo.md');
    const before = fs.readFileSync(claimPath, 'utf8');
    const { id } = appendEntry(dir, { entry: 'accept', claim: 'tests.demo', beforeText: before, afterText: before });
    assert.equal(verifyEntry(dir, findEntry(dir, id)).ok, true);
    fs.writeFileSync(claimPath, before.replace('max_ms: 30000', 'max_ms: 31000'));
    const check = verifyEntry(dir, findEntry(dir, id));
    assert.equal(check.ok, false);
    assert.match(check.problems[0], /no longer matches/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reverting an entry that is itself a revert is refused', () => {
  const dir = tmpCopy();
  try {
    const claimPath = path.join(dir, '.manual', 'claims', 'tests.demo.md');
    const before = fs.readFileSync(claimPath, 'utf8');
    const a = appendEntry(dir, { entry: 'accept', claim: 'tests.demo', beforeText: before, afterText: before });
    fs.writeFileSync(claimPath, before.replace('max_ms: 30000', 'max_ms: 40000'));
    const r = appendEntry(dir, { entry: 'revert', claim: 'tests.demo', reverts: a.id, beforeText: 'x', afterText: before });
    assert.throws(() => restoreFromEntry(dir, findEntry(dir, r.id)), /itself a revert/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger records notable outcomes only, and merges trust across machines', () => {
  const dir = tmpCopy();
  try {
    assert.deepEqual(readLedger(dir), []);
    // A first verification is worth recording…
    let written = recordLedger(dir, [{
      stamp: { id: 'tests.demo', state: 'fresh', tier: 'silver', passes: 1, machines: { 'laptop-1': 1 }, measured_ms: 100 },
      prevStamp: null,
    }], { machine: 'laptop-1', at: '2026-01-01T00:00:00Z' });
    assert.equal(written.length, 1);
    assert.match(written[0].reason, /first-verified/);
    // …an unchanged repeat is not.
    written = recordLedger(dir, [{
      stamp: { id: 'tests.demo', state: 'fresh', tier: 'silver', passes: 2, machines: { 'laptop-1': 2 }, measured_ms: 100 },
      prevStamp: { id: 'tests.demo', state: 'fresh', passes: 1, machines: { 'laptop-1': 1 } },
    }], { machine: 'laptop-1', at: '2026-01-01T00:01:00Z' });
    assert.deepEqual(written, []);

    // A second machine earns a line, and the pass milestone does too.
    written = recordLedger(dir, [{
      stamp: { id: 'tests.demo', state: 'fresh', tier: 'silver', passes: 5, machines: { 'laptop-1': 3, 'ci-2': 2 }, measured_ms: 100 },
      prevStamp: { id: 'tests.demo', state: 'fresh', passes: 4, machines: { 'laptop-1': 3 } },
    }], { machine: 'ci-2', at: '2026-01-01T00:02:00Z' });
    assert.equal(written.length, 1);
    assert.match(written[0].reason, /new-machine/);
    assert.match(written[0].reason, /pass-milestone/);

    const stats = ledgerStats(dir, 'tests.demo');
    assert.equal(stats.passes, 5);
    assert.deepEqual(stats.machines, ['ci-2', 'laptop-1']);
    assert.equal(allLedgerStats(dir).get('tests.demo').machines.length, 2);

    // Gold requires passes AND machines, and only the ledger can supply both.
    assert.ok(stats.passes >= GOLD_PASSES && stats.machines.length >= GOLD_MACHINES);
    const merged = mergeTrust({ passes: 1, machines: { 'laptop-1': 1 } }, stats);
    assert.equal(merged.passes, 5);
    assert.deepEqual(Object.keys(merged.machines).sort(), ['ci-2', 'laptop-1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt ledger line is ignored rather than fatal', () => {
  const dir = tmpCopy();
  try {
    fs.writeFileSync(path.join(dir, '.manual', 'ledger.jsonl'), '{"id":"a","state":"fresh","machine":"m"}\nnot json\n');
    assert.equal(readLedger(dir).length, 1);
    assert.equal(ledgerStats(dir, 'a').passes, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('entryId is filename-safe and ordered', () => {
  const id = entryId('2026-09-21T19:03:21.430Z', 'tests.demo');
  assert.equal(id, 'T190321Z-tests.demo'.replace('T190321Z', '20260921T190321Z'));
  assert.ok(!/[:\/\\]/.test(id));
  assert.ok(entryId('2026-09-21T19:03:22Z', 'x') > id);
});
