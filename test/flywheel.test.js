import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptAndVerify, undoAndVerify, pendingUndo, listUndos, undoAccept } from '../src/flywheel.js';
import { verify } from '../src/verify.js';
import { State } from '../src/state.js';
import { startServer } from '../src/serve.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.join(here, '..', 'demo');

const tmpCopy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-fw-'));
  fs.cpSync(demo, dir, { recursive: true });
  fs.rmSync(path.join(dir, '.manual', 'state.json'), { force: true });
  fs.rmSync(path.join(dir, '.manual', 'inbox'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.manual', 'inbox'), { recursive: true });
  return dir;
};

// A candidate that patches tests.demo's expected exit code to something the
// check can never produce: the claim is guaranteed to go broken.
const falseCandidate = `---
schema: manual/v1
id: candidate.false
kind: candidate
proposes:
  update: tests.demo
  patch:
    check.expect.exit: 3
observation:
  at: 2026-09-21T00:00:00Z
  by: agent:test
  evidence: "an observation that is simply wrong"
review:
  needed: human-approve
---
This proposal is false on purpose.
`;

const trueCandidate = `---
schema: manual/v1
id: candidate.true
kind: candidate
proposes:
  update: tests.demo
  patch:
    check.expect.max_ms: 300000
observation:
  at: 2026-09-21T00:00:00Z
  by: agent:test
  evidence: "generous but true"
review:
  needed: human-approve
---
A proposal that is true and should survive verification.
`;

test('verify --only runs the named claim plus its dependencies, and nothing else', async () => {
  const dir = tmpCopy();
  try {
    const state = new State(dir);
    const res = await verify(dir, { state, force: true, only: ['tests.demo'] });
    // tooling.node-esm is a required dependency: without it stamped, tests.demo
    // would report `blocked`, which says nothing about tests.demo itself.
    assert.deepEqual(res.results.map((r) => r.claim.fm.id).sort(), ['tests.demo', 'tooling.node-esm']);
    assert.ok(res.results.every((r) => r.stamp.state === 'fresh'), 'both run fresh, not blocked');
    state.save();
    assert.equal(state.stamp('policy.tests-registered'), null, 'unrelated claims are left alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an accepted proposal that is true is verified and kept', async () => {
  const dir = tmpCopy();
  try {
    fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'true.md'), trueCandidate);
    const state = new State(dir);
    const res = await acceptAndVerify(dir, 'true.md', { state, quiet: true });
    assert.equal(res.ok, true);
    assert.equal(res.verified.id, 'tests.demo');
    assert.equal(res.verified.state, 'fresh');
    assert.equal(res.verified.ran, true, 'the claim was actually executed, not skipped');
    assert.ok(res.token);
    assert.match(fs.readFileSync(path.join(dir, '.manual', 'claims', 'tests.demo.md'), 'utf8'), /max_ms: 300000/);
    assert.ok(!fs.existsSync(path.join(dir, '.manual', 'inbox', 'true.md')), 'candidate consumed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a proposal that turns out false is reported broken and can be undone', async () => {
  const dir = tmpCopy();
  try {
    const claimPath = path.join(dir, '.manual', 'claims', 'tests.demo.md');
    const original = fs.readFileSync(claimPath, 'utf8');
    fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'false.md'), falseCandidate);
    const state = new State(dir);

    const res = await acceptAndVerify(dir, 'false.md', { state, quiet: true });
    assert.equal(res.ok, false);
    assert.equal(res.verified.state, 'broken');
    assert.match(res.verified.note, /exit/);
    assert.equal(state.stamp('tests.demo').state, 'broken', 'the stamp reflects the failed proposal');
    state.save();

    // and the undo token restores both the claim and the candidate
    const undone = await undoAndVerify(dir, res.token, { state, quiet: true });
    assert.equal(undone.undone, true);
    assert.equal(undone.claimId, 'tests.demo');
    assert.equal(undone.verified.state, 'fresh', 'restoring the claim makes it fresh again');
    assert.equal(fs.readFileSync(claimPath, 'utf8'), original, 'claim file byte-identical to before');
    assert.ok(fs.existsSync(path.join(dir, '.manual', 'inbox', 'false.md')), 'candidate returned to the inbox');

    // tokens are single-use
    await assert.rejects(undoAndVerify(dir, res.token, { state, quiet: true }), /no such undo token/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('undo survives the process that accepted the proposal', async () => {
  const dir = tmpCopy();
  try {
    fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'true2.md'), trueCandidate);
    const res = await acceptAndVerify(dir, 'true2.md', { state: new State(dir), quiet: true });
    // The snapshot lives on disk, so a later process (the CLI, or a restarted
    // dashboard) can still act on the token.
    const snapFile = path.join(dir, '.manual', 'undo', `${res.token}.json`);
    assert.ok(fs.existsSync(snapFile), 'snapshot persisted under .manual/undo/');
    const pending = pendingUndo(dir, res.token);
    assert.equal(pending.claimId, 'tests.demo');
    assert.equal(pending.mode, 'patch');
    assert.equal(pending.candidateText, undefined, 'pendingUndo never exposes file contents');
    assert.deepEqual(listUndos(dir).map((u) => u.file), ['true2.md']);

    const undone = await undoAndVerify(dir, res.token, { state: new State(dir), quiet: true });
    assert.equal(undone.undone, true);
    assert.ok(!fs.existsSync(snapFile), 'snapshot consumed by the undo');
    assert.deepEqual(listUndos(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an undo token cannot be used to read files outside .manual/undo', () => {
  const dir = tmpCopy();
  try {
    assert.equal(pendingUndo(dir, '../../state.json'), null);
    assert.throws(() => undoAccept(dir, '../../../etc/passwd'), /no such undo token/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('accepting over HTTP returns the verdict and an undo token', async () => {
  const dir = tmpCopy();
  fs.writeFileSync(path.join(dir, '.manual', 'inbox', 'false.md'), falseCandidate);
  const s = await startServer(dir, { port: 0 });
  try {
    const r = await fetch(s.url + 'api/inbox/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'false.md' }),
    });
    const j = await r.json();
    assert.equal(r.status, 409, `a false proposal is a conflict, not a success (got ${JSON.stringify(j)})`);
    assert.equal(j.verified.state, 'broken');
    assert.ok(j.token);

    const undo = await fetch(s.url + 'api/inbox/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: j.token }),
    });
    assert.equal(undo.status, 200);
    const u = await undo.json();
    assert.equal(u.verified.state, 'fresh');

    const bad = await fetch(s.url + 'api/inbox/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
