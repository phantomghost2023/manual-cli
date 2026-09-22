import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256 } from './hash.js';

// ---------------------------------------------------------------------------
// Built-in verifiers, one per ecosystem.
//
// A command can answer "is this install still valid?", but the question is the
// same in every repository of an ecosystem and the obvious command is too slow
// to ask on every verify: `npm ls --depth=0` is ~11s on a real dependency tree,
// `bundle check` boots Ruby, `pip check` boots Python. Comparing the installed
// tree against the lockfile that describes it answers the same question with a
// readdir and a few stats.
//
// Every builtin answers in the same three shapes, and the third is the one that
// decides whether the feature works:
//   ok: true   — the tree matches the lockfile
//   ok: false  — it does not, so the cached install is distrusted and rebuilt
//   ok: null   — there is nothing here to compare *against*. Not the same as
//                "no": answering "no" would distrust and reinstall on every
//                single verify, for a repository that is perfectly fine. Found
//                on express, which ships .npmrc with package-lock=false.
// The third shape carries what the verifier saw instead of a verdict, so the gap
// is reportable rather than silent.
//
// And "no" is itself a claim a builtin may only make when the lockfile describes
// exactly what any install of it produces. `npm ci --omit=dev`,
// `bundle install --without test`, `uv sync --no-dev`, `poetry install --only
// main` all install a *subset* of the lockfile: there, a package that is absent
// is a fact about the command, not a gap in the tree, and a verdict of "no"
// would rebuild on every verify without ever changing the answer. Same for a
// lockfile that cannot say why a package is in it (Cargo.lock does not mark
// dev-dependencies; uv.lock does not mark dev groups). Those report instead of
// judging.
// ---------------------------------------------------------------------------

export const AUTO = 'auto';

