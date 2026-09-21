import fs from 'node:fs';
import path from 'node:path';

// Expand {a,b,c} groups (single level per pass, recursive for nesting).
export function expandBraces(pattern) {
  const m = pattern.match(/\{([^{}]+)\}/);
  if (!m) return [pattern];
  const out = [];
  for (const opt of m[1].split(',')) {
    const candidate = pattern.slice(0, m.index) + opt + pattern.slice(m.index + m[0].length);
    out.push(...expandBraces(candidate));
  }
  return out;
}

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\/+/, '');

// Compile a glob pattern into a list of RegExps (one per brace expansion).
export function globToRegExp(pattern) {
  return expandBraces(norm(pattern)).map((p) => {
    let re = '';
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === '*') {
        if (p[i + 1] === '*') {
          re += '.*';
          i++;
          if (p[i + 1] === '/') i++; // "**/" also matches zero segments
        } else {
          re += '[^/]*';
        }
      } else if (ch === '?') {
        re += '[^/]';
      } else if (ch === '[') {
        const close = p.indexOf(']', i);
        if (close > i) {
          const cls = p.slice(i, close + 1);
          // Sanity-check the class compiles (e.g. [z-a] does not); if not,
          // treat the brackets literally so a bad pattern can never throw.
          try {
            new RegExp(cls);
            re += cls;
          } catch {
            re += cls.replace(/[-\[\]\^]/g, '\\$&');
          }
          i = close;
        } else {
          re += '\\[';
        }
      } else if ('\\^$.|+(){}'.includes(ch)) {
        re += '\\' + ch;
      } else {
        re += ch;
      }
    }
    return new RegExp('^' + re + '$');
  });
}

export function matches(patterns, file) {
  const f = norm(file);
  for (const pat of [].concat(patterns)) {
    for (const re of globToRegExp(pat)) if (re.test(f)) return true;
  }
  return false;
}

export function matchAny(patterns, files) {
  for (const f of files) if (matches(patterns, f)) return true;
  return false;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);

// All files under root (relative, posix separators) matching any pattern.
// Patterns that look like plain paths still work via the glob translator.
export function expandFiles(root, patterns) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(root, '');
  return out.filter((f) => matches(patterns, f)).sort();
}
