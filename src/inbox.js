import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.js';
import { c } from './color.js';

// Inbox: candidate claims written by agent sessions at session end.
// Listed with `manual inbox`; a human promotes one with `manual inbox accept <file>`.
// If the candidate carries a `proposes.patch` (dotted key -> value), the patch
// is merged into the target claim's frontmatter instead of clobbering it.

// Structured inbox contents (no printing) — used by the report, the dashboard,
// and the MCP server. listInbox renders this.
export function readInbox(root) {
  const dir = path.join(root, '.manual', 'inbox');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const fm = m ? parseYaml(m[1]) : {};
      return {
        file: f,
        id: fm.id && fm.id !== 'candidate' ? fm.id : null,
        kind: fm.kind || null,
        proposes: fm.proposes || null,
        observation: fm.observation || null,
      };
    });
}

export function listInbox(root) {
  const dir = path.join(root, '.manual', 'inbox');
  if (!fs.existsSync(dir)) {
    console.log(c.grey('no inbox (nothing proposed yet)'));
    return [];
  }
  const candidates = readInbox(root);
  if (candidates.length === 0) {
    console.log(c.grey('inbox empty'));
    return [];
  }
  for (const cand of candidates) {
    console.log(`📥 ${cand.file}`);
    if (cand.proposes?.update) console.log(c.grey(`   proposes: update ${cand.proposes.update}`));
    if (cand.observation?.by) {
      console.log(c.grey(`   observed by ${cand.observation.by} at ${cand.observation.at || '?'}`));
    }
    const ev = (cand.observation?.evidence || '').toString();
    if (ev) console.log(c.grey(`   ${ev.slice(0, 120)}`));
  }
  return candidates.map((x) => x.file);
}

// Reject anything that is not a plain filename inside the inbox: the accept
// and preview paths take a filename from HTTP, and it must not be able to
// reach outside .manual/inbox/.
export function safeInboxName(file) {
  if (typeof file !== 'string' || file.length === 0) throw new Error('missing candidate filename');
  if (file !== path.basename(file) || file.includes('..') || file.includes('/') || file.includes('\\')) {
    throw new Error(`unsafe candidate name: ${file}`);
  }
  return file;
}

function getDotted(obj, keyPath) {
  let o = obj;
  for (const part of keyPath.split('.')) {
    if (o == null || typeof o !== 'object') return undefined;
    o = o[part];
  }
  return o;
}

// Set a dotted path (e.g. "check.expect.max_ms") inside a parsed frontmatter object.
function setDotted(obj, keyPath, value) {
  const parts = keyPath.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

// Serialize a frontmatter object back to YAML (subset emitter).
function stringifyFm(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) { out += `${pad}${k}: []\n`; continue; }
      out += `${pad}${k}:\n`;
      for (const item of v) {
        out += /^\d+$/.test(String(item)) || /[:{}\[\]]/.test(String(item))
          ? `${pad}  - ${JSON.stringify(item)}\n`
          : `${pad}  - ${item}\n`;
      }
    } else if (typeof v === 'object') {
      out += `${pad}${k}:\n${stringifyFm(v, indent + 1)}`;
    } else if (typeof v === 'string' && (v.includes(':') || v.includes('\n') || v.length > 90)) {
      out += `${pad}${k}: ${JSON.stringify(v)}\n`;
    } else {
      out += `${pad}${k}: ${v}\n`;
    }
  }
  return out;
}

// What would accepting this candidate do? Returned as data so a human can
// review the change before it lands (the CLI prints the result; the dashboard
// renders it behind a button). Never mutates anything.
export function previewInbox(root, file) {
  safeInboxName(file);
  const src = path.join(root, '.manual', 'inbox', file);
  if (!fs.existsSync(src)) throw new Error(`no such inbox candidate: ${file}`);
  const text = fs.readFileSync(src, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const fm = m ? parseYaml(m[1]) : {};
  const targetId = fm.proposes?.update;
  const patch = fm.proposes?.patch;

  if (targetId && patch && typeof patch === 'object') {
    const dest = path.join(root, '.manual', 'claims', `${targetId}.md`);
    if (!fs.existsSync(dest)) throw new Error(`target claim not found: claims/${targetId}.md`);
    const cm = fs.readFileSync(dest, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const before = cm ? parseYaml(cm[1]) : {};
    const changes = Object.entries(patch).map(([k, v]) => {
      const old = getDotted(before, k);
      return `- ${k}: ${JSON.stringify(old)}\n+ ${k}: ${JSON.stringify(v)}`;
    });
    return {
      file,
      mode: 'patch',
      target: `claims/${targetId}.md`,
      summary: `patches ${Object.keys(patch).join(', ')} in claims/${targetId}.md`,
      changes,
      diff: changes.join('\n'),
    };
  }

  const id = fm.id && fm.id !== 'candidate' ? fm.id : null;
  return {
    file,
    mode: 'whole',
    target: id ? `claims/${id}.md` : null,
    summary: id
      ? `moves inbox/${file} → claims/${id}.md (still needs a real check before it can verify)`
      : 'candidate has no id — cannot be accepted until it names one',
    changes: [],
    diff: text.split('\n').map((l) => `+ ${l}`).join('\n'),
  };
}

export function acceptInbox(root, file, { quiet = false } = {}) {
  safeInboxName(file);
  const dir = path.join(root, '.manual', 'inbox');
  const src = path.join(dir, file);
  if (!fs.existsSync(src)) throw new Error(`no such inbox candidate: ${file}`);
  const text = fs.readFileSync(src, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const fm = m ? parseYaml(m[1]) : {};
  const body = m ? (m[2] || '') : text;

  const targetId = fm.proposes?.update;
  const patch = fm.proposes?.patch;

  if (targetId && patch && typeof patch === 'object') {
    // Patch mode: merge into the existing claim file.
    const dest = path.join(root, '.manual', 'claims', `${targetId}.md`);
    if (!fs.existsSync(dest)) throw new Error(`target claim not found: ${dest}`);
    const claimText = fs.readFileSync(dest, 'utf8');
    const cm = claimText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!cm) throw new Error(`target claim has no frontmatter: ${dest}`);
    const claimFm = parseYaml(cm[1]);
    for (const [k, v] of Object.entries(patch)) setDotted(claimFm, k, v);
    const merged = `---\n${stringifyFm(claimFm)}---${cm[2]}`;
    fs.writeFileSync(dest, merged);
    fs.rmSync(src);
    if (!quiet) {
      console.log(`patched claims/${targetId}.md: ${Object.keys(patch).join(', ')} (from inbox/${file})`);
      console.log(c.yellow('Review the diff, then commit. The patch came from a session observation.'));
    }
    return dest;
  }

  // Whole-claim mode: move candidate into claims/ (id from frontmatter or filename).
  const id = fm.id && fm.id !== 'candidate' ? fm.id : null;
  if (!id) throw new Error('candidate has no id and no proposes.update — cannot derive target filename');
  const dest = path.join(root, '.manual', 'claims', `${id}.md`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.rmSync(src);
  if (!quiet) {
    console.log(`moved inbox/${file} → claims/${id}.md`);
    console.log(c.yellow('Next: convert it to a full claim (kind, statement, check) and review the diff.'));
  }
  return dest;
}