// The name matters as much as the check: a claim says which question it is
// asking, and `lockfile` was this tool's only verifier before there was more
// than one ecosystem. It still resolves — an existing claim keeps working — but
// the canonical name for it is now `npm`.
export const BUILTIN_ALIASES = { lockfile: 'npm' };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const normName = (s) => String(s).trim().toLowerCase().replace(/[-_.]+/g, '-');
const normVersion = (v) => String(v).trim().toLowerCase().replace(/^v/, '');

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const readJson = (p) => {
  const t = read(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const list = (d) => {
  try {
    return fs.readdirSync(d).sort();
  } catch {
    return null;
  }
};
const exists = (p) => fs.existsSync(p);
const firstOf = (root, names) => names.find((n) => exists(path.join(root, n))) || null;
const tooLong = (s, n = 240) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

// Package names contain `-`; versions start with a digit. That is the whole
// trick behind reading `flask-3.0.0.dist-info`, `rake-13.2.1.gemspec` and
// `serde-1.0.228` without a manifest: split where the version starts.
function splitFromFirstDigit(base) {
  for (let i = 1; i < base.length - 1; i++) {
    if (base[i] === '-' && /[0-9]/.test(base[i + 1])) return [base.slice(0, i), base.slice(i + 1)];
  }
  return null;
}
const splitAtLastDash = (base) => {
  const i = base.lastIndexOf('-');
  if (i <= 0 || !/[0-9]/.test(base[i + 1] || '')) return null;
  return [base.slice(0, i), base.slice(i + 1)];
};

// A directory listing, indexed as name → the versions installed there. One
// readdir per directory, and every question answered from the listing: on a real
// verify this runs once per claim's prerequisite, so a stat per package is
// already more than the cheap answer needs.
function indexInstalled(names, suffixes, split) {
  const out = new Map();
  for (const name of names || []) {
    let base = name;
    if (suffixes) {
      const suffix = suffixes.find((s) => name.endsWith(s));
      if (!suffix) continue;
      base = name.slice(0, -suffix.length);
    }
    const parts = split(base);
    if (!parts) continue;
    const key = normName(parts[0]);
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(normVersion(parts[1]));
  }
  return out;
}

function mergeIndexes(indexes) {
  const out = new Map();
  for (const idx of indexes) {
    for (const [k, versions] of idx) {
      if (!out.has(k)) out.set(k, new Set());
      for (const v of versions) out.get(k).add(v);
    }
  }
  return out;
}

// What the lockfile declared, against what the tree has — the sentence every
// builtin answers with, in one shape so a reader learns it once.
function verdict({ declared, index, unit, lockName, unchecked = [], extra = '' }) {
  const missing = [];
  const stale = [];
  for (const d of declared) {
    const versions = index.get(normName(d.name));
    if (!versions || versions.size === 0) {
      missing.push(`${d.name}${d.version ? `@${d.version}` : ''}`);
      continue;
    }
    if (d.version && !versions.has(normVersion(d.version))) {
      stale.push(`${d.name}@${d.version} (installed ${[...versions].join(', ')})`);
    }
  }
  const notes = [];
  if (missing.length) notes.push(`${missing.length}/${declared.length} ${unit}(s) missing, e.g. ${missing[0]}`);
  if (stale.length) notes.push(`${stale.length} at a different version than ${lockName}, e.g. ${stale[0]}`);
  if (!notes.length) notes.push(`${declared.length} ${unit}(s) present, matching ${lockName}`);
  if (unchecked.length) notes.push(`${unchecked.length} declaration(s) not checked, e.g. ${tooLong(unchecked[0], 80)}`);
  if (extra) notes.push(extra);
  return { missing, stale, note: notes.join('; ') };
}

// A declared command that installs a subset of the lockfile: see the note at the
// top of this file. (`--frozen-lockfile` is not one of these: it means "fail if
// the lockfile would change", which is the opposite of installing less.)
const SUBSET_INSTALL = /(^|\s)(--omit[=\s]|--without|--no-dev\b|--only[=\s]|--production\b|--prod\b)/;

function judge(v, spec, lockName) {
  const bad = v.missing.length + v.stale.length;
  if (!bad) return { ok: true, note: v.note };
  if (SUBSET_INSTALL.test(String(spec?.run || ''))) {
    return { ok: null, note: `${v.note} — not a verdict: \`${spec.run}\` installs a subset of ${lockName}` };
  }
  return { ok: false, note: v.note };
}

function report(v, reason, lockName) {
  return { ok: null, note: `${v.note} — not a verdict: ${reason} (${lockName})` };
}

// ---------------------------------------------------------------------------
// npm — every package the lockfile says should be installed is installed.
// ---------------------------------------------------------------------------

const NPM_LOCKS = ['package-lock.json', 'npm-shrinkwrap.json'];
const OTHER_PM_LOCKS = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

// lockfileVersion 1 lists the tree as nested `dependencies` objects instead of
// `packages` paths. Reading only `packages` made a v1 lockfile declare nothing,
// and a verifier that declares nothing used to report "0 package(s) present,
// matching package-lock.json" — a *yes* for an empty tree, which is the one
// answer a verifier must never get wrong.
function npmPaths(lock) {
  if (lock.packages && typeof lock.packages === 'object') {
    return Object.keys(lock.packages).filter((k) => k.startsWith('node_modules/'));
  }
  const out = [];
  const walk = (deps, prefix) => {
    for (const [name, d] of Object.entries(deps || {})) {
      const rel = `${prefix}node_modules/${name}`;
      out.push(rel);
      walk(d && d.dependencies, `${rel}/`);
    }
  };
  walk(lock.dependencies, '');
  return out;
}

const npm = {
  name: 'npm',
  unit: 'package',
  lockfiles: NPM_LOCKS,
  trees: ['node_modules'],
  available(root) {
    if (firstOf(root, NPM_LOCKS)) return null;
    const other = OTHER_PM_LOCKS.find((f) => exists(path.join(root, f)));
    return `no package-lock.json or npm-shrinkwrap.json in this checkout to compare the install against${
      other ? ` (${other} is present — that install is covered by the verifier for its package manager)` : ''
    }`;
  },
  verify(root) {
    const lockName = firstOf(root, NPM_LOCKS);
    if (!lockName) return { ok: null, ms: 0, note: 'no package lockfile to compare the install against' };
    const lock = readJson(path.join(root, lockName));
    if (!lock) return { ok: null, ms: 0, note: `unreadable ${lockName}` };
    const declared = npmPaths(lock).map((p) => ({ name: p }));
    if (!declared.length) return { ok: null, ms: 0, note: `${lockName} declares no installed packages to compare against` };
    const t0 = Date.now();
    const missing = declared.filter((d) => !exists(path.join(root, d.name)));
    const ms = Date.now() - t0;
    if (missing.length) {
      return {
        ok: false,
        ms,
        note: `${missing.length}/${declared.length} installed package(s) missing, e.g. ${missing[0].name}`,
        missing: missing.slice(0, 5).map((d) => d.name),
      };
    }
    return { ok: true, ms, note: `${declared.length} package(s) present, matching ${lockName}` };
  },
};

// ---------------------------------------------------------------------------
// pnpm — the one builtin that does not answer "no", because the measurement
// says it may not.
//
// pnpm writes the lockfile it installed from into its store directory
// (byte-identical, verified against pnpm 11), so "is this tree still the one the
// lockfile describes" looks like a file comparison, and every package the
// lockfile resolves should exist in `node_modules/.pnpm`. Both checks found real
// gaps in a real checkout. What neither can do is judge one, because
// `pnpm install` on a tree it considers satisfied leaves both alone — measured,
// twice, on pnpm 11: a hand-modified node_modules/.pnpm/lock.yaml survived two
// reinstalls and `pnpm install --force`; a deleted node_modules/.pnpm/<pkg>
// directory survived two reinstalls and came back only once the lockfile itself
// changed.
//
// So a "no" here would rebuild on every verify and never change its answer, for
// as long as the checkout stayed in that state. This builtin answers yes when
// both checks agree, and otherwise reports exactly what it saw — which is the
// same three answers as everywhere else, with the middle one reached the honest
// way.
// ---------------------------------------------------------------------------

// The `packages:` section lists every package the lock resolves. pnpm 8 and
// earlier wrote the same list as `/name/version`; those keys are normalized to
// the modern `name@version` so one parser covers both. `snapshots:` names the
// same packages and is where `optional: true` lives, so both sections are read
// and merged: a package not expected on this machine in either place is skipped
// everywhere. Found on a real vuejs/core drill: 15 of 660 lockfile entries were
// `@pnpm/exe.<other-platform>` binaries, which a satisfied install on Windows
// never materializes — counting them "missing" turned the verifier's yes into
// permanent noise.
// A quoted scalar can contain `: ` and `#` — unquote the outer pair, with YAML
// single-quote doubling (`''` -> `'`) handled.
function unquoteYamlKey(k) {
  if (k.length >= 2 && k.startsWith("'") && k.endsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  if (k.length >= 2 && k.startsWith('"') && k.endsWith('"')) return k.slice(1, -1).replace(/\\"/g, '"');
  return k;
}

export function pnpmPackages(text) {
  const packages = [];
  const snapFlags = new Map(); // snapshots: key -> flags, merged into packages below
  const snapKeys = []; // every snapshots: key, in order — the dir-name source
  let section = null;
  let old = false;
  let last = null; // entry (packages) or key string (snapshots) a flag line applies to
  const put = (e, flag, rest) => {
    if (flag === 'optional') {
      if (/\btrue\b/.test(rest)) e.skip = true;
      return;
    }
    const arr = /^\s*\[(.*)\]\s*$/.exec(rest);
    if (arr) {
      e[flag] = arr[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
  };
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      // Section headers end with `:` and can be quoted (`'packages:'` on pnpm
      // 12), so match on the unquoted word rather than a bare `^packages:`.
      const head = raw.trim().replace(/:$/, '').replace(/^'|'$/g, '');
      section = head === 'packages' ? 'packages' : head === 'snapshots' ? 'snapshots' : null;
      continue;
    }
    if (!section) continue;
    const flag = /^ {4}(optional|os|cpu|libc):(.*)$/.exec(raw);
    if (flag && last) {
      if (section === 'packages') {
        put(last, flag[1], flag[2]);
      } else {
        // snapshots: `last` is a key string; park its flags until the merge below.
        let sf = snapFlags.get(last);
        if (!sf) {
          sf = {};
          snapFlags.set(last, sf);
        }
        put(sf, flag[1], flag[2]);
      }
      continue;
    }
    // Exactly two spaces: a nested four-space key (`dependencies:` inside a
    // snapshot entry) must not be mistaken for a section key — it used to
    // reset `last`, so the `optional: true` that followed landed on a junk key
    // and the package stayed "expected". Found on a real vuejs/core lock.
    const key = /^ {2}([^ ].*?):\s*$/.exec(raw);
    if (!key) continue;
    const k = unquoteYamlKey(key[1]);
    if (section === 'packages') {
      const entry = { name: '', version: '', skip: false };
      if (k.startsWith('/')) {
        // `/@scope/name/1.2.3` — the version is the last path segment.
        const parts = k.slice(1).split('/');
        entry.version = parts.pop();
        entry.name = parts.join('/');
        old = true;
      } else {
        const at = k.lastIndexOf('@');
        if (at <= 0) { last = null; continue; }
        entry.name = k.slice(0, at);
        entry.version = k.slice(at + 1);
      }
      packages.push(entry);
      last = entry;
    } else {
      last = k; // snapshots keys are read for their flags and dir spelling
      snapKeys.push(k);
    }
  }
  // The snapshots section is where a package's real install identity lives:
  // its key spells the peer set as `(peer@ver)(peer2@ver2)`, which is exactly
  // what pnpm names the store directory after (plus `optional: true` and the
  // platform flags, which a packages-section entry may lack). Collect both:
  // flags merge into the packages entry, keys record the peer-resolved forms.
  const snaps = new Map(); // base `name@version` -> array of snapshot keys
  for (const key of snapKeys) {
    const base = key.replace(/\([^)]*\)/g, '');
    if (!snaps.has(base)) snaps.set(base, []);
    if (!snaps.get(base).includes(key)) snaps.get(base).push(key);
  }
  for (const p of packages) {
    const base = `${p.name}@${p.version}`;
    const keys = snaps.get(base);
    const sf = snapFlags.get(base);
    if (sf) {
      if (sf.skip) p.skip = true;
      for (const f of ['os', 'cpu', 'libc']) if (sf[f] && !p[f]) p[f] = sf[f];
    }
    if (keys?.length) p.snaps = keys;
  }
  return { packages, old };
}

// vuejs/core pins `packageManager: pnpm@12.4.2`, and pnpm records that pin as
// a lockfile entry — but the package manager itself never materializes into
// the project's virtual store; it lives in pnpm's own home. A lockfile entry
// matching the packageManager pin is self-referential, not missing. Found on
// the same vuejs/core drill as the platform skip above.
function pnpmSelfRef(root) {
  const pkg = read(path.join(root, 'package.json')) || '';
  const m = /"packageManager"\s*:\s*"[^"]*pnpm@([^"]+)"/.exec(pkg);
  return m ? `pnpm@${m[1]}` : null;
}

// A package whose lockfile entry constrains it to another platform is not
// missing from this tree — it was never supposed to be here. `libc` is always
// skipped: this tool does not detect glibc vs musl, and being wrong in either
// direction is worse than reporting.
function pnpmPlatformSkip(entry) {
  const here = (v) =>
    v === process.platform || v === process.arch;
  for (const field of ['os', 'cpu', 'libc']) {
    const list = entry[field];
    if (!Array.isArray(list) || !list.length) continue;
    if (field === 'libc') return true;
    // pnpm allows negation: `os: [!win32]` means "everything but win32".
    if (list.some((v) => typeof v === 'string' && v.startsWith('!') && here(v.slice(1)))) return true;
    if (!list.includes(process.platform) && !list.includes(process.arch)) return true;
  }
  return false;
}

// Same package set, ignoring order and duplicates — for comparing two
// serializations of one lockfile (see the copy check in the pnpm verifier).
function setEquals(a, b) {
  if (a.length !== b.length) return false;
  const key = (p) => `${p.name}@${p.version}`;
  const bs = new Set(b.map(key));
  return a.every((p) => bs.has(key(p)));
}

// The virtual store's directory names, from a lockfile entry's own spelling.
// pnpm 11 named each dir `name@version`; pnpm 12 names them after the
// *snapshot* key — the peer-resolved form — with the peer set joined by `_`:
// `vite@8.3.0_@types+node@24.1_7c905f…`. Scoped `/` becomes `+`. When that key
// exceeds 60 characters, pnpm truncates it to the first 27 and appends `_` +
// sha256(key)[:32] — both rules proven against a real vuejs/core store
// (19/19 hash dirs matched, 0 store dirs uncovered after the change).
const pnpmDirKeys = (entry) => {
  const base = `${entry.name.replace(/\//g, '+')}@${entry.version}`;
  const forms = new Set([base]);
  for (const snap of entry.snaps || []) {
    const peers = [...snap.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].replace(/\//g, '+')).join('_');
    const full = base + (peers ? `_${peers}` : '');
    forms.add(full);
    if (full.length > 60) forms.add(full.slice(0, 27) + '_' + sha256(full).slice(0, 32));
  }
  return forms;
};

// A store dir counts as its base form when it carries a peer suffix, so a
// package installed once in any peer variant is present.
const pnpmStoreKeys = (names) => {
  const out = new Set();
  for (const n of names || []) {
    out.add(n);
    out.add(n.replace(/_.*$/, ''));
  }
  return out;
};

const pnpm = {
  name: 'pnpm',
  unit: 'package',
  lockfiles: ['pnpm-lock.yaml'],
  trees: ['node_modules'],
  available(root) {
    return exists(path.join(root, 'pnpm-lock.yaml')) ? null : 'no pnpm-lock.yaml in this checkout to compare the install against';
  },
  verify(root) {
    const lockName = 'pnpm-lock.yaml';
    const lockPath = path.join(root, lockName);
    if (!exists(lockPath)) return { ok: null, ms: 0, note: 'no pnpm-lock.yaml to compare the install against' };
    const t0 = Date.now();
    const storeDir = path.join(root, 'node_modules', '.pnpm');
    const storeNames = list(storeDir);
    const { packages, old } = pnpmPackages(read(lockPath) || '');
    const dirFor = (p) => `${p.name.replace(/\//g, '+')}@${p.version}`;
    const selfRef = pnpmSelfRef(root);
    const selfCount = selfRef ? packages.filter((p) => dirFor(p) === selfRef).length : 0;
    // A package constrained to another platform (or marked optional) is not
    // missing from this tree — it was never expected here. The packageManager
    // self-reference is excluded for the same reason. Both counted separately
    // so the report can say how much was skipped and why.
    const expected = packages.filter((p) => !p.skip && !pnpmPlatformSkip(p) && (!selfRef || dirFor(p) !== selfRef));
    const skipped = packages.length - expected.length - selfCount;
    const notInStore = (names) =>
      old || !names
        ? []
        : expected.filter((p) => {
            const forms = pnpmDirKeys(p);
            // pnpm 11: dir `name@ver` or `name@ver_peer…` — base-alias covers it.
            // pnpm 12: dir is a snapshot-derived form, possibly hash-truncated.
            return ![...forms].some((f) => pnpmStoreKeys(names).has(f));
          });
    const copy = path.join(storeDir, 'lock.yaml');
    // pnpm records the lockfile it installed from as node_modules/.pnpm/lock.yaml.
    // On pnpm 11 the copy is byte-identical; on pnpm 12 it is a re-serialization
    // (no `---` header, settings interleaved) of the same package set, so byte
    // equality would misjudge every healthy pnpm-12 tree. The packages are what
    // was installed from, so that set is what is compared.
    const copyPackages = exists(copy) ? pnpmPackages(read(copy) || '') : null;
    // pnpm 11 writes the copy verbatim; pnpm 12 re-serializes it filtered to
    // packages plausibly relevant to this machine (measured on vuejs/core: 645
    // of 660 — exactly the other-OS binaries dropped). Neither equality holds
    // on pnpm 12, so the check is subset in both directions: every copied
    // package must be in the lockfile (a foreign resolve adds packages), and
    // every package this machine must have must be in the copy (a copy from
    // another machine lacks them).
    const fullSet = new Set(packages.map((p) => `${p.name}@${p.version}`));
    const copySet = copyPackages ? new Set(copyPackages.packages.map((p) => `${p.name}@${p.version}`)) : null;
    const copyMatches = copyPackages
      ? !copyPackages.old &&
        copyPackages.packages.every((p) => fullSet.has(`${p.name}@${p.version}`)) &&
        expected.every((p) => copySet.has(`${p.name}@${p.version}`))
      : false;
    const ms = Date.now() - t0;

    if (!packages.length) return { ok: null, ms, note: `${lockName} lists no packages to compare against` };
    const missing = notInStore(storeNames);
    if (storeNames && copyMatches && !missing.length && !old) {
      return {
        ok: true,
        ms,
        note: `${expected.length} package(s) present in node_modules/.pnpm, matching ${lockName}` + (skipped || selfCount ? ` (${[skipped ? `${skipped} platform-specific or optional skipped` : '', selfCount ? `${selfCount} packageManager self-reference skipped` : ''].filter(Boolean).join(', ')})` : ''),
      };
    }

    const seen = [];
    if (!storeNames) seen.push('node_modules/.pnpm is not there, so nothing here was installed by pnpm');
    else if (old) seen.push(`${lockName} uses the pre-pnpm-8 \`/name/version\` key layout, which does not map to store directory names`);
    else if (missing.length) seen.push(`${missing.length}/${expected.length} package(s) the lockfile lists are not in node_modules/.pnpm, e.g. ${dirFor(missing[0])}`);
    if (skipped) seen.push(`${skipped} platform-specific or optional package(s) skipped`);
    seen.push(copyPackages
      ? copyMatches
        ? `node_modules/.pnpm/lock.yaml records installing from this ${lockName}`
        : `node_modules/.pnpm/lock.yaml records installing from a different resolve of the same ${lockName}`
      : `node_modules/.pnpm/lock.yaml is missing, so there is no record of ${lockName}`);
    return {
      ok: null,
      ms,
      note: `${seen.join('; ')} — not a verdict: a satisfied \`pnpm install\` re-imports only when the lockfile itself changes, which is what the cache key already tracks, so it will not repair this one`,
      missing: missing.slice(0, 5).map(dirFor),
    };
  },
};

// ---------------------------------------------------------------------------
// venv — a Python virtualenv against its own lockfile.
// ---------------------------------------------------------------------------

const PY_LOCKFILES = ['requirements.txt', 'poetry.lock', 'Pipfile.lock', 'uv.lock'];
const PY_TREES = ['.venv', 'venv', '.virtualenv', 'env'];

// A virtualenv keeps its packages in `Lib/site-packages` on Windows and
// `lib/python3.x/site-packages` everywhere else. Both are found by reading one
// directory, so the layout is a detail rather than a platform guess — and the
// declared `cache` directories are consulted first, because a setup that
// installs into `.venv` already said where its tree is.
function sitePackages(root, spec = {}) {
  const roots = [];
  if (spec.builtinOptions?.path) roots.push(spec.builtinOptions.path);
  for (const c of spec.cache || []) roots.push(c);
  roots.push(...PY_TREES);
  const found = [];
  for (const rel of roots) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!exists(abs)) continue;
    if (path.basename(abs) === 'site-packages') {
      found.push(abs);
      continue;
    }
    const direct = path.join(abs, 'Lib', 'site-packages');
    if (exists(direct)) found.push(direct);
    for (const py of list(path.join(abs, 'lib')) || []) {
      if (!/^python\d/.test(py)) continue;
      const sp = path.join(abs, 'lib', py, 'site-packages');
      if (exists(sp)) found.push(sp);
    }
  }
  return [...new Set(found)];
}

function requirementsDeclared(text) {
  const packages = [];
  const unchecked = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('-') || /:\/\//.test(line) || /\s@\s/.test(line)) {
      unchecked.push(`${line} (not a pinned distribution)`);
      continue;
    }
    const [spec, ...markers] = line.split(';');
    // A PEP 508 marker decides *whether* the package belongs on this machine at
    // all. Not reading it and checking anyway reports a package that is
    // correctly absent as missing.
    if (markers.length) {
      unchecked.push(`${spec.trim()} (environment marker)`);
      continue;
    }
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:(===|==|~=|>=|<=|!=|>|<)\s*([^\s,]+))?/.exec(spec.trim());
    if (!m) {
      unchecked.push(`${spec.trim()} (unparseable)`);
      continue;
    }
    packages.push({ name: m[1], version: m[2] === '==' || m[2] === '===' ? m[3] : null });
  }
  return { packages, unchecked };
}

