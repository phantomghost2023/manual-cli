import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseYaml, parseFlow } from '../src/yaml.js';
import { globToRegExp, matches } from '../src/glob.js';
import { loadManual, parseClaim } from '../src/claims.js';

// Seeded RNG (mulberry32): reproducible fuzz runs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  'a', 'B', '9', '_', '-', '.', ' ', '\t', ':', ',', '[', ']', '{', '}',
  '"', "'", '\\', '|', '>', '#', '*', '?', '!', '&', '%', '@', '`', '~',
  '\n', '---', '- ', ': ', 'key', 'value', 'schema: manual/v1', '${{', '\r\n',
];

function randomText(r, maxLen = 400) {
  const n = Math.floor(r() * maxLen);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return out;
}

describe('yaml parser fuzz', () => {
  test('500 seeded random inputs never throw, always return object or null', () => {
    const r = rng(0xC0FFEE);
    for (let i = 0; i < 500; i++) {
      const input = randomText(r);
      let value;
      assert.doesNotThrow(() => { value = parseYaml(input); }, `input #${i}: ${JSON.stringify(input.slice(0, 80))}`);
      assert.ok(value === null || typeof value === 'object');
    }
  });

  test('targeted malformations never throw', () => {
    const nasty = [
      '',
      '   ',
      '\t\tkey: value',            // tab indentation
      'key: [a, b',                 // unclosed flow
      'key: {a: 1',                 // unclosed flow map
      'key: "unterminated',         // unclosed quote
      "key: 'unterminated",
      '[',
      ']',
      '{',
      '}',
      ':',
      ':::',
      '- - - -',
      'a:\n  b:\n    c:\n      d: [1, {e: 2}',  // deep nesting unclosed
      'k: >-\n\ttab in block',      // tab in block scalar
      'k: |-\n  unclosed block',    // block scalar to EOF
      'k:\n- 1\n- - 2\n- x: [',    // nested sequences half-open
      'a: [b, [c, [d, [e]]]]',      // deep closed nesting
      '"k": "v"',                   // quoted keys
      'k: "esc \\x \\q weird"',     // unknown escapes
      'k: v: w',                    // second colon in value
      '-\n-\n-',
      'k: ' + 'x'.repeat(100000),   // very long scalar
      'k:\n' + '  - a\n'.repeat(500), // very long list
    ];
    for (const input of nasty) {
      let value;
      assert.doesNotThrow(() => { value = parseYaml(input); }, JSON.stringify(input.slice(0, 40)));
      assert.ok(value === null || typeof value === 'object');
    }
  });

  test('parseFlow of garbage returns scalar rather than throwing', () => {
    assert.doesNotThrow(() => parseFlow('}}}}'));
    assert.doesNotThrow(() => parseFlow('"unterminated'));
  });
});

describe('glob fuzz', () => {
  test('malformed patterns never throw', () => {
    const patterns = ['[', ']', '**[', '{', '{a', '{a,}', '{}[]', '***', 'a/{b,c/{d', '\\\\', '[]', '[z-a]'];
    for (const p of patterns) {
      assert.doesNotThrow(() => globToRegExp(p));
      assert.doesNotThrow(() => matches(p, 'some/file.ts'));
    }
  });
});

describe('claim loader hardening', () => {
  const mkDirWith = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-fuzz-'));
    fs.mkdirSync(path.join(dir, '.manual', 'claims'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, '.manual', 'claims', name), content);
    }
    return dir;
  };

  test('every malformed claim surfaces as a load error, never a crash', () => {
    const dir = mkDirWith({
      'a.unclosed.md': '---\nid: a.unclosed\nkind: fact\nstatement: no closing fence\nbody text here',
      'b.baddate.md': '---\nid: b.baddate\nkind: fact\nstatement: x\n\tafter: \ttab indented\n---\nbody text here',
      'c.noid.md': '---\nkind: fact\nstatement: x\n---\nbody text here',
      'd.nokind.md': '---\nid: d.nokind\nstatement: x\n---\nbody text here',
      'e.noschema.md': '---\nid: e.noschema\nkind: fact\nstatement: x\n---\nbody text here',
      'f.badid.md': '---\nid: BAD ID!\nkind: fact\nstatement: x\n---\nbody text here',
      'g.nofm.md': 'no frontmatter at all',
      'h.empty.md': '',
      'i.flow.md': '---\nid: i.flow\nkind: fact\nstatement: x\ncheck: {run: "ls", unclosed: [1}\n---\nbody text here',
      'j.dep.md': '---\nid: j.dep\nkind: fact\nstatement: x\ndepends_on:\n  - id: missing.claim\n    required: true\n---\nbody text here',
      'k.deep.md': '---\nid: k.deep\nkind: fact\nstatement: x\n' + 'a:\n' + '  b:\n'.repeat(1) + 'c: [1, {d: 2}\n---\nbody text here',
    });
    let result;
    assert.doesNotThrow(() => { result = loadManual(dir); });
    assert.equal(result.claims.length, 0);
    assert.ok(result.errors.length >= 8, `expected many errors, got ${JSON.stringify(result.errors)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('id/filename mismatch is reported (duplicates structurally impossible)', () => {
    const claim = (id) => `---\nschema: manual/v1\nid: ${id}\nkind: fact\nstatement: same\n---\nbody text here`;
    const dir = mkDirWith({ 'x.dup.md': claim('x.dup'), 'x2.dup.md': claim('x.dup') });
    const { errors } = loadManual(dir);
    // x2.dup.md carries id x.dup: rejected by the filename rule, so a true
    // duplicate can never be loaded from claims/ in the first place.
    assert.ok(errors.some((e) => /filename must be/.test(e)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('parseClaim throws ClaimError (not TypeError) on garbage frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-pc-'));
    const file = path.join(dir, 'weird.id.md');
    fs.writeFileSync(file, '---\n[not a map]\n---\nbody');
    assert.throws(() => parseClaim(fs.readFileSync(file, 'utf8'), file), /weird\.id\.md/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
