import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { previewInbox, acceptInbox, safeInboxName, readInbox } from './inbox.js';
import { verify } from './verify.js';
import { appendEntry, findEntry, restoreFromEntry } from './journal.js';

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
  // Everything below joins paths with this name; using the raw argument meant
  // an accepted path form (`.manual/inbox/x.md`) produced an inbox path inside
  // the inbox, so the candidate text was silently not recorded.
  const name = safeInboxName(file);
  const preview = previewInbox(root, name);
  const candidateText = readOrNull(path.join(root, '.manual', 'inbox', name));
  const targetRel = preview.target;
  const claimId = targetRel ? targetRel.replace(/^claims\//, '').replace(/\.md$/, '') : null;
  const targetPath = targetRel ? path.join(root, '.manual', targetRel.split('/').join(path.sep)) : null;
  const targetBefore = targetPath ? readOrNull(targetPath) : null;
  // Read the candidate before accepting it — accepting consumes the file, and
  // its stated evidence is the reason the journal needs to record.
  const cand = readInbox(root).find((c) => c.file === name);

  // acceptInbox's own chatter ("review the diff, then commit") is stale here:
  // this path reports the accept and its verdict together, after verifying.
  const dest = acceptInbox(root, name, { quiet: true });

  const at = new Date().toISOString();
  const token = randomUUID();
  // Saved before the (slow) verify so a crash mid-verify still leaves an undo.
  saveSnapshot(root, {
    token,
    file: name,
    mode: preview.mode,
    claimId,
    targetRel,
    targetBefore,
    candidateText,
    at,
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

  // The journal is the durable half of undo: committed to git, portable to any
  // checkout, and carrying the reason the change was made.
  const reason = cand?.observation?.evidence
    ? String(cand.observation.evidence).replace(/\s+/g, ' ').trim()
    : preview.summary;
  const afterText = targetPath ? readOrNull(targetPath) : null;
  const { id: journalId } = appendEntry(root, {
    entry: 'accept',
    at,
    claim: claimId,
    file: name,
    mode: preview.mode,
    reason,
    diff: preview.diff,
    candidateBody: preview.body,
    candidateText,
    beforeText: targetBefore,
    afterText,
    verdict: verified,
  });
  // Re-save with the journal id so an undo can point at the entry it reverses.
  const snap = loadSnapshot(root, token);
  if (snap) saveSnapshot(root, { ...snap, journalId });

  const ok = verified ? verified.state === 'fresh' : null;
  if (!quiet) {
    const verdict = ok === null ? 'accepted (no claim to verify)' : ok ? 'verified: fresh' : `broke it: ${verified.note}`;
    console.log(`proposal ${name}: ${verdict}`);
    console.log(`  journaled:  .manual/journal/${journalId}.md`);
    if (ok === false) console.log(`  undo with:  manual inbox undo ${token}`);
  }
  return { accepted: true, file: name, dest, preview, verified, ok, token, journalId };
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
  return {
    undone: true,
    file: snap.file,
    claimId: snap.claimId,
    mode: snap.mode,
    journalId: snap.journalId || null,
    beforeText: snap.targetBefore,
    afterText: snap.targetRel ? readOrNull(path.join(root, '.manual', snap.targetRel.split('/').join(path.sep))) : null,
  };
}

export async function undoAndVerify(root, token, { state, quiet = false } = {}) {
  const res = undoAccept(root, token);
  const verified = res.claimId ? await safeVerifyOnly(root, res.claimId, state) : null;
  // An undone proposal is still part of the record: the journal should show
  // that someone tried this and it did not survive.
  const { id: journalId } = appendEntry(root, {
    entry: 'undo',
    claim: res.claimId,
    file: res.file,
    mode: res.mode,
    reason: 'the accepted proposal failed its own check',
    reverts: res.journalId || null,
    diff: diffLines(res.afterText, res.beforeText),
    beforeText: res.afterText,
    afterText: res.beforeText,
    verdict: verified,
  });
  if (!quiet) {
    console.log(`undo ${res.file}: claim ${res.claimId || '(none)'} restored${verified ? ` → ${verified.state}` : ''}`);
    console.log(`  journaled:  .manual/journal/${journalId}.md`);
  }
  return { ...res, verified, journalId };
}

// Revert an accepted change from its journal entry — the portable path, for
// when the local undo snapshot is gone, pruned, or on another machine.
export async function revertFromJournal(root, idOrFile, { state, quiet = false } = {}) {
  const entry = findEntry(root, idOrFile);
  if (!entry) throw new Error(`no journal entry matching "${idOrFile}"`);
  const restored = restoreFromEntry(root, entry);
  let verified = null;
  if (restored.claim) {
    verified = await safeVerifyOnly(root, restored.claim, state);
  }
  const { id: journalId } = appendEntry(root, {
    entry: 'revert',
    claim: restored.claim,
    file: entry.file,
    mode: entry.mode,
    reason: `restored the content recorded before ${entry.id}`,
    reverts: entry.id,
    diff: diffLines(restored.beforeText, entry.before_text),
    beforeText: restored.beforeText,
    afterText: entry.before_text,
    verdict: verified,
  });
  if (!quiet) {
    console.log(`reverted ${entry.id}: ${restored.claim} restored${verified ? ` → ${verified.state}` : ''}`);
    if (restored.inboxRestored) console.log(`  candidate back in the inbox: inbox/${restored.inboxRestored}`);
    console.log(`  journaled:  .manual/journal/${journalId}.md`);
  }
  return {
    reverted: true,
    entry: entry.id,
    claim: restored.claim,
    changed: restored.changed,
    inboxRestored: restored.inboxRestored ?? null,
    verified,
    journalId,
  };
}

// A revert that removes the last claim leaves nothing to verify, and a verify
// that cannot run must not make a successful file restore look like a failure.
// (Found by reverting the only claim in a real repository.)
async function safeVerifyOnly(root, claimId, state) {
  try {
    const out = await verify(root, { state, force: true, only: [claimId] });
    const r = out.results.find((x) => x.claim.fm.id === claimId);
    if (r) return { id: claimId, state: r.stamp.state, tier: r.stamp.tier, note: r.stamp.note || null };
    return { id: claimId, state: 'unknown', tier: null, note: 'the claim no longer exists, so there is nothing to verify' };
  } catch (e) {
    return { id: claimId, state: 'unknown', tier: null, note: `could not verify: ${e.message}` };
  }
}

// Crude line diff for journal bodies: enough to read the shape of a change at
// a glance next to a git history that holds the exact bytes.
function diffLines(before, after) {
  const b = before == null ? [] : String(before).split('\n');
  const a = after == null ? [] : String(after).split('\n');
  const bSet = new Set(b);
  const aSet = new Set(a);
  const out = [];
  for (const line of b) if (!aSet.has(line)) out.push(`- ${line}`);
  for (const line of a) if (!bSet.has(line)) out.push(`+ ${line}`);
  return out.slice(0, 60).join('\n');
}