function pipfileDeclared(lock) {
  if (!lock || typeof lock !== 'object') return { error: 'unreadable Pipfile.lock' };
  const section = lock.default;
  if (!section || typeof section !== 'object') return { error: 'Pipfile.lock has no default section to compare against' };
  const packages = [];
  for (const [name, v] of Object.entries(section)) {
    const raw = v && typeof v === 'object' ? v.version : v;
    const ver = typeof raw === 'string' ? raw.replace(/^==?/, '') : null;
    packages.push({ name, version: ver && /^[0-9]/.test(ver) ? ver : null });
  }
  // `develop` is a group Pipfile decides the membership of, and the lock does
  // not say whether it was installed; checking it would invent an answer.
  const develop = Object.keys(lock.develop || {}).length;
  return { packages, unchecked: develop ? [`the develop section (${develop} package(s))`] : [] };
}

// poetry.lock and uv.lock both list distributions as `[[package]]` tables with
// `name` and `version` keys, and reading two fields is not worth a TOML parser
// this tool does not have.
function tomlLockDeclared(text, lockName) {
  const packages = [];
  const unchecked = [];
  let cur = null;
  let nested = false;
  const flush = () => {
    if (!cur) return;
    if (cur.optional === 'true') unchecked.push(`${cur.name} (optional — installed only with an extra)`);
    else if (cur.name) packages.push({ name: cur.name, version: cur.version || null });
    cur = null;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '[[package]]') {
      flush();
      cur = {};
      nested = false;
      continue;
    }
    if (!cur) continue;
    // A sub-table (`[package.dependencies]`) belongs to this package, not to a
    // new one, and its keys are not this package's name or version.
    if (line.startsWith('[')) {
      nested = true;
      continue;
    }
    if (nested) continue;
    const m = /^(name|version|optional)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    cur[m[1]] = m[2].trim().replace(/^["']|["']$/g, '').replace(/,$/, '');
  }
  flush();
  if (!packages.length) return { error: `${lockName} lists no packages to compare against` };
  return { packages, unchecked };
}

const venv = {
  name: 'venv',
  unit: 'distribution',
  lockfiles: PY_LOCKFILES,
  trees: PY_TREES,
  available(root, spec) {
    if (!firstOf(root, PY_LOCKFILES)) {
      return `no ${PY_LOCKFILES.join(', ')} in this checkout to compare the install against`;
    }
    if (!sitePackages(root, spec).length) {
      return `no virtualenv to inspect (looked for ${[...(spec?.cache || []), ...PY_TREES].join(', ')}) — packages installed into the system Python are machine state, not this checkout's tree`;
    }
    return null;
  },
  verify(root, spec) {
    const lockName = firstOf(root, PY_LOCKFILES);
    if (!lockName) return { ok: null, ms: 0, note: `no ${PY_LOCKFILES.join(', ')} to compare the install against` };
    const dirs = sitePackages(root, spec);
    if (!dirs.length) return { ok: null, ms: 0, note: 'no virtualenv to inspect — a system-wide pip install is not a tree this checkout can measure' };
    const d = lockName === 'requirements.txt'
      ? requirementsDeclared(read(path.join(root, lockName)) || '')
      : lockName === 'Pipfile.lock'
        ? pipfileDeclared(readJson(path.join(root, lockName)))
        : tomlLockDeclared(read(path.join(root, lockName)) || '', lockName);
    if (d.error) return { ok: null, ms: 0, note: d.error };
    const t0 = Date.now();
    const index = mergeIndexes(dirs.map((dir) => indexInstalled(list(dir) || [], ['.dist-info', '.egg-info'], splitFromFirstDigit)));
    const ms = Date.now() - t0;
    const v = verdict({ declared: d.packages, index, unit: 'distribution', lockName, unchecked: d.unchecked || [], extra: dirs.length > 1 ? `${dirs.length} site-packages directories read` : '' });
    const j = judge(v, spec, lockName);
    // uv.lock cannot say which package belongs to a dev group, so a package that
    // is not installed may simply never have been asked for.
    if (j.ok === false && lockName === 'uv.lock') {
      return { ...report(v, 'uv.lock does not mark which packages a dev-only group needs', lockName), ms };
    }
    return { ...j, ms, missing: v.missing.slice(0, 5) };
  },
};

// ---------------------------------------------------------------------------
// gems — a vendored Bundler tree against Gemfile.lock.
// ---------------------------------------------------------------------------

const gems = {
  name: 'gems',
  unit: 'gem',
  lockfiles: ['Gemfile.lock'],
  trees: ['vendor/bundle', '.bundle'],
  available(root, spec) {
    if (!exists(path.join(root, 'Gemfile.lock'))) return 'no Gemfile.lock in this checkout to compare the install against';
    if (!gemsSpecDirs(root, spec).length) {
      return `no vendored bundle to inspect (looked for ${bundlerPath(root, spec)}) — gems installed into the system gem home are shared machine state, not this checkout's tree`;
    }
    return null;
  },
  verify(root, spec) {
    const text = read(path.join(root, 'Gemfile.lock'));
    if (text === null) return { ok: null, ms: 0, note: 'no Gemfile.lock to compare the install against' };
    const dirs = gemsSpecDirs(root, spec);
    if (!dirs.length) return { ok: null, ms: 0, note: 'no vendored bundle to inspect — run `bundle install` with a BUNDLE_PATH inside the checkout, or declare the verifier for another ecosystem' };
    const declared = gemsDeclared(text);
    if (!declared.length) return { ok: null, ms: 0, note: 'Gemfile.lock lists no gems in the GEM section to compare against' };
    const t0 = Date.now();
    const index = mergeIndexes(dirs.map((dir) => indexInstalled(list(dir) || [], ['.gemspec'], splitAtLastDash)));
    const ms = Date.now() - t0;
    const v = verdict({ declared, index, unit: 'gem', lockName: 'Gemfile.lock' });
    return { ...judge(v, spec, 'Gemfile.lock'), ms, missing: v.missing.slice(0, 5) };
  },
};

// The GEM section's `specs:` block lists every gem the lock resolves as
// `    name (version)`, with that gem's own requirements indented one level
// further.
function gemsDeclared(text) {
  const packages = [];
  let inGem = false;
  let inSpecs = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim() === 'GEM') {
      inGem = true;
      inSpecs = false;
      continue;
    }
    if (/^[A-Z]/.test(raw)) {
      inGem = false;
      inSpecs = false;
      continue;
    }
    if (!inGem) continue;
    if (raw.trim() === 'specs:') {
      inSpecs = true;
      continue;
    }
    if (!inSpecs) continue;
    const m = /^ {4}([^\s(]+) \(([^)]+)\)$/.exec(raw);
    if (m) {
      packages.push({ name: m[1], version: m[2] });
      continue;
    }
    if (!/^ {6}/.test(raw)) inSpecs = false;
  }
  return packages;
}

