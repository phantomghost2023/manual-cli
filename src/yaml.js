// Minimal YAML subset parser for claim frontmatter.
// Recursive descent over indented lines. Supports:
//   maps, block arrays (of scalars, flow maps, or inline maps spanning lines),
//   flow maps/arrays, block scalars (|, >, with - chomping), quoted strings,
//   numbers, booleans, null. Deliberately tiny; not a general YAML impl.

const stripQuotes = (s) => {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    // Double-quoted: escape sequences are processed (JSON-style).
    let out = '';
    for (let i = 1; i < t.length - 1; i++) {
      if (t[i] === '\\' && i + 1 < t.length - 1) {
        const n = t[i + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        i++;
      } else {
        out += t[i];
      }
    }
    return out;
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    // Single-quoted: backslashes stay literal (regex-friendly), '' escapes a quote.
    let out = '';
    for (let i = 1; i < t.length - 1; i++) {
      if (t[i] === "'" && t[i + 1] === "'") {
        out += "'";
        i++;
      } else {
        out += t[i];
      }
    }
    return out;
  }
  return t;
};

const scalar = (s) => {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return stripQuotes(t);
};

// Split "a, [b, c], {d: 1, e: 2}" on top-level commas (quote/depth aware).
function splitFlowItems(s) {
  const items = [];
  let depth = 0, cur = '', q = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

// Parse a flow scalar, [ ... ] or { ... } (nested).
export function parseFlow(s) {
  const t = s.trim();
  if (t.startsWith('[')) {
    if (t === '[]') return [];
    return splitFlowItems(t.slice(1, -1)).map(parseFlow);
  }
  if (t.startsWith('{')) {
    if (t === '{}') return {};
    const obj = {};
    for (const item of splitFlowItems(t.slice(1, -1))) {
      const i = item.indexOf(':');
      if (i === -1) { obj[stripQuotes(item)] = null; continue; }
      obj[stripQuotes(item.slice(0, i))] = parseFlow(item.slice(i + 1));
    }
    return obj;
  }
  return scalar(t);
}

const indentOf = (line) => line.match(/^ */)[0].length;
const isSkippable = (line) => line.trim() === '' || line.trim().startsWith('#');
const KV_RE = /^([^:#]+?)\s*:\s*(.*)$/;

function skipBlanks(lines, i) {
  while (i < lines.length && isSkippable(lines[i])) i++;
  return i;
}

function parseNode(lines, i, minIndent) {
  const j = skipBlanks(lines, i);
  if (j >= lines.length) return { value: null, end: j };
  const ind = indentOf(lines[j]);
  if (ind < minIndent) return { value: null, end: j };
  const t = lines[j].trim();
  if (t === '-' || t.startsWith('- ')) return parseSequence(lines, j, ind);
  return parseMap(lines, j, ind);
}

function parseMap(lines, i, indent) {
  const obj = {};
  let k = i;
  while (true) {
    k = skipBlanks(lines, k);
    if (k >= lines.length) break;
    const ind = indentOf(lines[k]);
    if (ind < indent) break;
    const line = lines[k].trim();
    if (line.startsWith('- ') || line === '-') break; // caller decides
    const m = line.match(KV_RE);
    if (!m) { k++; continue; } // defensive: ignore stray line
    const key = stripQuotes(m[1].trim());
    const rest = (m[2] ?? '').trim();

    if (rest === '') {
      const j = skipBlanks(lines, k + 1);
      if (j < lines.length && indentOf(lines[j]) > ind) {
        const { value, end } = parseNode(lines, j, ind + 1);
        obj[key] = value;
        k = end;
      } else {
        obj[key] = null;
        k = k + 1;
      }
      continue;
    }

    if (/^[>|][+-]?$/.test(rest)) {
      // block scalar; keep newlines, chomp trailing on '-'
      const chomp = rest.includes('-');
      const buf = [];
      let contentIndent = null;
      let n = k + 1;
      while (n < lines.length) {
        const l = lines[n];
        if (l.trim() === '') { buf.push(''); n++; continue; }
        const li = indentOf(l);
        if (li <= ind) break;
        if (contentIndent === null) contentIndent = li;
        buf.push(l.slice(Math.min(contentIndent, l.length)));
        n++;
      }
      let text = buf.join('\n');
      if (chomp) text = text.replace(/\n+$/, '');
      obj[key] = text;
      k = n;
      continue;
    }

    obj[key] = parseFlow(rest);
    k = k + 1;
  }
  return { value: obj, end: k };
}

function parseSequence(lines, i, indent) {
  const arr = [];
  let k = i;
  while (true) {
    k = skipBlanks(lines, k);
    if (k >= lines.length) break;
    const ind = indentOf(lines[k]);
    if (ind !== indent) break;
    const t = lines[k].trim();
    if (!(t === '-' || t.startsWith('- '))) break;

    if (t === '-') {
      const { value, end } = parseNode(lines, k + 1, ind + 1);
      arr.push(value);
      k = Math.max(end, k + 1);
      continue;
    }

    const content = t.slice(2).trim();
    if (content.startsWith('{') || content.startsWith('[')) {
      arr.push(parseFlow(content));
      k = k + 1;
      continue;
    }
    if (KV_RE.test(content) && !/^"|'/i.test(content)) {
      // "- key: v" starts an inline map; rewrite so continuation lines join it.
      const mutated = lines.slice();
      mutated[k] = lines[k].replace(/^(\s*)-\s/, '$1  ');
      const { value, end } = parseNode(mutated, k, ind + 1);
      arr.push(value === null ? scalar(content) : value);
      k = Math.max(end, k + 1);
      continue;
    }
    // Plain scalar item (possibly quoted).
    arr.push(scalar(content));
    k = k + 1;
  }
  return { value: arr, end: k };
}

export function parseYaml(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const { value } = parseNode(lines, 0, 0);
  return value ?? {};
}
