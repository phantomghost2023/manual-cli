import fs from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { parseYaml, stringifyYaml } from './yaml.js';
import { splitFrontmatter } from './md.js';
import { sha256 } from './hash.js';

// The audit trail for changes to the manual.
//
// `.manual/undo/` gives an immediate, byte-exact revert, but it is local,
// pruned to 20 entries, and machine-specific. The journal is the durable
// counterpart: one markdown file per accepted change, committed to git, so a
// reader can see *why* a claim says what it says, and any checkout anywhere can
// revert it. It stores the exact previous file text, because "revert" that
// cannot reproduce the old bytes is not a revert.
//
// Entries are deliberately plain markdown with frontmatter: they review like
// the rest of the manual, and they diff like the rest of the manual.

export function journalDir(root) {
  return path.join(root, '.manual', 'journal');
}

const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export function entryId(at, claim) {
  return `${stamp(at)}-${claim || 'unknown'}`;
}

export function entryPath(root, id) {
  return path.join(journalDir(root), `${id}.md`);
}

// One entry per accepted change. `beforeText` is what makes it revertible.
export function appendEntry(root, entry) {
  const at = entry.at || new Date().toISOString();
  const id = entry.id || entryId(at, entry.claim);
  const dir = journalDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const fm = {
    schema: 'manual/v1',
    entry: entry.entry,
    id,
    at,
    machine: entry.machine || hostname(),
    claim: entry.claim || null,
    file: entry.file || null,
    mode: entry.mode || null,
    reason: entry.reason || null,
    reverts: entry.reverts || null,
    before_hash: entry.beforeText == null ? null : `sha256:${sha256(entry.beforeText).slice(0, 32)}`,
    after_hash: entry.afterText == null ? null : `sha256:${sha256(entry.afterText).slice(0, 32)}`,
    verdict: entry.verdict || null,
    before_text: entry.beforeText == null ? null : entry.beforeText,
    // The candidate's own text, so a revert can put the proposal back in the
    // inbox. Without it, reverting a whole-claim accept deletes the claim and
    // silently loses the file that argued for it.
    candidate_text: entry.candidateText == null ? null : entry.candidateText,
  };
  const lines = [];
  lines.push(entryReasonLine(entry));
  if (entry.diff) lines.push('', '```diff', entry.diff.trim(), '```');
  if (entry.candidateBody) lines.push('', 'Why the proposal existed:', '', quote(entry.candidateBody));
  if (entry.verdict) {
    lines.push('', `Verify after the change: **${entry.verdict.state}**` +
      (entry.verdict.measured_ms != null ? ` (${entry.verdict.measured_ms}ms)` : '') +
      (entry.verdict.note ? ` — ${entry.verdict.note}` : ''));
  }
  const text = `---\n${stringifyYaml(fm)}---\n${lines.join('\n').trim()}\n`;
  fs.writeFileSync(entryPath(root, id), text);
  return { id, path: entryPath(root, id) };
}

function entryReasonLine(entry) {
  const what = {
    accept: `Accepted \`${entry.file}\``,
    undo: `Undid the accepted proposal \`${entry.file}\``,
    revert: `Reverted \`${entry.reverts || 'a previous entry'}\``,
  }[entry.entry] || `Journal entry ${entry.entry}`;
  return entry.reason ? `${what}: ${entry.reason}` : what;
}

const quote = (text) => String(text).trim().split('\n').map((l) => `> ${l}`).join('\n');

export function readJournal(root) {
  const dir = journalDir(root);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const entries = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const { fm: fmRaw, body } = splitFrontmatter(text);
    const fm = fmRaw ? parseYaml(fmRaw) : {};
    entries.push({ ...fm, file_name: f, body: body.trim() });
  }
  return entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

// Accept a short id, a full filename, or an unambiguous prefix.
export function findEntry(root, idOrFile) {
  const entries = readJournal(root);
  const needle = String(idOrFile || '').replace(/\.md$/, '');
  const exact = entries.filter((e) => e.id === needle || e.file_name.replace(/\.md$/, '') === needle);
  if (exact.length === 1) return exact[0];
  const prefix = entries.filter((e) => String(e.id).startsWith(needle) || String(e.file_name).startsWith(needle));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) throw new Error(`ambiguous journal id "${idOrFile}" matches ${prefix.length} entries`);
  return null;
}

// Restore the claim file to its exact previous content. Returns whatever is
// needed for the caller to re-verify and to journal the revert itself.
export function restoreFromEntry(root, entry) {
  if (entry.entry === 'revert') throw new Error('that entry is itself a revert — revert the original accept instead');
  if (!entry.claim) throw new Error(`journal entry ${entry.id} records no claim`);
  if (entry.before_text == null && entry.mode !== 'whole') {
    throw new Error(`journal entry ${entry.id} has no before_text to restore`);
  }
  const target = path.join(root, '.manual', 'claims', `${entry.claim}.md`);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const inboxRestored = restoreCandidate(root, entry);
  // A whole-claim candidate had no predecessor: undoing it means removing the
  // claim file it created, not restoring text that never existed.
  if (entry.before_text == null) {
    if (current == null) {
      return { claim: entry.claim, path: target, changed: false, beforeText: null, afterText: null, inboxRestored };
    }
    fs.rmSync(target, { force: true });
    return { claim: entry.claim, path: target, changed: true, beforeText: current, afterText: null, inboxRestored };
  }
  if (current === entry.before_text) {
    return { claim: entry.claim, path: target, changed: false, beforeText: current, afterText: entry.before_text, inboxRestored };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, entry.before_text);
  return { claim: entry.claim, path: target, changed: true, beforeText: current, afterText: entry.before_text, inboxRestored };
}

// Put the accepted candidate back where it came from, so the proposal is still
// reviewable after its acceptance has been reverted.
function restoreCandidate(root, entry) {
  const text = entry.candidate_text;
  if (text == null) return null;
  const name = String(entry.file || '').replace(/\\/g, '/').split('/').pop();
  if (!name || name.includes('..')) return null;
  const dir = path.join(root, '.manual', 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') !== text) return `kept the candidate already in the inbox (${name})`;
  fs.writeFileSync(dest, text);
  return name;
}

// Has the claim moved on since this entry left it? A byte-exact restore is the
// right semantics for a revert, but it silently discards anything written after
// the accepted change — so the caller must be able to tell, and a human must
// decide. Returns null when there is nothing to lose.
export function entryDrift(root, entry) {
  if (entry.entry === 'revert' || !entry.claim || !entry.after_hash) return null;
  const target = path.join(root, '.manual', 'claims', `${entry.claim}.md`);
  if (!fs.existsSync(target)) return null; // the claim is gone: nothing to overwrite
  const text = fs.readFileSync(target, 'utf8');
  const actual = `sha256:${sha256(text).slice(0, 32)}`;
  if (actual === entry.after_hash) return null;
  return { claim: entry.claim, expected: entry.after_hash, actual };
}

export function verifyEntry(root, entry) {
  const target = path.join(root, '.manual', 'claims', `${entry.claim}.md`);
  if (!fs.existsSync(target)) return { ok: false, problems: ['claim file is missing'] };
  const text = fs.readFileSync(target, 'utf8');
  const problems = [];
  if (entry.after_hash && `sha256:${sha256(text).slice(0, 32)}` !== entry.after_hash) {
    problems.push('claim file no longer matches the content this entry recorded');
  }
  if (!/^---\r?\n/.test(text)) problems.push('claim file lost its frontmatter');
  return { ok: problems.length === 0, problems };
}