// Bundler puts the tree where BUNDLE_PATH says, in `.bundle/config` or the
// environment; `vendor/bundle` is the default a setup normally declares.
function bundlerPath(root, spec = {}) {
  if (spec.builtinOptions?.path) return spec.builtinOptions.path;
  const cfg = read(path.join(root, '.bundle', 'config'));
  if (cfg) {
    const m = /^\s*BUNDLE_PATH:\s*"?([^"\n]+?)"?\s*$/m.exec(cfg);
    if (m) return m[1].trim();
  }
  return process.env.BUNDLE_PATH || 'vendor/bundle';
}

function gemsSpecDirs(root, spec) {
  const base = bundlerPath(root, spec);
  const abs = path.isAbsolute(base) ? base : path.join(root, base);
  const found = [];
  const subs = [abs, ...(list(abs) || []).map((d) => path.join(abs, d))];
  for (const sub of subs) {
    const dir = path.join(sub, 'specifications');
    if (exists(dir)) found.push(dir);
  }
  // vendor/bundle/ruby/<abi>/specifications is one level deeper than the rest.
  for (const sub of subs) {
    for (const abi of list(sub) || []) {
      const dir = path.join(sub, abi, 'specifications');
      if (exists(dir)) found.push(dir);
    }
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// gomod — the Go module cache against go.mod, or a vendor tree against the
// modules.txt that vendoring wrote.
// ---------------------------------------------------------------------------

// Go escapes module paths into cache directory names by replacing every capital
// letter with `!` and its lowercase (verified on a real cache: github.com/ →
// `github.com`, BurntSushi → `!burnt!sushi`).
const escapeGoPath = (p) => String(p).replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

function goRequires(text) {
  const out = [];
  let inBlock = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (raw.trim() === 'require (') {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    if (!line) continue;
    const m = inBlock ? /^([^\s]+)\s+([^\s]+)$/.exec(line) : /^require\s+([^\s]+)\s+([^\s]+)$/.exec(line);
    if (!m) continue;
    out.push({ path: m[1], version: m[2], indirect: /\/\/\s*indirect/.test(raw) });
  }
  return out;
}

function goReplaces(text) {
  const out = new Map();
  let inBlock = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (raw.trim() === 'replace (') {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    if (!line) continue;
    const m = (inBlock ? /^([^\s]+)(?:\s+[^\s]+)?\s+=>\s+([^\s]+)(?:\s+([^\s]+))?$/ : /^replace\s+([^\s]+)(?:\s+[^\s]+)?\s+=>\s+([^\s]+)(?:\s+([^\s]+))?$/).exec(line);
    if (!m) continue;
    out.set(m[1], { path: m[2], version: m[3] || null, local: m[2].startsWith('.') || path.isAbsolute(m[2]) });
  }
  return out;
}

let goEnvMemo;
function goEnv(name) {
  if (goEnvMemo === undefined) goEnvMemo = {};
  if (Object.hasOwn(goEnvMemo, name)) return goEnvMemo[name];
  let value = null;
  try {
    const r = spawnSync('go', ['env', name], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0) value = String(r.stdout || '').trim() || null;
  } catch {
    value = null;
  }
  goEnvMemo[name] = value;
  return value;
}

// GOPATH and GOMODCACHE can also be set in Go's own env file, which no shell
// variable reveals — so `go env` is asked once, per process, and only when none
// of the cheap locations exist.
function goModCache(spec = {}) {
  const declared = spec.builtinOptions?.modcache;
  if (declared) return { dir: declared, why: 'declared' };
  const candidates = [];
  if (process.env.GOMODCACHE) candidates.push([process.env.GOMODCACHE, 'GOMODCACHE']);
  for (const gp of String(process.env.GOPATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push([path.join(gp, 'pkg', 'mod'), 'GOPATH']);
  }
  candidates.push([path.join(os.homedir(), 'go', 'pkg', 'mod'), '~/go/pkg/mod']);
  for (const [dir, why] of candidates) if (exists(dir)) return { dir, why };
  const asked = goEnv('GOMODCACHE');
  if (asked && exists(asked)) return { dir: asked, why: 'go env GOMODCACHE' };
  return null;
}

const gomod = {
  name: 'gomod',
  unit: 'module',
  lockfiles: ['go.mod'],
  trees: ['$GOMODCACHE', 'vendor'],
  available(root, spec) {
    if (!exists(path.join(root, 'go.mod'))) return 'no go.mod in this checkout to compare the module cache against';
    // A vendored build reads the vendor tree, not the module cache —
    // vendor/modules.txt is the evidence — so a cache-less machine (a fresh
    // CI runner, a container) can still verify it. Found on the first ubuntu
    // CI run: the gate below demanded a cache even for vendored checks.
    if (exists(path.join(root, 'vendor', 'modules.txt'))) return null;
    if (!goModCache(spec)) return 'no Go module cache found (GOMODCACHE, GOPATH/pkg/mod, ~/go/pkg/mod) — declare one with { builtin: gomod, modcache: <dir> }';
    return null;
  },
  verify(root, spec) {
    const mod = read(path.join(root, 'go.mod'));
    if (mod === null) return { ok: null, ms: 0, note: 'no go.mod to compare the module cache against' };
    const requires = goRequires(mod);
    if (!requires.length) return { ok: null, ms: 0, note: 'go.mod requires no modules to compare against' };
    const replaces = goReplaces(mod);

    // With a vendor tree the module cache is not what the build reads, and
    // vendor/modules.txt is the lockfile that describes it.
    const vendorFile = path.join(root, 'vendor', 'modules.txt');
    if (exists(vendorFile)) {
      const vendored = new Set();
      for (const raw of String(read(vendorFile) || '').split(/\r?\n/)) {
        const m = /^# ([^\s]+) ([^\s]+)$/.exec(raw.trim());
        if (m) vendored.add(`${m[1]}@${m[2]}`);
      }
      const missing = requires.filter((r) => !replaces.has(r.path) && !vendored.has(`${r.path}@${r.version}`));
      if (missing.length) {
        return {
          ok: false,
          ms: 0,
          note: `${missing.length}/${requires.length} module(s) go.mod requires are not in vendor/modules.txt, e.g. ${missing[0].path}@${missing[0].version}`,
          missing: missing.slice(0, 5).map((r) => `${r.path}@${r.version}`),
        };
      }
      return { ok: true, ms: 0, note: `${requires.length} module(s) present, matching vendor/modules.txt` };
    }

    const cache = goModCache(spec);
    if (!cache) return { ok: null, ms: 0, note: 'no Go module cache found (GOMODCACHE, GOPATH/pkg/mod, ~/go/pkg/mod) to compare against' };
    const direct = requires.filter((r) => !r.indirect).length;
    const noSource = [];
    const noGraph = [];
    const t0 = Date.now();
    for (const r of requires) {
      const rep = replaces.get(r.path);
      if (rep?.local) {
        if (!exists(path.isAbsolute(rep.path) ? rep.path : path.join(root, rep.path))) {
          noSource.push(`${r.path} (replace → ${rep.path}, which is not there)`);
        }
        continue;
      }
      const target = rep && rep.version ? { path: rep.path, version: rep.version } : r;
      const dl = path.join(cache.dir, 'cache', 'download', escapeGoPath(target.path), '@v', target.version);
      // A module counts as cached when its zip was verified (`.ziphash`) or its
      // source is extracted; a module only in the graph needs its `.mod`, which
      // is what a pruned build actually loads.
      const extracted = path.join(cache.dir, `${escapeGoPath(target.path)}@${target.version}`);
      if (r.indirect) {
        if (!exists(`${dl}.mod`)) noGraph.push(`${target.path}@${target.version}`);
      } else if (!exists(`${dl}.ziphash`) && !exists(extracted)) {
        noSource.push(`${target.path}@${target.version}`);
      }
    }
    const ms = Date.now() - t0;
    if (!noSource.length && !noGraph.length) {
      return { ok: true, ms, note: `${requires.length} required module(s) present, matching go.mod (cache: ${cache.dir})` };
    }
    const note = [
      noSource.length ? `${noSource.length}/${direct} required module(s) not in the module cache, e.g. ${noSource[0]}` : null,
      noGraph.length ? `${noGraph.length} module graph entr(ies) missing their .mod, e.g. ${noGraph[0]}` : null,
      `cache: ${cache.dir} (${cache.why})`,
    ].filter(Boolean).join('; ');
    return { ok: false, ms, note, missing: [...noSource, ...noGraph].slice(0, 5) };
  },
};

// ---------------------------------------------------------------------------
// crates — Cargo.lock against the extracted registry or a vendored tree.
// ---------------------------------------------------------------------------

function cargoDeclared(text) {
  const packages = [];
  let cur = null;
  let nested = false;
  const flush = () => {
    // A workspace member has a name and version and no `source`: it is on disk,
    // not in the registry, and comparing it against a registry would report
    // every local crate as missing.
    if (cur?.name && cur?.source && /^registry\+/.test(cur.source)) packages.push({ name: cur.name, version: cur.version || null });
    cur = null;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '[[package]]') {
      flush();
      cur = {};
      nested = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('[')) {
      nested = true;
      continue;
    }
    if (nested) continue;
    const m = /^(name|version|source)\s*=\s*(.+)$/.exec(line);
    if (m) cur[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  flush();
  return packages;
}

function cargoTrees(root, spec = {}) {
  const out = [];
  const vendor = path.join(root, 'vendor');
  if (exists(vendor)) out.push({ dir: vendor, why: 'vendored (vendor/)' });
  const home = spec.builtinOptions?.cargo_home || process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  for (const kind of ['src', 'cache']) {
    for (const registry of list(path.join(home, 'registry', kind)) || []) {
      out.push({ dir: path.join(home, 'registry', kind, registry), why: `${home}/registry/${kind}`, cache: kind === 'cache' });
    }
  }
  return out;
}

const crates = {
  name: 'crates',
  unit: 'crate',
  lockfiles: ['Cargo.lock'],
  trees: ['vendor', '$CARGO_HOME/registry'],
  available(root, spec) {
    if (!exists(path.join(root, 'Cargo.lock'))) return 'no Cargo.lock in this checkout to compare the registry against';
    if (!cargoTrees(root, spec).length) return 'no Cargo registry found (vendor/, $CARGO_HOME/registry) — declare one with { builtin: crates, cargo_home: <dir> }';
    return null;
  },
  verify(root, spec) {
    const text = read(path.join(root, 'Cargo.lock'));
    if (text === null) return { ok: null, ms: 0, note: 'no Cargo.lock to compare the registry against' };
    const trees = cargoTrees(root, spec);
    if (!trees.length) return { ok: null, ms: 0, note: 'no Cargo registry found (vendor/, $CARGO_HOME/registry) to compare against' };
    const declared = cargoDeclared(text);
    if (!declared.length) return { ok: null, ms: 0, note: 'Cargo.lock lists no registry packages to compare against' };
    const t0 = Date.now();
    // `registry/src` holds extracted crates and `registry/cache` the verified
    // archives; the vendored directory holds extracted ones too. Cargo builds
    // from any of them offline, so any of them counts.
    const index = mergeIndexes(trees.map((t) => indexInstalled(list(t.dir) || [], t.cache ? ['.crate'] : null, splitAtLastDash)));
    const ms = Date.now() - t0;
    const v = verdict({ declared, index, unit: 'crate', lockName: 'Cargo.lock', extra: `${trees.length} registry source(s) read` });
    if (!v.missing.length && !v.stale.length) return { ok: true, ms, note: v.note };
    // Cargo.lock covers dev-dependencies and target-specific packages too, and
    // nothing in it marks which is which: an absent crate may simply never have
    // been fetched. Reported, not judged — a verdict here would rebuild on every
    // verify and never change its answer.
    return { ...report(v, 'Cargo.lock also covers dev-dependencies and target-specific crates, which a plain build never fetches', 'Cargo.lock'), ms };
  },
};

// ---------------------------------------------------------------------------
// yarn — two lockfile generations, and the state file each one writes.
//
// Classic yarn records the pattern → resolved-URL map it installed from in
// `node_modules/.yarn-integrity`, and its `IntegrityChecker` compares exactly
// that map against `yarn.lock` to decide whether to install anything. Measured:
// injecting one entry into the file made `yarn install` do a full install and
// rewrite it. So a difference here is not this tool's opinion about the tree —
// it is yarn's own answer, which is why "no" is safe to say.
//
// Berry writes `node_modules/.yarn-state.yml` in node-modules mode, which lists
// the locations it linked (and no checksums), and deleting a location from it
// made `yarn install` re-link and restore the entry — measured. Its PnP linker
// has no readable equivalent: `.pnp.cjs` is generated from a binary install
// state, and the locators do not appear in it (checked), so PnP is reported as
// unverifiable rather than guessed at.
// ---------------------------------------------------------------------------

export function yarnKind(text) {
  if (/^# yarn lockfile v1\b/m.test(text)) return 'classic';
  if (/^__metadata:\s*$/m.test(text)) return 'berry';
  return null;
}

// The directory a classic-yarn lockfile pattern is installed into. Patterns are
// `name@range`, with a scoped name spelled `@scope/name@range`; a URL or file
// pattern has no directory that follows from it.
function yarnPatternName(pattern) {
  const p = String(pattern).trim();
  if (!p || p.includes('://') || /^file:/.test(p)) return null;
  const at = p.startsWith('@') ? p.indexOf('@', 1) : p.indexOf('@');
  const name = at > 0 ? p.slice(0, at) : p;
  return /^(@[^/\s]+\/)?[^/@\s]+$/.test(name) ? name : null;
}

// A declared install that re-links from scratch, rather than trusting what its
// own bookkeeping says is already there. This is what decides whether a missing
// directory can be a verdict: the verdict has to be one the command repairs.
const RE_LINKING_INSTALL = /(^|\s)(--check-files|--force)(\s|$)/;

// Classic entries: one or more patterns at column 0 ending in `:`, then the
// indented `version "1.2.3"` / `resolved "https://…"` lines that belong to them.
function yarnClassicEntries(text) {
  const out = new Map();
  let patterns = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      patterns = raw
        .replace(/:\s*$/, '')
        .split(/,\s*/)
        .map((p) => p.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
      for (const p of patterns) if (!out.has(p)) out.set(p, {});
      continue;
    }
    if (!patterns) continue;
    const m = /^\s+(version|resolved)\s+"?([^"\s]*)"?\s*$/.exec(raw);
    if (!m) continue;
    for (const p of patterns) out.get(p)[m[1]] = m[2];
  }
  return out;
}

// Berry entries: descriptors at column 0, and the `resolution:` each one pins.
function yarnBerryLocators(text) {
  const out = new Map();
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = { descriptors: raw.replace(/:\s*$/, '').trim() };
      continue;
    }
    if (!cur) continue;
    const m = /^\s+(version|resolution|linkType|checksum):\s*"?([^"\s]*)"?\s*$/.exec(raw);
    if (!m) continue;
    if (m[1] === 'resolution') {
      cur.resolution = m[2];
      out.set(m[2], cur);
    } else {
      cur[m[1]] = m[2];
    }
  }
  return out;
}

