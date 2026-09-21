import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewInbox, safeInboxName, readInbox } from '../src/inbox.js';
import { readJournal } from '../src/journal.js';
import { startServer } from '../src/serve.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.join(here, '..', 'demo');

const tmpCopy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-inbox-'));
  fs.cpSync(demo, dir, { recursive: true });
  fs.rmSync(path.join(dir, '.manual', 'state.json'), { force: true });
  return dir;
};

test('candidate names cannot escape the inbox directory', () => {
  assert.equal(safeInboxName('2026-09-21-x.md'), '2026-09-21-x.md');
  // The path people actually paste — the one `manual inbox list` and `init`
  // print — resolves to the same plain filename instead of erroring out.
  assert.equal(safeInboxName('.manual/inbox/2026-09-21-x.md'), '2026-09-21-x.md');
  assert.equal(safeInboxName('inbox/2026-09-21-x.md'), '2026-09-21-x.md');
  for (const bad of ['../claims/x.md', '..\\claims\\x.md', 'sub/x.md', '', 'a/../b', '/etc/passwd', 'C:/tmp/.manual/inbox-other/x.md', null, 42]) {
    assert.throws(() => safeInboxName(bad), /unsafe candidate name|missing candidate filename/);
  }
});

test('previewing a patch candidate shows the before/after and mutates nothing', () => {
  const dir = tmpCopy();
  try {
    const target = path.join(dir, '.manual', 'claims', 'tests.demo.md');
    const before = fs.readFileSync(target, 'utf8');
    const p = previewInbox(dir, '2026-09-21-tighten-demo-tests.md');
    assert.equal(p.mode, 'patch');
    assert.equal(p.target, 'claims/tests.demo.md');
    assert.match(p.summary, /patches check\.expect\.max_ms in claims\/tests\.demo\.md/);
    assert.match(p.diff, /- check\.expect\.max_ms: 30000/);
    assert.match(p.diff, /\+ check\.expect\.max_ms: 10000/);
    assert.equal(fs.readFileSync(target, 'utf8'), before, 'preview must not write');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('previewing a whole-claim candidate renders it as additions', () => {
  const dir = tmpCopy();
  try {
    fs.writeFileSync(
      path.join(dir, '.manual', 'inbox', 'whole.md'),
      '---\nid: new.claim\nkind: fact\nstatement: x\n---\nbody text\n',
    );
    const p = previewInbox(dir, 'whole.md');
    assert.equal(p.mode, 'whole');
    assert.equal(p.target, 'claims/new.claim.md');
    assert.ok(p.diff.split('\n').every((l) => l.startsWith('+ ')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a candidate with no id explains why it cannot be accepted', () => {
  const dir = tmpCopy();
  try {
    fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'unfinished.md'), '---\nid: candidate\n---\nnotes\n');
    const p = previewInbox(dir, 'unfinished.md');
    assert.equal(p.target, null);
    assert.match(p.summary, /cannot be accepted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readInbox returns structured candidates', () => {
  const candidates = readInbox(demo);
  assert.ok(candidates.length >= 1);
  const c = candidates[0];
  assert.equal(typeof c.file, 'string');
  assert.ok('proposes' in c && 'observation' in c);
});

test('inbox JSON endpoints preview and accept over HTTP', async () => {
  const dir = tmpCopy();
  const s = await startServer(dir, { port: 0 });
  try {
    const list = await (await fetch(s.url + 'api/inbox')).json();
    assert.ok(list.candidates.some((c) => c.file === '2026-09-21-tighten-demo-tests.md'));

    const pre = await (await fetch(s.url + 'api/inbox/preview?file=2026-09-21-tighten-demo-tests.md')).json();
    assert.equal(pre.mode, 'patch');
    assert.match(pre.diff, /max_ms/);

    const traversal = await fetch(s.url + 'api/inbox/preview?file=' + encodeURIComponent('../claims/tests.demo.md'));
    assert.equal(traversal.status, 400);
    assert.match((await traversal.json()).error, /unsafe/);

    const accepted = await fetch(s.url + 'api/inbox/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: '2026-09-21-tighten-demo-tests.md' }),
    });
    assert.equal(accepted.status, 200);
    const claim = fs.readFileSync(path.join(dir, '.manual', 'claims', 'tests.demo.md'), 'utf8');
    assert.match(claim, /max_ms: 10000/, 'the patch landed in the claim frontmatter');
    assert.ok(!fs.existsSync(path.join(dir, '.manual', 'inbox', '2026-09-21-tighten-demo-tests.md')), 'candidate consumed');

    const missing = await fetch(s.url + 'api/inbox/accept', { method: 'POST', body: '{}' });
    assert.equal(missing.status, 400);

    // The accepted change is now in the committed journal, and the dashboard's
    // revert endpoint runs the same code path as `manual journal revert`.
    const entries = readJournal(dir);
    assert.equal(entries.length, 1);
    const acceptedEntry = entries[0];
    assert.equal(acceptedEntry.entry, 'accept');
    assert.equal(acceptedEntry.claim, 'tests.demo');
    const before = fs.readFileSync(path.join(dir, '.manual', 'claims', 'tests.demo.md'), 'utf8');

    const reverted = await fetch(s.url + 'api/journal/revert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: acceptedEntry.id }),
    });
    assert.equal(reverted.status, 200);
    const rv = await reverted.json();
    assert.equal(rv.reverted, true);
    assert.equal(rv.verified.state, 'fresh');
    const after = fs.readFileSync(path.join(dir, '.manual', 'claims', 'tests.demo.md'), 'utf8');
    assert.doesNotMatch(after, /max_ms: 10000/, 'the patched bound is gone again');
    assert.equal(readJournal(dir).length, 2, 'the revert is journaled as its own entry');

    const bad = await fetch(s.url + 'api/journal/revert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope' }),
    });
    assert.equal(bad.status, 400);
    assert.ok(before.length > 0);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
