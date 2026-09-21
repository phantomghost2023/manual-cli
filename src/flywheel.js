import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { previewInbox, acceptInbox, safeInboxName } from './inbox.js';
import { verify } from './verify.js';

// The flywheel's missing half.
//
// A proposal is an *observation*: "runs take 210ms, the bound says 30s, tighten
// to 10s". Accepting it used to mean trusting the observation. Now the accepted
// claim is immediately re-verified — with force, because a proposal that only
// edits the claim's own frontmatter may not move the claim's evidence digest at
// all. If the proposal turns out to be false, the claim goes broken and an undo
// snapshot is left on disk.
//
// Snapshots are persisted under .manual/undo/ rather than held in memory: an
// in-memory token is useless to the CLI (a new process per command) and dies
// with the dashboard, which are exactly the moments somebody wants to undo.

const UNDO_DIR = ['.manual', 'undo'];
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function undoDir(root) {
  return path.join(root, ...UNDO_DIR);
}

function snapshotPath(root, token) {
  return path.join(undoDir(root), `${token}.json`);
}

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function pruneSnapshots(root, keep = 20) {
  const dir = undoDir(root);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  if (files.length <= keep) return;
  const byAge = files
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of byAge.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
}

function saveSnapshot(root, snap) {
  const dir = undoDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(snapshotPath(root, snap.token), JSON.stringify(snap, null, 2) + '\n');
  pruneSnapshots(root);
}

function loadSnapshot(root, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null; // also blocks traversal
  const p = snapshotPath(root, token);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// What is waiting to be undone, if anything. Contents are deliberately not
// exposed: callers only need to know an undo is available.
export function pendingUndo(root, token) {
  const snap = loadSnapshot(root, token);
  if (!snap) return null;
  return { token: snap.token, file: snap.file, claimId: snap.claimId, mode: snap.mode, at: snap.at };
}

export function listUndos(root) {
  const dir = undoDir(root);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const snap = loadSnapshot(root, f.replace(/\.json$/, ''));
      return snap ? { token: snap.token, file: snap.file, claimId: snap.claimId, mode: snap.mode, at: snap.at } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Accept a candidate, then make it prove itself. The result carries the verify
// verdict and the undo token; nothing is rolled back automatically — a human
// decides, with the evidence in front of them.
export async function acceptAndVerify(root, file, { state, quiet = false } = {}) {
  safeInboxName(file);
  const preview = previewInbox(root, file);
  const candidateText = readOrNull(path.join(root, '.manual', 'inbox', file));
  const targetRel = preview.target;
  const claimId = targetRel ? targetRel.replace(/^claims\//, '').replace(/\.md$/, '') : null;
  const targetPath = targetRel ? path.join(root, '.manual', targetRel.split('/').join(path.sep)) : null;
  const targetBefore = targetPath ? readOrNull(targetPath) : null;

  // acceptInbox's own chatter ("review the diff, then commit") is stale here:
  // this path reports the accept and its verdict together, after verifying.
  const dest = acceptInbox(root, file, { quiet: true });

  const token = randomUUID();
  saveSnapshot(root, {
    token,
    file,
    mode: preview.mode,
    claimId,
    targetRel,
    targetBefore,
    candidateText,
    at: new Date().toISOString(),
  });

  let verified = null;
  if (claimId) {
    const res = await verify(root, { state, force: true, only: [claimId] });
    const r = res.results.find((x) => x.claim.fm.id === claimId);
    if (r) {
      verified = {
        id: claimId,
        state: r.stamp.state,
        tier: r.stamp.tier,
        note: r.stamp.note || null,
        measured_ms: r.stamp.measured_ms ?? null,
        ran: !r.skipped,
        load_errors: res.errors,
      };
    }
  }

  const ok = verified ? verified.state === 'fresh' : null;
  if (!quiet) {
    const verdict = ok === null ? 'accepted (no claim to verify)' : ok ? 'verified: fresh' : `broke it: ${verified.note}`;
    console.log(`proposal ${file}: ${verdict}`);
    if (ok === false) console.log(`  undo with:  manual inbox undo ${token}`);
  }
  return { accepted: true, file, dest, preview, verified, ok, token };
}

// Restore the claim file and put the candidate back in the inbox. Undo is a
// file operation; proving the restore is a separate verify.
export function undoAccept(root, token) {
  const snap = loadSnapshot(root, token);
  if (!snap) throw new Error('no such undo token (already used, or pruned from .manual/undo/)');
  if (snap.candidateText != null) {
    fs.mkdirSync(path.join(root, '.manual', 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(root, '.manual', 'inbox', snap.file), snap.candidateText);
  }
  if (snap.targetRel) {
    const targetPath = path.join(root, '.manual', snap.targetRel.split('/').join(path.sep));
    if (snap.targetBefore == null) fs.rmSync(targetPath, { force: true });
    else fs.writeFileSync(targetPath, snap.targetBefore);
  }
  fs.rmSync(snapshotPath(root, token), { force: true });
  return { undone: true, file: snap.file, claimId: snap.claimId, mode: snap.mode };
}

export async function undoAndVerify(root, token, { state, quiet = false } = {}) {
  const res = undoAccept(root, token);
  let verified = null;
  if (res.claimId) {
    const out = await verify(root, { state, force: true, only: [res.claimId] });
    const r = out.results.find((x) => x.claim.fm.id === res.claimId);
    if (r) verified = { id: res.claimId, state: r.stamp.state, tier: r.stamp.tier, note: r.stamp.note || null };
  }
  if (!quiet) {
    console.log(`undo ${res.file}: claim ${res.claimId || '(none)'} restored${verified ? ` → ${verified.state}` : ''}`);
  }
  return { ...res, verified };
}