// `"is-odd@npm:3.0.1":` at column 0, then `  locations:` and `    - "node_modules/is-odd"`.
function yarnStateLocations(text) {
  const out = new Map();
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      const key = raw.replace(/:\s*$/, '').trim().replace(/^"|"$/g, '');
      cur = key === '__metadata' ? null : [];
      if (cur) out.set(key, cur);
      continue;
    }
    const m = /^\s+-\s+"?([^"]*?)"?\s*$/.exec(raw);
    if (m && cur) cur.push(m[1]);
  }
  return out;
}

const yarn = {
  name: 'yarn',
  unit: 'package pattern',
  lockfiles: ['yarn.lock'],
  trees: ['node_modules', '.pnp.cjs'],
  available(root) {
    const lock = read(path.join(root, 'yarn.lock'));
    if (lock === null) return 'no yarn.lock in this checkout to compare the install against';
    const kind = yarnKind(lock);
    if (!kind) return 'this yarn.lock is neither the classic (v1) nor the modern (berry) format, so there is nothing it can be compared with';
    if (kind === 'classic' && !exists(path.join(root, 'node_modules', '.yarn-integrity'))) {
      return 'no node_modules/.yarn-integrity — yarn writes it on every install, and without it there is no record here of which lockfile the tree came from';
    }
    if (kind === 'berry' && !exists(path.join(root, 'node_modules', '.yarn-state.yml'))) {
      return exists(path.join(root, '.pnp.cjs'))
        ? "this checkout uses yarn's PnP linker: the runtime map is generated from a binary install state and does not contain a readable list of what was linked, so there is nothing here to compare against — a `verify:` command (`yarn install --immutable`) is the way to check this tree"
        : 'no node_modules/.yarn-state.yml — berry writes it in node-modules mode, and without it there is no record here of which packages were linked';
    }
    return null;
  },
  verify(root, spec = {}) {
    const lockText = read(path.join(root, 'yarn.lock')) || '';
    const kind = yarnKind(lockText);
    const t0 = Date.now();

    if (kind === 'classic') {
      const integ = readJson(path.join(root, 'node_modules', '.yarn-integrity'));
      if (!integ) return { ok: null, ms: Date.now() - t0, note: 'no node_modules/.yarn-integrity to compare against' };
      const want = yarnClassicEntries(lockText);
      const got = integ.lockfileEntries && typeof integ.lockfileEntries === 'object' ? integ.lockfileEntries : {};
      if (!want.size) return { ok: null, ms: Date.now() - t0, note: 'yarn.lock lists no packages to compare against' };
      const differing = [];
      for (const [pattern, entry] of want) {
        if (!(pattern in got)) differing.push(`${pattern} (in yarn.lock, not in the install)`);
        else if (entry.resolved && got[pattern] !== entry.resolved) differing.push(`${pattern} (installed from ${String(got[pattern]).replace(/^https?:\/\/[^/]+\//, '')})`);
      }
      for (const pattern of Object.keys(got)) if (!want.has(pattern)) differing.push(`${pattern} (installed, and no longer in yarn.lock)`);
      const ms = Date.now() - t0;
      if (differing.length) {
        return {
          ok: false,
          ms,
          note: `${differing.length} of ${want.size} package pattern(s) differ between yarn.lock and node_modules/.yarn-integrity, e.g. ${differing[0]}`,
          missing: differing.slice(0, 5),
        };
      }
      // Classic yarn's integrity check compares this map with yarn.lock and
      // nothing else. Measured: deleting `node_modules/is-odd` left the map
      // matching and a plain `yarn install --frozen-lockfile` answering
      // "Already up-to-date" in 0.2s — the tree stayed damaged. `--check-files`
      // (0.2s) and `--force` (0.2s) do re-link it. So a directory that the
      // install claims to have linked is only judged when the declared command
      // re-links; otherwise it is reported and the cache stays trusted.
      const top = Array.isArray(integ.topLevelPatterns) ? integ.topLevelPatterns : [];
      const checkedTop = [];
      const missingDirs = [];
      for (const pattern of top) {
        const name = yarnPatternName(pattern);
        if (!name) continue;
        checkedTop.push(name);
        if (!exists(path.join(root, 'node_modules', name))) missingDirs.push(`${name} (installed for ${pattern})`);
      }
      if (missingDirs.length) {
        if (RE_LINKING_INSTALL.test(String(spec?.run || ''))) {
          return {
            ok: false,
            ms,
            note: `${missingDirs.length}/${checkedTop.length} top-level package(s) yarn linked are not in node_modules, e.g. ${missingDirs[0]}`,
            missing: missingDirs.slice(0, 5),
          };
        }
        return {
          ok: null,
          ms,
          note: `${missingDirs.length}/${checkedTop.length} top-level package(s) yarn linked are not in node_modules, e.g. ${missingDirs[0]} — not a verdict: a satisfied \`yarn install\` trusts .yarn-integrity and leaves them missing (measured: "Already up-to-date", 0.2s). \`yarn install --check-files\` (or \`--force\`) re-links them in the same 0.2s`,
        };
      }
      const linked = checkedTop.length ? `; ${checkedTop.length} linked director${checkedTop.length === 1 ? 'y' : 'ies'} present on disk` : '';
      return { ok: true, ms, note: `${want.size} package pattern(s) present, matching yarn.lock${linked}` };
    }

    if (kind === 'berry') {
      const stateText = read(path.join(root, 'node_modules', '.yarn-state.yml'));
      if (stateText === null) return { ok: null, ms: Date.now() - t0, note: 'no node_modules/.yarn-state.yml to compare against' };
      const locators = yarnBerryLocators(lockText);
      const state = yarnStateLocations(stateText);
      if (!locators.size) return { ok: null, ms: Date.now() - t0, note: 'yarn.lock lists no packages to compare against' };
      const unlinked = [];
      for (const [locator, paths] of state) {
        for (const rel of paths) {
          // The workspace itself is linked at the checkout root.
          if (!rel || rel === '.') continue;
          if (!exists(path.join(root, rel))) unlinked.push(`${locator} → ${rel}`);
        }
      }
      const leftovers = [...state.keys()].filter((l) => !locators.has(l));
      const ms = Date.now() - t0;
      if (unlinked.length || leftovers.length) {
        const bits = [];
        if (unlinked.length) bits.push(`${unlinked.length} package(s) yarn linked are not on disk, e.g. ${unlinked[0]}`);
        if (leftovers.length) bits.push(`${leftovers.length} linked package(s) are not in yarn.lock, e.g. ${leftovers[0]}`);
        return { ok: false, ms, note: `${bits.join('; ')} — yarn re-links this`, missing: [...unlinked, ...leftovers].slice(0, 5) };
      }
      // A lockfile locator with no location is what an optional or
      // platform-specific dependency looks like; it is reported, never judged.
      // An entry with `locations: []` is the same thing after yarn wrote it.
      const linked = [...state.entries()].filter(([, paths]) => paths.length > 0);
      const notLinked = [...locators.entries()]
        .filter(([l, ent]) => ent.linkType !== 'soft' && !(state.get(l) || []).length)
        .map(([l]) => l);
      return {
        ok: true,
        ms,
        note: `${linked.length} package(s) linked on disk, all of them resolved by yarn.lock${notLinked.length ? `; ${notLinked.length} resolved package(s) have no location here (optional or platform-specific dependencies are not linked)` : ''}`,
      };
    }

    return { ok: null, ms: Date.now() - t0, note: 'yarn.lock is neither the classic nor the berry format' };
  },
};

// ---------------------------------------------------------------------------
// bun — the lockfile is the whole record.
//
// bun keeps no state file of its own: `bun.lock` (text, since bun 1.2) holds the
// resolved tree as `path → [name@version, source, metadata, integrity]`, and the
// path is where the package is installed, nesting included
// (`is-odd/is-number` → `node_modules/is-odd/node_modules/is-number`, measured).
// Measured on bun 1.2: deleting a package — top level or nested — is repaired by
// `bun install` in tens of milliseconds, while a package.json whose version was
// edited in place is left alone. So a missing install is judged and a wrong
// version is only reported.
// ---------------------------------------------------------------------------

// bun.lock is JSON with trailing commas.
function parseBunLock(text) {
  return JSON.parse(String(text).replace(/,(\s*[}\]])/g, '$1'));
}

// A lockfile key is a path under node_modules without the repeated prefix: the
// first segment is the scope (`@scope/name`) or the package name, and every
// segment after it starts a nested level.
function bunEntryPath(key) {
  const segs = String(key).split('/');
  let out = 'node_modules/';
  let i = 0;
  while (i < segs.length) {
    const scoped = segs[i].startsWith('@');
    out += scoped ? `${segs[i]}/${segs[i + 1]}` : segs[i];
    i += scoped ? 2 : 1;
    if (i < segs.length) out += '/node_modules/';
  }
  return out;
}

const platformSays = (v, want) => (Array.isArray(v) ? v.includes(want) : v === want);

const bun = {
  name: 'bun',
  unit: 'package',
  lockfiles: ['bun.lock', 'bun.lockb'],
  trees: ['node_modules'],
  available(root) {
    if (exists(path.join(root, 'bun.lock'))) return null;
    if (exists(path.join(root, 'bun.lockb'))) {
      return 'this checkout has bun.lockb, the binary lockfile, which this verifier cannot read — bun 1.2 and later write bun.lock (text) on install';
    }
    return 'no bun.lock in this checkout to compare the install against';
  },
  verify(root) {
    const lockPath = path.join(root, 'bun.lock');
    if (!exists(lockPath)) return { ok: null, ms: 0, note: 'no bun.lock to compare the install against' };
    let lock;
    try {
      lock = parseBunLock(read(lockPath));
    } catch (e) {
      return { ok: null, ms: 0, note: `unreadable bun.lock: ${e.message}` };
    }
    const packages = lock?.packages && typeof lock.packages === 'object' ? lock.packages : {};
    // A workspace member is keyed by its path, not by a node_modules location.
    const workspaceNames = new Set(Object.values(lock?.workspaces || {}).map((w) => w && w.name).filter(Boolean));
    const keys = Object.keys(packages).filter((k) => {
      if (!k || k.startsWith('.')) return false;
      const first = k.startsWith('@') ? k.split('/').slice(0, 2).join('/') : k.split('/')[0];
      return !workspaceNames.has(first);
    });
    if (!keys.length) return { ok: null, ms: 0, note: 'bun.lock lists no installed packages to compare against' };

    // Which linker wrote this tree decides what the install even is, and it is
    // visible from the tree itself: the isolated linker keeps a
    // `node_modules/.bun` store.
    //
    // hoisted: the lockfile key path under node_modules is the install —
    // `node_modules/is-number`, and `node_modules/is-odd/node_modules/is-number`
    // for a key that could not be hoisted. Measured: deleting either a direct or
    // a transitive entry left `bun install --frozen-lockfile` restoring it in
    // 30-42ms, so a missing entry is a verdict a plain install repairs.
    //
    // isolated: there is no top-level entry for a transitive package at all
    // (only the workspace's own dependencies are linked at the root), so the
    // store directory `node_modules/.bun/<name>@<version>` is the install, and
    // a name with two versions has one farm link but two store directories.
    // Measured: a deleted store directory is *not* rebuilt — `bun install
    // --frozen-lockfile` answered "Checked 6 installs across 32 packages (no
    // changes)" and left it gone — which is why its absence is reported rather
    // than judged, exactly like pnpm.
    const isolated = exists(path.join(root, 'node_modules', '.bun'));
    const t0 = Date.now();
    const missing = [];
    const wrong = [];
    const skipped = [];
    for (const key of keys) {
      const entry = packages[key];
      const spec = Array.isArray(entry) ? entry[0] : null;
      const meta = (Array.isArray(entry) && entry[2] && typeof entry[2] === 'object') ? entry[2] : {};
      if (!spec || typeof spec !== 'string') { skipped.push(key); continue; }
      // A package for another platform, or one that is optional here, is
      // legitimately absent: checking it would call a correct checkout broken.
      if ((meta.os && !platformSays(meta.os, process.platform)) ||
          (meta.cpu && !platformSays(meta.cpu, os.arch())) ||
          meta.libc || meta.optional === true) {
        skipped.push(key);
        continue;
      }
      const at = spec.lastIndexOf('@');
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      // Reported paths are written the way a path in a lockfile is written —
      // with forward slashes — because they are meant to be pasted into a
      // message or a shell, not resolved by this process.
      const rel = isolated ? `node_modules/.bun/${name.replace(/\//g, '+')}@${version}` : bunEntryPath(key);
      if (!exists(path.join(root, rel))) {
        missing.push(rel);
        continue;
      }
      if (!isolated) {
        const pj = readJson(path.join(root, rel, 'package.json'));
        if (!pj || pj.version !== version) wrong.push(`${rel} (${pj?.version || 'no package.json'} instead of ${version})`);
      }
    }
    const ms = Date.now() - t0;
    const checked = keys.length - skipped.length;
    const unchecked = skipped.length ? `${skipped.length} not checked (another platform or optional here, e.g. ${skipped[0]})` : '';

    if (missing.length) {
      if (isolated) {
        return {
          ok: null,
          ms,
          note: [`${missing.length}/${checked} package(s) bun.lock resolves have no directory in node_modules/.bun, e.g. ${missing[0]} — not a verdict: bun considers the install satisfied (measured: "Checked 6 installs across 32 packages (no changes)") and does not rebuild a missing store directory; a fresh \`bun install\` after removing node_modules does`, unchecked].filter(Boolean).join('; '),
        };
      }
      return {
        ok: false,
        ms,
        note: [`${missing.length}/${checked} installed package(s) missing, e.g. ${missing[0]}`, unchecked].filter(Boolean).join('; '),
        missing: missing.slice(0, 5),
      };
    }
    if (wrong.length) {
      // Measured: `bun install` leaves an edited package.json alone, so this is
      // reported rather than judged — a verdict would rebuild forever.
      return {
        ok: null,
        ms,
        note: `${wrong.length} package(s) are installed at a different version than bun.lock, e.g. ${wrong[0]} — not a verdict: bun install does not rewrite a tree it considers satisfied`, 
        missing: wrong.slice(0, 5),
      };
    }
    return {
      ok: true,
      ms,
      note: [`${checked} package(s) present, matching bun.lock${isolated ? ' (isolated store)' : ' (hoisted)'}`, unchecked].filter(Boolean).join('; '),
    };
  },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const BUILTINS = { npm, pnpm, yarn, bun, venv, gems, gomod, crates };

export const BUILTIN_NAMES = Object.keys(BUILTINS);
export const VERIFY_BUILTINS = new Set([AUTO, ...BUILTIN_NAMES]);

// Every lockfile any builtin can read, for the error message a typo deserves.
export function builtinLockfiles(name) {
  return BUILTINS[name]?.lockfiles || [];
}

export function canonicalBuiltin(name) {
  if (name === undefined || name === null || name === '') return null;
  const raw = String(name).trim().toLowerCase();
  const resolved = BUILTIN_ALIASES[raw] || raw;
  return VERIFY_BUILTINS.has(resolved) ? resolved : null;
}

// The `auto` builtin resolves to whichever ecosystem verifier this checkout has
// something for. Resolution is a pure function of the spec and the filesystem,
// so `manual setup` and the plan can report it without running anything.
export function resolveBuiltin(root, spec = {}) {
  const declared = canonicalBuiltin(spec.verifyBuiltin) || canonicalBuiltin(String(spec.verify || '').replace(/^builtin:/, ''));
  if (!declared) return { name: null, builtin: null, why: 'no builtin verifier declared' };
  if (declared !== AUTO) return { name: declared, builtin: BUILTINS[declared], why: 'declared', lockfile: firstOf(root, BUILTINS[declared].lockfiles) };

  // A setup's own evidence comes first: it is the file whose content decides
  // what the install would produce, so it is the best statement of which
  // ecosystem this step installs.
  const byEvidence = [];
  for (const e of spec.evidence || []) {
    const base = path.basename(String(e));
    for (const name of BUILTIN_NAMES) {
      if (BUILTINS[name].lockfiles.includes(base)) byEvidence.push({ name, file: base });
    }
  }
  const names = [...new Set(byEvidence.map((b) => b.name))];
  if (names.length === 1) return { name: names[0], builtin: BUILTINS[names[0]], why: `matched ${byEvidence[0].file} (declared evidence)`, lockfile: byEvidence[0].file };
  if (names.length > 1) {
    return { name: null, builtin: null, why: `cannot tell which ecosystem: ${[...new Set(byEvidence.map((b) => b.file))].join(', ')} are all declared as evidence — name one in verify: { builtin: ${names.join(' } or { builtin: ')} }` };
  }

  const here = [];
  for (const name of BUILTIN_NAMES) {
    const lockfile = firstOf(root, BUILTINS[name].lockfiles);
    if (lockfile) here.push({ name, lockfile });
  }
  if (here.length === 1) return { name: here[0].name, builtin: BUILTINS[here[0].name], why: `found ${here[0].lockfile}`, lockfile: here[0].lockfile };
  if (here.length > 1) {
    return { name: null, builtin: null, why: `cannot tell which ecosystem: ${here.map((h) => h.lockfile).join(', ')} are all here — name one in verify: { builtin: ${here.map((h) => h.name).join(' } or { builtin: ')} }` };
  }
  return { name: null, builtin: null, why: `no lockfile any verifier understands (${BUILTIN_NAMES.map((n) => BUILTINS[n].lockfiles.join('/')).join(', ')})` };
}

// Cheap enough for `manual setup` and the plan: a stat, or one readdir, and no
// verdict. Returns the reason a verifier cannot answer *here*, or null.
export function verifierAvailable(root, spec = {}) {
  const r = resolveBuiltin(root, spec);
  if (!r.builtin) return r.why;
  return r.builtin.available(root, spec);
}

// Run the resolved builtin. `ok: null` is an answer, not a failure: it means the
// verifier had nothing to compare against, and it must not be read as "no".
export function runBuiltinVerifier(root, spec = {}) {
  const r = resolveBuiltin(root, spec);
  if (!r.builtin) return { ok: null, ms: 0, note: r.why, unavailable: true };
  const reason = r.builtin.available(root, spec);
  // `unavailable` separates "this verifier cannot answer here at all" (reported
  // by `manual setup` and doctor, and not worth repeating on every verify) from
  // "it could answer and declined" — which is news, and is printed.
  if (reason) return { ok: null, ms: 0, note: reason, builtin: r.name, unavailable: true };
  let out;
  try {
    out = r.builtin.verify(root, spec);
  } catch (e) {
    return { ok: null, ms: 0, note: `${r.name} could not complete: ${e.message}`, builtin: r.name };
  }
  return { ok: out.ok, ms: out.ms ?? 0, note: out.note, missing: out.missing, builtin: r.name };
}

// Which ecosystems could be verified in this checkout — used by init to declare
// the verifier for the ecosystem it just discovered, and by the docs to say what
// is covered. A builtin is only declared when its lockfile is actually present:
// a verifier that can never run is noise on every report.
export function builtinForLockfiles(root, files) {
  const wanted = new Set((files || []).map((f) => path.basename(String(f))));
  for (const name of BUILTIN_NAMES) {
    if (BUILTINS[name].lockfiles.some((l) => wanted.has(l) && exists(path.join(root, l)))) return name;
  }
  return null;
}

// The older single-ecosystem entry points, kept so an existing caller of
// setup.js keeps working: `lockfile` was always npm's lockfile.
export const lockfileIn = (root) => firstOf(root, NPM_LOCKS);
export const verifyLockfile = (root) => npm.verify(root, {});
