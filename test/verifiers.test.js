import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_ALIASES,
  BUILTIN_NAMES,
  canonicalBuiltin,
  resolveBuiltin,
  runBuiltinVerifier,
  verifierAvailable,
} from '../src/verifiers.js';
import { ensureSetup, normalizeSetup, normalizeVerify, readSetupCache, resetSetupMemo, setupKey } from '../src/setup.js';

// ---------------------------------------------------------------------------
// Built-in verifiers, one per ecosystem.
//
// Every test here is about the same three answers, because the third one is the
// one that decides whether the feature works at all: a verifier that answers "no"
// when it means "I cannot tell" rebuilds a perfectly good tree on every verify,
// and the symptom looks exactly like a verifier that does not work.
//
// The fixtures are the real shapes: a pnpm lockfile is the bytes pnpm 11 wrote,
// the Go module cache is the escaped directory layout a real cache has
// (`!burnt!sushi`), a Gemfile.lock has the GEM/specs block and the gemspec files
// Bundler actually writes.
// ---------------------------------------------------------------------------

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const mkdir = (root, rel) => fs.mkdirSync(path.join(root, rel), { recursive: true });

// A normalized setup spec, the way the runner sees one. `verify` takes the same
// map a claim or manual.yaml would write.
const spec = (verify, extra = {}) =>
  normalizeSetup({ setup: { run: 'install', evidence: ['nothing.txt'], cache: [], ...extra, ...(verify ? { verify } : {}) } });

const withEnv = (map, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(map)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe('verifiers: names and resolution', () => {
  test('the older single-verifier name still resolves', () => {
    // `lockfile` was the only verifier this tool had. A claim that says it keeps
    // working; the canonical name for the same check is now `npm`.
    assert.deepEqual(BUILTIN_ALIASES, { lockfile: 'npm' });
    assert.equal(canonicalBuiltin('lockfile'), 'npm');
    assert.equal(canonicalBuiltin('npm'), 'npm');
    assert.equal(canonicalBuiltin('nope'), null);
    assert.equal(normalizeVerify({ builtin: 'lockfile' }).builtin, 'npm');
    assert.equal(normalizeVerify('builtin:lockfile').verify, 'builtin:npm');
  });

  test('an unknown builtin lists the alternatives instead of just refusing', () => {
    const err = normalizeVerify({ builtin: 'bundler' }).error;
    assert.match(err, /not one of: auto \| npm \| pnpm \| yarn \| bun \| venv \| gems \| gomod \| crates/);
    // The typo a Ruby user actually types, and what to write instead.
    assert.match(err, /lockfile is an older spelling of npm/);
  });

  test('every named ecosystem has a lockfile it reads and a name it answers to', () => {
    for (const name of BUILTIN_NAMES) {
      const r = resolveBuiltin(tmp('manual-none-'), spec({ builtin: name }));
      assert.equal(r.name, name);
      assert.ok(r.builtin.lockfiles.length > 0, `${name} declares the lockfiles it reads`);
      assert.equal(typeof r.builtin.verify, 'function');
      assert.equal(typeof r.builtin.available, 'function');
    }
  });

  test('auto recognises the two package managers that write their own lockfile', () => {
    const yarnRepo = tmp('manual-auto-');
    write(yarnRepo, 'yarn.lock', '# yarn lockfile v1\n');
    assert.equal(resolveBuiltin(yarnRepo, spec({ builtin: 'auto' })).name, 'yarn');
    const bunRepo = tmp('manual-auto-');
    write(bunRepo, 'bun.lock', '{"lockfileVersion":1,"packages":{}}\n');
    assert.equal(resolveBuiltin(bunRepo, spec({ builtin: 'auto' })).name, 'bun');
  });

  test('auto picks the verifier from the setup’s own evidence first', () => {
    const root = tmp('manual-auto-');
    // Two ecosystems are present, and the evidence names one of them: the
    // evidence is the file that decides what this step installs, so it wins.
    write(root, 'package-lock.json', '{"packages":{}}');
    write(root, 'Gemfile.lock', 'GEM\n  specs:\n');
    const r = resolveBuiltin(root, spec({ builtin: 'auto' }, { evidence: ['Gemfile.lock'] }));
    assert.equal(r.name, 'gems');
    assert.match(r.why, /matched Gemfile\.lock/);
  });

  test('auto falls back to what is on disk, and refuses to guess between two', () => {
    const one = tmp('manual-auto-');
    write(one, 'requirements.txt', 'six==1.16.0\n');
    assert.equal(resolveBuiltin(one, spec({ builtin: 'auto' })).name, 'venv');

    const two = tmp('manual-auto-');
    write(two, 'package-lock.json', '{"packages":{}}');
    write(two, 'Cargo.lock', 'version = 4\n');
    const r = resolveBuiltin(two, spec({ builtin: 'auto' }));
    assert.equal(r.name, null, 'two ecosystems is a question, not a coin flip');
    assert.match(r.why, /cannot tell which ecosystem: package-lock\.json, Cargo\.lock/);
    // And the refusal is an answer, not a failure: nothing is distrusted because
    // of it.
    const v = runBuiltinVerifier(two, spec({ builtin: 'auto' }));
    assert.equal(v.ok, null);
    assert.match(v.note, /cannot tell which ecosystem/);
  });

  test('auto on a checkout with nothing to compare against says so', () => {
    const root = tmp('manual-auto-');
    write(root, 'package.json', '{"name":"x"}');
    const r = resolveBuiltin(root, spec({ builtin: 'auto' }));
    assert.equal(r.name, null);
    assert.match(r.why, /no lockfile any verifier understands/);
  });
});

describe('verifiers: npm', () => {
  test('a lockfileVersion 1 tree is read, and never reports an empty tree as fine', () => {
    // v1 has no `packages` map, only nested `dependencies`. Reading only
    // `packages` declared *nothing*, and "0 package(s) present" is a yes for a
    // tree that does not exist — the one answer a verifier must never get wrong.
    const root = tmp('manual-npm-');
    write(
      root,
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: { outer: { version: '1.0.0', dependencies: { inner: { version: '1.0.0' } } } },
      }),
    );
    mkdir(root, 'node_modules/outer');
    mkdir(root, 'node_modules/outer/node_modules/inner');
    const s = spec({ builtin: 'npm' });
    assert.equal(runBuiltinVerifier(root, s).ok, true);

    fs.rmSync(path.join(root, 'node_modules/outer/node_modules'), { recursive: true });
    const v = runBuiltinVerifier(root, s);
    assert.equal(v.ok, false);
    assert.match(v.note, /1\/2 installed package\(s\) missing/);

    // A lockfile that declares nothing is not a yes either.
    const empty = tmp('manual-npm-');
    write(empty, 'package-lock.json', '{"lockfileVersion":3,"packages":{"":{"name":"x"}}}');
    const e = runBuiltinVerifier(empty, spec({ builtin: 'npm' }));
    assert.equal(e.ok, null);
    assert.match(e.note, /declares no installed packages/);
  });

  test('a repo with another package manager’s lockfile is told which verifier covers it', () => {
    const root = tmp('manual-npm-');
    write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    mkdir(root, 'node_modules');
    const reason = verifierAvailable(root, spec({ builtin: 'npm' }));
    assert.match(reason, /no package-lock\.json or npm-shrinkwrap\.json/);
    assert.match(reason, /pnpm-lock\.yaml is present/);
  });
});

describe('verifiers: pnpm', () => {
  // The shape pnpm 11 writes, including a scoped package: the lockfile key is
  // `@scope/name@version` and the store directory is `@scope+name@version`.
  const LOCK =
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      is-odd:\n        specifier: 3.0.1\n        version: 3.0.1\n\npackages:\n\n  '@sindresorhus/is@7.0.0':\n    resolution: {integrity: sha512-Wu1V}\n\n  is-number@6.0.0:\n    resolution: {integrity: sha512-Wu1V}\n\n  is-odd@3.0.1:\n    resolution: {integrity: sha512-CQpn}\n";

  const installStore = (root, ...dirs) => {
    for (const d of dirs) mkdir(root, path.join('node_modules', '.pnpm', d));
  };

  test('every resolved package must be in the virtual store, by pnpm’s own spelling', () => {
    const root = tmp('manual-pnpm-');
    write(root, 'pnpm-lock.yaml', LOCK);
    installStore(root, '@sindresorhus+is@7.0.0', 'is-number@6.0.0', 'is-odd@3.0.1');
    write(root, 'node_modules/.pnpm/lock.yaml', LOCK);
    const s = spec({ builtin: 'pnpm' });
    const ok = runBuiltinVerifier(root, s);
    assert.equal(ok.ok, true);
    assert.match(ok.note, /3 package\(s\) present in node_modules\/\.pnpm, matching pnpm-lock\.yaml/);

    // The gap this exists to find: a package the lockfile resolves is not in the
    // store at all. The top level of node_modules is untouched, so the witness
    // cannot see it either. It is *reported*, not judged: measured on pnpm 11, a
    // satisfied install does not restore a deleted store directory, so a verdict
    // of "no" here would rebuild on every verify and never change its answer.
    fs.rmSync(path.join(root, 'node_modules/.pnpm/is-number@6.0.0'), { recursive: true });
    const missing = runBuiltinVerifier(root, s);
    assert.equal(missing.ok, null);
    assert.match(missing.note, /1\/3 package\(s\) the lockfile lists are not in node_modules\/\.pnpm, e\.g\. is-number@6\.0\.0/);
    assert.match(missing.note, /not a verdict/);
  });

  test('a peer-resolved store entry still counts as the package being there', () => {
    const root = tmp('manual-pnpm-');
    write(root, 'pnpm-lock.yaml', LOCK);
    // pnpm names peer variants `name@version_peer@version`; the package is
    // installed, just resolved against a peer set the lockfile does not spell
    // out per directory.
    installStore(root, '@sindresorhus+is@7.0.0', 'is-number@6.0.0_react@18.3.1', 'is-odd@3.0.1');
    write(root, 'node_modules/.pnpm/lock.yaml', LOCK);
    assert.equal(runBuiltinVerifier(root, spec({ builtin: 'pnpm' })).ok, true);
  });

  test('a store-consistent tree with a foreign lockfile copy is cannot-tell', () => {
    // Measured on pnpm 11: a satisfied `pnpm install` does not rewrite the copy,
    // not even with --force. Answering "no" here would rebuild the tree on every
    // verify and still complain about a file the rebuild never restores, so the
    // difference is reported and the store decides the verdict.
    const root = tmp('manual-pnpm-');
    write(root, 'pnpm-lock.yaml', LOCK);
    installStore(root, '@sindresorhus+is@7.0.0', 'is-number@6.0.0', 'is-odd@3.0.1');
    const s = spec({ builtin: 'pnpm' });

    write(root, 'node_modules/.pnpm/lock.yaml', `${LOCK}\n  extra@1.0.0: {}\n`);
    const foreign = runBuiltinVerifier(root, s);
    assert.equal(foreign.ok, null);
    assert.match(foreign.note, /node_modules\/\.pnpm\/lock\.yaml differs from pnpm-lock\.yaml/);

    fs.rmSync(path.join(root, 'node_modules/.pnpm/lock.yaml'));
    const absent = runBuiltinVerifier(root, s);
    assert.equal(absent.ok, null);
    assert.match(absent.note, /is missing, so there is no record of/);

    fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
    const none = runBuiltinVerifier(root, s);
    assert.equal(none.ok, null, 'no lockfile is cannot-tell, not no');
    assert.match(none.note, /no pnpm-lock\.yaml/);
  });

  test('an install that is not there at all, and a pre-pnpm-8 lock, are reported too', () => {
    const root = tmp('manual-pnpm-');
    write(root, 'pnpm-lock.yaml', LOCK);
    const s = spec({ builtin: 'pnpm' });
    const gone = runBuiltinVerifier(root, s);
    assert.equal(gone.ok, null);
    assert.match(gone.note, /node_modules\/\.pnpm is not there, so nothing here was installed by pnpm/);

    // The older `/name/version` key layout does not map to store directory
    // names the same way, so it is reported rather than guessed at.
    const old = tmp('manual-pnpm-');
    write(old, 'pnpm-lock.yaml', "lockfileVersion: 5.4\n\npackages:\n\n  /is-odd/3.0.1:\n    resolution: {integrity: sha512-CQpn}\n");
    installStore(old, 'is-odd@3.0.1');
    const v = runBuiltinVerifier(old, s);
    assert.equal(v.ok, null);
    assert.match(v.note, /pre-pnpm-8 `\/name\/version` key layout/);
  });
});

describe('verifiers: yarn', () => {
  // Classic yarn records the pattern → resolved-URL map it installed from, which
  // is exactly the map its own IntegrityChecker compares against yarn.lock.
  const CLASSIC = [
    '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
    '# yarn lockfile v1',
    '',
    'is-number@^6.0.0:',
    '  version "6.0.0"',
    '  resolved "https://registry.yarnpkg.com/is-number/-/is-number-6.0.0.tgz#e6d15ad31fc262887cccf217ae5f9316f81b1995"',
    '  integrity sha512-Wu1V',
    '',
    'is-odd@3.0.1:',
    '  version "3.0.1"',
    '  resolved "https://registry.yarnpkg.com/is-odd/-/is-odd-3.0.1.tgz#65101baf3727d728b66fa62f50cda7f2d3989601"',
    '  dependencies:',
    '    is-number "^6.0.0"',
    '',
  ].join('\n');

  const ENTRIES = {
    'is-number@^6.0.0': 'https://registry.yarnpkg.com/is-number/-/is-number-6.0.0.tgz#e6d15ad31fc262887cccf217ae5f9316f81b1995',
    'is-odd@3.0.1': 'https://registry.yarnpkg.com/is-odd/-/is-odd-3.0.1.tgz#65101baf3727d728b66fa62f50cda7f2d3989601',
  };
  const integrity = (entries) =>
    JSON.stringify({
      systemParams: 'win32-x64-127',
      modulesFolders: ['node_modules'],
      flags: { ignoreScripts: false },
      linkedModules: [],
      topLevelPatterns: ['is-odd@3.0.1'],
      lockfileEntries: entries,
      files: [],
      artifacts: {},
    });

  test('classic yarn: the installed entry map is compared with yarn.lock', () => {
    const root = tmp('manual-yarn1-');
    write(root, 'yarn.lock', CLASSIC);
    write(root, 'node_modules/.yarn-integrity', integrity(ENTRIES));
    mkdir(root, 'node_modules/is-odd');
    const s = spec({ builtin: 'yarn' });
    const ok = runBuiltinVerifier(root, s);
    assert.equal(ok.ok, true);
    assert.match(ok.note, /2 package pattern\(s\) present, matching yarn\.lock/);
    assert.match(ok.note, /1 linked directory present on disk/);

    // An install made from another lockfile revision: yarn's own check re-runs
    // the install for this, which is why the verdict is safe to make.
    write(root, 'node_modules/.yarn-integrity', integrity({ ...ENTRIES, 'gone@^1.0.0': 'https://registry.yarnpkg.com/gone/-/gone-1.0.0.tgz#deadbee' }));
    const extra = runBuiltinVerifier(root, s);
    assert.equal(extra.ok, false);
    assert.match(extra.note, /1 of 2 package pattern\(s\) differ/);
    assert.match(extra.note, /gone@\^1\.0\.0 \(installed, and no longer in yarn\.lock\)/);

    write(root, 'node_modules/.yarn-integrity', integrity({ ...ENTRIES, 'is-odd@3.0.1': 'https://registry.yarnpkg.com/is-odd/-/is-odd-9.9.9.tgz#other' }));
    const stale = runBuiltinVerifier(root, s);
    assert.equal(stale.ok, false);
    assert.match(stale.note, /is-odd@3\.0\.1 \(installed from is-odd\/-\/is-odd-9\.9\.9\.tgz#other\)/);

    write(root, 'node_modules/.yarn-integrity', integrity({ 'is-odd@3.0.1': ENTRIES['is-odd@3.0.1'] }));
    const partial = runBuiltinVerifier(root, s);
    assert.equal(partial.ok, false);
    assert.match(partial.note, /is-number@\^6\.0\.0 \(in yarn\.lock, not in the install\)/);
  });

  test('classic yarn: a directory the install claims to have linked is judged only when the command re-links', () => {
    const root = tmp('manual-yarn1-');
    write(root, 'yarn.lock', CLASSIC);
    write(root, 'node_modules/.yarn-integrity', integrity(ENTRIES));
    // The map matches yarn.lock, and the directory it says it linked is gone.
    // Measured: `yarn install --frozen-lockfile` answers "Already up-to-date"
    // (0.2s) and leaves the tree that way, so this cannot be a verdict for the
    // command init writes — it would distrust the cache and reinstall forever
    // without ever repairing anything.
    const reported = runBuiltinVerifier(root, spec({ builtin: 'yarn' }));
    assert.equal(reported.ok, null, 'a command that will not re-link cannot call this broken');
    assert.match(reported.note, /1\/1 top-level package\(s\) yarn linked are not in node_modules, e\.g\. is-odd \(installed for is-odd@3\.0\.1\)/);
    assert.match(reported.note, /not a verdict/);
    assert.match(reported.note, /--check-files/);

    // `--check-files` is the flag that does re-link (measured 0.2s), so with it
    // declared this is a verdict the install repairs.
    const relinking = runBuiltinVerifier(root, spec({ builtin: 'yarn' }, { run: 'yarn install --frozen-lockfile --check-files' }));
    assert.equal(relinking.ok, false);
    assert.match(relinking.note, /1\/1 top-level package\(s\) yarn linked are not in node_modules/);
  });

  test('classic yarn without an install, and an unreadable lockfile, are cannot-tell', () => {
    const root = tmp('manual-yarn1-');
    write(root, 'yarn.lock', CLASSIC);
    const s = spec({ builtin: 'yarn' });
    assert.match(verifierAvailable(root, s), /no node_modules\/\.yarn-integrity/);
    assert.equal(runBuiltinVerifier(root, s).ok, null);

    write(root, 'node_modules/.yarn-integrity', integrity(ENTRIES));
    write(root, 'yarn.lock', 'something else entirely\n');
    const odd = runBuiltinVerifier(root, s);
    assert.equal(odd.ok, null);
    assert.match(odd.note, /neither the classic \(v1\) nor the modern \(berry\) format/);
  });

  // Berry in node-modules mode writes the locations it linked; that file is what
  // `yarn install` re-links from, and deleting a location makes it restore it.
  const BERRY = [
    '# This file is generated by running "yarn install" inside your project.',
    '# Manual changes might be lost - proceed with caution!',
    '',
    '__metadata:',
    '  version: 8',
    '  cacheKey: 10c0',
    '',
    '"is-number@npm:^6.0.0":',
    '  version: 6.0.0',
    '  resolution: "is-number@npm:6.0.0"',
    '  checksum: 10c0/5da4c68401529675c575878d2760d66f18eaef4b014858577f6003daf66488d7',
    '  languageName: node',
    '  linkType: hard',
    '',
    '"is-odd@npm:3.0.1":',
    '  version: 3.0.1',
    '  resolution: "is-odd@npm:3.0.1"',
    '  dependencies:',
    '    is-number: "npm:^6.0.0"',
    '  checksum: 10c0/89ee2e353c5a3f3bd400c79db1c307a5b3506198ee8169d521e533a9b1d8a08f',
    '  languageName: node',
    '  linkType: hard',
    '',
    '"probe@workspace:.":',
    '  version: 0.0.0-use.local',
    '  resolution: "probe@workspace:."',
    '  languageName: unknown',
    '  linkType: soft',
    '',
  ].join('\n');

  const STATE = (extra = '') =>
    ['# Warning: This file is automatically generated. Removing it is fine, but will', '# cause your node_modules installation to become invalidated.', '', '__metadata:', '  version: 1', '  nmMode: classic', '', '"is-number@npm:6.0.0":', '  locations:', '    - "node_modules/is-number"', '', '"is-odd@npm:3.0.1":', '  locations:', '    - "node_modules/is-odd"', '', '"probe@workspace:.":', '  locations:', '    - ""', extra].join('\n');

  const makeBerryRepo = () => {
    const root = tmp('manual-yarn4-');
    write(root, 'yarn.lock', BERRY);
    write(root, 'node_modules/.yarn-state.yml', STATE());
    mkdir(root, 'node_modules/is-number');
    mkdir(root, 'node_modules/is-odd');
    return root;
  };

  test('berry: the linked locations are compared with yarn.lock', () => {
    const root = makeBerryRepo();
    const s = spec({ builtin: 'yarn' });
    const ok = runBuiltinVerifier(root, s);
    assert.equal(ok.ok, true);
    assert.match(ok.note, /3 package\(s\) linked on disk, all of them resolved by yarn\.lock/);

    // A package the state says is linked, and is not: yarn re-links this.
    fs.rmSync(path.join(root, 'node_modules/is-odd'), { recursive: true });
    const unlinked = runBuiltinVerifier(root, s);
    assert.equal(unlinked.ok, false);
    assert.match(unlinked.note, /1 package\(s\) yarn linked are not on disk, e\.g\. is-odd@npm:3\.0\.1 → node_modules\/is-odd/);

    // A linked package the lockfile no longer resolves: a tree from another
    // revision.
    write(root, 'node_modules/.yarn-state.yml', STATE('\n"gone@npm:1.0.0":\n  locations:\n    - "node_modules/gone"\n'));
    mkdir(root, 'node_modules/is-odd');
    mkdir(root, 'node_modules/gone');
    const leftover = runBuiltinVerifier(root, s);
    assert.equal(leftover.ok, false);
    assert.match(leftover.note, /1 linked package\(s\) are not in yarn\.lock, e\.g\. gone@npm:1\.0\.0/);
  });

  test('berry: a resolved package with no location is reported, never judged', () => {
    // Optional and platform-specific dependencies are resolved by the lockfile
    // and deliberately not linked here, so their absence is not a gap.
    const root = makeBerryRepo();
    write(root, 'node_modules/.yarn-state.yml', STATE().replace('  locations:\n    - "node_modules/is-number"\n', '  locations: []\n'));
    const v = runBuiltinVerifier(root, spec({ builtin: 'yarn' }));
    assert.equal(v.ok, true);
    assert.match(v.note, /1 resolved package\(s\) have no location here/);
  });

  test('berry with PnP, and berry with no state at all, are cannot-tell', () => {
    const root = tmp('manual-yarn4-');
    write(root, 'yarn.lock', BERRY);
    write(root, '.pnp.cjs', '#!/usr/bin/env node\nconst RAW_RUNTIME_STATE = \'{}\';\n');
    const s = spec({ builtin: 'yarn' });
    assert.match(verifierAvailable(root, s), /uses yarn's PnP linker/);
    const pnp = runBuiltinVerifier(root, s);
    assert.equal(pnp.ok, null, 'nothing to compare against is not a verdict');

    fs.rmSync(path.join(root, '.pnp.cjs'));
    assert.match(verifierAvailable(root, s), /no node_modules\/\.yarn-state\.yml/);
  });
});

describe('verifiers: bun', () => {
  // The real shape, trailing commas and all (bun.lock is JSON that bun writes
  // with them): each package is `path → [name@version, source, metadata,
  // integrity]`, and the path is where the package is installed, nesting
  // included.
  const BUN = [
    '{',
    '  "lockfileVersion": 1,',
    '  "workspaces": {',
    '    "": {',
    '      "name": "probe",',
    '      "dependencies": {',
    '        "is-odd": "3.0.1",',
    '      },',
    '    },',
    '  },',
    '  "packages": {',
    '    "is-number": ["is-number@6.0.0", "", {}, "sha512-aaa"],',
    '    "is-odd": ["is-odd@3.0.1", "", {}, "sha512-bbb"],',
    '    "is-odd/is-number": ["is-number@6.0.0", "", {}, "sha512-ccc"],',
    '    "@esbuild/aix-ppc64": ["@esbuild/aix-ppc64@0.28.2", "", { "os": "aix", "cpu": "ppc64" }, "sha512-ddd"],',
    '  },',
    '}',
  ].join('\n');

  const pkgJson = (name, version) => JSON.stringify({ name, version }, null, 2);

  const makeBunRepo = () => {
    const root = tmp('manual-bun-');
    write(root, 'package.json', pkgJson('probe', '0.0.0'));
    write(root, 'bun.lock', BUN);
    write(root, 'node_modules/is-number/package.json', pkgJson('is-number', '6.0.0'));
    write(root, 'node_modules/is-odd/package.json', pkgJson('is-odd', '3.0.1'));
    write(root, 'node_modules/is-odd/node_modules/is-number/package.json', pkgJson('is-number', '6.0.0'));
    return root;
  };

  test('bun: every path in the lockfile is looked for under node_modules', () => {
    const root = makeBunRepo();
    const s = spec({ builtin: 'bun' });
    const ok = runBuiltinVerifier(root, s);
    assert.equal(ok.ok, true);
    assert.match(ok.note, /3 package\(s\) present, matching bun\.lock/);
    // A package for another platform is resolved by the lockfile and
    // deliberately absent: checking it would call a correct checkout broken.
    assert.match(ok.note, /1 not checked \(another platform or optional here, e\.g\. @esbuild\/aix-ppc64\)/);

    // A nested install is checked where it is nested, not at the top level.
    fs.rmSync(path.join(root, 'node_modules/is-odd/node_modules/is-number'), { recursive: true });
    const nested = runBuiltinVerifier(root, s);
    assert.equal(nested.ok, false);
    assert.match(nested.note, /1\/3 installed package\(s\) missing, e\.g\. node_modules\/is-odd\/node_modules\/is-number/);
  });

  test('bun: a version that differs from the lockfile is reported, never judged', () => {
    const root = makeBunRepo();
    write(root, 'node_modules/is-odd/package.json', pkgJson('is-odd', '9.9.9'));
    const v = runBuiltinVerifier(root, spec({ builtin: 'bun' }));
    // Measured: `bun install` leaves an edited package.json alone, so answering
    // "no" here would rebuild the tree on every verify and change nothing.
    assert.equal(v.ok, null, 'a wrong version is not something a reinstall repairs');
    assert.match(v.note, /1 package\(s\) are installed at a different version than bun\.lock, e\.g\. node_modules\/is-odd \(9\.9\.9 instead of 3\.0\.1\)/);
    assert.match(v.note, /not a verdict/);
  });

  test('bun: the isolated linker is checked in its own store', () => {
    const root = makeBunRepo();
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    // `bun install --linker isolated` keeps one directory per resolved package.
    write(root, 'node_modules/.bun/is-number@6.0.0/package.json', pkgJson('is-number', '6.0.0'));
    write(root, 'node_modules/.bun/is-odd@3.0.1/package.json', pkgJson('is-odd', '3.0.1'));
    const s = spec({ builtin: 'bun' });
    const ok = runBuiltinVerifier(root, s);
    assert.equal(ok.ok, true);
    assert.match(ok.note, /matching bun\.lock \(isolated store\)/);

    // A missing store directory: measured, bun answers "Checked 6 installs
    // across 32 packages (no changes)" and does not rebuild it, so this is
    // reported rather than judged — a verdict would rebuild forever.
    fs.rmSync(path.join(root, 'node_modules/.bun/is-odd@3.0.1'), { recursive: true });
    const gone = runBuiltinVerifier(root, s);
    assert.equal(gone.ok, null, 'bun does not rebuild a missing store directory');
    assert.match(gone.note, /have no directory in node_modules\/\.bun, e\.g\. node_modules\/\.bun\/is-odd@3\.0\.1/);
    assert.match(gone.note, /not a verdict/);
  });

  test('bun: a scoped package in the isolated store is spelled @scope+name', () => {
    const root = tmp('manual-bun-');
    write(root, 'package.json', pkgJson('probe', '0.0.0'));
    write(root, 'bun.lock', [
      '{',
      '  "lockfileVersion": 1,',
      '  "packages": {',
      '    "@esbuild/linux-x64": ["@esbuild/linux-x64@0.28.2", "", { "os": "linux", "cpu": "x64" }, "sha512-eee"],',
      '  },',
      '}',
    ].join('\n'));
    write(root, 'node_modules/.bun/@esbuild+linux-x64@0.28.2/package.json', pkgJson('@esbuild/linux-x64', '0.28.2'));
    const v = runBuiltinVerifier(root, spec({ builtin: 'bun' }));
    // Whether this is judged at all depends on the machine running it, so the
    // assertion is about the store's spelling when it is present.
    if (process.platform === 'linux' && process.arch === 'x64') {
      assert.equal(v.ok, true);
      assert.match(v.note, /1 package\(s\) present/);
    } else {
      assert.equal(v.ok, true);
      assert.match(v.note, /1 not checked \(another platform/);
    }
  });

  test('bun: no readable lockfile is cannot-tell, not a verdict', () => {
    const root = tmp('manual-bun-');
    write(root, 'package.json', pkgJson('probe', '0.0.0'));
    const s = spec({ builtin: 'bun' });
    assert.match(verifierAvailable(root, s), /no bun\.lock in this checkout/);

    // The pre-1.2 binary lockfile: it exists, and nothing here can read it.
    write(root, 'bun.lockb', '\u0000binary\u0000');
    assert.match(verifierAvailable(root, s), /bun\.lockb, the binary lockfile, which this verifier cannot read/);
    assert.equal(runBuiltinVerifier(root, s).ok, null);

    write(root, 'bun.lock', '{\n  "packages": {\n');
    const broken = runBuiltinVerifier(root, s);
    assert.equal(broken.ok, null);
    assert.match(broken.note, /unreadable bun\.lock/);
  });

  test('auto resolves bun from its own lockfile, and refuses when two are here', () => {
    const root = tmp('manual-bun-');
    write(root, 'bun.lock', BUN);
    assert.equal(resolveBuiltin(root, spec({ builtin: 'auto' })).name, 'bun');
    write(root, 'yarn.lock', '# yarn lockfile v1\n');
    const both = resolveBuiltin(root, spec({ builtin: 'auto' }));
    assert.equal(both.name, null);
    // Both ways round: the listing follows the registry's own order.
    assert.match(both.why, /cannot tell which ecosystem: yarn\.lock, bun\.lock are all here/);
    assert.match(both.why, /name one in verify: \{ builtin: yarn \} or \{ builtin: bun \}/);
  });
});

describe('verifiers: venv', () => {
  const REQS = '# a comment\nFlask==3.0.0\nidna==3.7\nrequests>=2.31 ; python_version < "3.13"\n-e ./local-pkg\n';

  const makeVenvRepo = () => {
    const root = tmp('manual-venv-');
    write(root, 'requirements.txt', REQS);
    mkdir(root, '.venv/Lib/site-packages/Flask-3.0.0.dist-info');
    mkdir(root, '.venv/Lib/site-packages/idna-3.7.dist-info');
    mkdir(root, '.venv/Lib/site-packages/pip-25.0.1.dist-info');
    return root;
  };

  test('distributions compared against requirements, versions included', () => {
    const root = makeVenvRepo();
    const s = spec({ builtin: 'venv' }, { cache: ['.venv'] });
    const ok = runBuiltinVerifier(root, s);
    assert.equal(ok.ok, true);
    assert.match(ok.note, /2 distribution\(s\) present/);
    // A marker-dependent line and an editable path are reported as not checked
    // rather than guessed at: `python_version < "3.13"` is false on 3.14, so
    // checking it would call a correctly absent package missing.
    assert.match(ok.note, /2 declaration\(s\) not checked/);

    fs.rmSync(path.join(root, '.venv/Lib/site-packages/idna-3.7.dist-info'), { recursive: true });
    const missing = runBuiltinVerifier(root, s);
    assert.equal(missing.ok, false);
    assert.match(missing.note, /1\/2 distribution\(s\) missing, e\.g\. idna@3\.7/);

    mkdir(root, '.venv/Lib/site-packages/idna-9.9.dist-info');
    const stale = runBuiltinVerifier(root, s);
    assert.equal(stale.ok, false);
    assert.match(stale.note, /1 at a different version than requirements\.txt, e\.g\. idna@3\.7 \(installed 9\.9\)/);
  });

  test('both virtualenv layouts are read, wherever the cache points', () => {
    // Windows keeps site-packages in `Lib`, everywhere else in `lib/python3.x`.
    // The verifier finds either, so it does not need to know which platform
    // installed the tree.
    const posix = tmp('manual-venv-');
    write(posix, 'requirements.txt', 'six==1.16.0\n');
    mkdir(posix, '.venv/lib/python3.12/site-packages/six-1.16.0.dist-info');
    assert.equal(runBuiltinVerifier(posix, spec({ builtin: 'venv' }, { cache: ['.venv'] })).ok, true);

    // And a venv somewhere the cache did not name is still found by the option,
    // because a repo that keeps its environment elsewhere is not a repo whose
    // install cannot be checked.
    const named = tmp('manual-venv-');
    write(named, 'requirements.txt', 'six==1.16.0\n');
    mkdir(named, 'python-env/Lib/site-packages/six-1.16.0.dist-info');
    const s = spec({ builtin: 'venv', path: 'python-env' }, { cache: ['python-env'] });
    assert.equal(s.builtinOptions.path, 'python-env');
    assert.equal(runBuiltinVerifier(named, s).ok, true);
  });

  test('a venv that is not there is cannot-tell, not no', () => {
    const root = tmp('manual-venv-');
    write(root, 'requirements.txt', 'six==1.16.0\n');
    const s = spec({ builtin: 'venv' }, { cache: ['.venv'] });
    assert.match(verifierAvailable(root, s), /no virtualenv to inspect/);
    const v = runBuiltinVerifier(root, s);
    assert.equal(v.ok, null);
    // A system-wide pip install is machine state, not this checkout's tree: the
    // honest answer names what it looked for.
    assert.match(v.note, /looked for \.venv/);
  });

  test('poetry.lock: extras are skipped, main dependencies are checked', () => {
    const root = tmp('manual-venv-');
    write(
      root,
      'poetry.lock',
      '[[package]]\nname = "requests"\nversion = "2.31.0"\noptional = false\n\n[package.dependencies]\ncertifi = ">=2017.4.17"\n\n[[package]]\nname = "pytest"\nversion = "8.0.0"\noptional = true\n',
    );
    mkdir(root, '.venv/Lib/site-packages/requests-2.31.0.dist-info');
    const s = spec({ builtin: 'venv' }, { cache: ['.venv'] });
    const v = runBuiltinVerifier(root, s);
    assert.equal(v.ok, true, 'a package installed only with an extra is not missing');
    assert.match(v.note, /1 distribution\(s\) present, matching poetry\.lock/);
    assert.match(v.note, /1 declaration\(s\) not checked, e\.g\. pytest/);
  });

  test('Pipfile.lock: the default section is checked and develop is not', () => {
    const root = tmp('manual-venv-');
    write(
      root,
      'Pipfile.lock',
      JSON.stringify({ default: { flask: { version: '==3.0.0' } }, develop: { pytest: { version: '==8.0.0' } } }),
    );
    mkdir(root, '.venv/Lib/site-packages/flask-3.0.0.dist-info');
    const s = spec({ builtin: 'venv' }, { cache: ['.venv'] });
    const v = runBuiltinVerifier(root, s);
    assert.equal(v.ok, true);
    assert.match(v.note, /1 declaration\(s\) not checked, e\.g\. the develop section/);
  });

  test('uv.lock reports a gap instead of judging it', () => {
    // uv.lock does not mark which package belongs to a dev group, so a package
    // that is not installed may simply never have been asked for. This is the
    // decision that keeps a repo out of a reinstall loop.
    const root = tmp('manual-venv-');
    write(root, 'uv.lock', 'version = 1\n\n[[package]]\nname = "flask"\nversion = "3.0.0"\n\n[[package]]\nname = "ruff"\nversion = "0.9.0"\n');
    mkdir(root, '.venv/Lib/site-packages/flask-3.0.0.dist-info');
    const s = spec({ builtin: 'venv' }, { cache: ['.venv'] });
    const v = runBuiltinVerifier(root, s);
    assert.equal(v.ok, null);
    assert.match(v.note, /1\/2 distribution\(s\) missing, e\.g\. ruff@0\.9\.0/);
    assert.match(v.note, /not a verdict: uv\.lock does not mark which packages a dev-only group needs/);
  });

  test('a subset install is reported, not judged', () => {
    const root = makeVenvRepo();
    fs.rmSync(path.join(root, '.venv/Lib/site-packages/Flask-3.0.0.dist-info'), { recursive: true });
    // `pip install --no-dev`-shaped commands install a subset of the lockfile,
    // and there a missing package is a fact about the command.
    const s = normalizeSetup({ setup: { run: 'uv sync --no-dev', evidence: ['requirements.txt'], cache: ['.venv'], verify: { builtin: 'venv' } } });
    const v = runBuiltinVerifier(root, s);
    assert.equal(v.ok, null);
    assert.match(v.note, /not a verdict: .*installs a subset of requirements\.txt/);
  });
});

describe('verifiers: gems', () => {
  const LOCK = 'GEM\n  remote: https://rubygems.org/\n  specs:\n    concurrent-ruby (1.3.5)\n    i18n (1.14.7)\n      concurrent-ruby (~> 1.0)\n    rake (13.2.1)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  i18n\n  rake\n\nBUNDLED WITH\n   2.6.9\n';

  const makeGemRepo = (bundlePath = 'vendor/bundle') => {
    const root = tmp('manual-gems-');
    write(root, 'Gemfile.lock', LOCK);
    for (const gem of ['concurrent-ruby-1.3.5', 'i18n-1.14.7', 'rake-13.2.1']) {
      write(root, path.join(bundlePath, 'ruby', '3.4.0', 'specifications', `${gem}.gemspec`), '');
    }
    return root;
  };

  test('the vendored specifications are compared against the GEM section', () => {
    const root = makeGemRepo();
    const s = spec({ builtin: 'gems' }, { cache: ['vendor/bundle'] });
    const ok = runBuiltinVerifier(root, s);
    assert.equal(ok.ok, true);
    assert.match(ok.note, /3 gem\(s\) present, matching Gemfile\.lock/);

    fs.rmSync(path.join(root, 'vendor/bundle/ruby/3.4.0/specifications/rake-13.2.1.gemspec'));
    const v = runBuiltinVerifier(root, s);
    assert.equal(v.ok, false);
    assert.match(v.note, /1\/3 gem\(s\) missing, e\.g\. rake@13\.2\.1/);
  });

  test('BUNDLE_PATH is honoured, and a tree that is not vendored is cannot-tell', () => {
    const root = tmp('manual-gems-');
    write(root, 'Gemfile.lock', LOCK);
    write(root, '.bundle/config', '---\nBUNDLE_PATH: "gems"\n');
    write(root, 'gems/ruby/3.4.0/specifications/rake-13.2.1.gemspec', '');
    const s = spec({ builtin: 'gems' }, { cache: ['gems'] });
    const v = runBuiltinVerifier(root, s);
    assert.equal(v.ok, false, 'the tree it finds is the one it judges');
    assert.match(v.note, /2\/3 gem\(s\) missing/);

    // Nothing vendored: gems installed into the system gem home are shared
    // machine state, and saying so is better than guessing.
    const plain = tmp('manual-gems-');
    write(plain, 'Gemfile.lock', LOCK);
    const none = runBuiltinVerifier(plain, spec({ builtin: 'gems' }));
    assert.equal(none.ok, null);
    assert.match(none.note, /no vendored bundle to inspect/);
  });

  test('a subset install is reported, not judged', () => {
    const root = makeGemRepo();
    fs.rmSync(path.join(root, 'vendor/bundle/ruby/3.4.0/specifications/rake-13.2.1.gemspec'));
    const s = normalizeSetup({ setup: { run: 'bundle install --without test', evidence: ['Gemfile.lock'], cache: ['vendor/bundle'], verify: { builtin: 'gems' } } });
    const v = runBuiltinVerifier(root, s);
    assert.equal(v.ok, null);
    assert.match(v.note, /installs a subset of Gemfile\.lock/);
  });
});

describe('verifiers: gomod', () => {
  const GO_MOD = 'module example.com/demo\n\ngo 1.23\n\nrequire (\n\tgithub.com/BurntSushi/toml v1.5.0\n\tgithub.com/stretchr/testify v1.10.0 // indirect\n\texample.com/legacy v0.0.0\n)\n\nrequire golang.org/x/sys v0.30.0 // indirect\n\nreplace example.com/legacy => ./third_party/legacy\n';

  // The escaped cache layout a real GOMODCACHE has.
  const makeCacheRepo = () => {
    const root = tmp('manual-go-');
    const cache = path.join(root, 'gomodcache');
    write(root, 'go.mod', GO_MOD);
    mkdir(root, 'third_party/legacy');
    write(cache, 'cache/download/github.com/!burnt!sushi/toml/@v/v1.5.0.ziphash', 'h1:abc\n');
    write(cache, 'cache/download/github.com/stretchr/testify/@v/v1.10.0.mod', 'module github.com/stretchr/testify\n');
    write(cache, 'cache/download/golang.org/x/sys/@v/v0.30.0.mod', 'module golang.org/x/sys\n');
    return { root, cache };
  };

  test('required modules are checked against the module cache, by escaping', () => {
    const { root, cache } = makeCacheRepo();
    const v = withEnv({ GOMODCACHE: cache }, () => runBuiltinVerifier(root, spec({ builtin: 'gomod' })));
    assert.equal(v.ok, true);
    // Four requires: a direct module, two indirect ones (checked for their
    // go.mod, which is what a pruned build loads) and a locally replaced one.
    assert.match(v.note, /4 required module\(s\) present, matching go\.mod/);

    // The zip is what a direct dependency needs for a build; losing it while the
    // graph's `.mod` files survive is exactly the state a marker cannot see.
    fs.rmSync(path.join(cache, 'cache/download/github.com/!burnt!sushi/toml/@v/v1.5.0.ziphash'));
    const broken = withEnv({ GOMODCACHE: cache }, () => runBuiltinVerifier(root, spec({ builtin: 'gomod' })));
    assert.equal(broken.ok, false);
    assert.match(broken.note, /1\/2 required module\(s\) not in the module cache, e\.g\. github\.com\/BurntSushi\/toml@v1\.5\.0/);
    // A module only in the graph needs its go.mod, not its source.
    assert.doesNotMatch(broken.note, /testify/);
  });

  test('an extracted module counts even without the download marker', () => {
    const { root, cache } = makeCacheRepo();
    fs.rmSync(path.join(cache, 'cache/download/github.com/!burnt!sushi/toml/@v/v1.5.0.ziphash'));
    mkdir(cache, 'github.com/!burnt!sushi/toml@v1.5.0');
    assert.equal(withEnv({ GOMODCACHE: cache }, () => runBuiltinVerifier(root, spec({ builtin: 'gomod' }))).ok, true);
  });

  test('a local replacement is checked where it points, and no cache is cannot-tell', () => {
    const { root, cache } = makeCacheRepo();
    fs.rmSync(path.join(root, 'third_party/legacy'), { recursive: true });
    const v = withEnv({ GOMODCACHE: cache }, () => runBuiltinVerifier(root, spec({ builtin: 'gomod' })));
    assert.equal(v.ok, false);
    assert.match(v.note, /example\.com\/legacy \(replace → \.\/third_party\/legacy, which is not there\)/);

    // And with no cache to compare against there is nothing to say but "cannot
    // tell", rather than calling every module missing. Every location the
    // verifier would look at — GOMODCACHE, GOPATH, the home directory — is
    // pointed at paths that do not exist, so the answer does not depend on
    // whether the machine running these tests happens to have a Go cache.
    const bare = tmp('manual-go-');
    write(bare, 'go.mod', GO_MOD);
    const nowhere = path.join(bare, 'no-such-cache');
    const none = withEnv({ GOMODCACHE: nowhere, GOPATH: nowhere, HOME: nowhere, USERPROFILE: nowhere }, () =>
      runBuiltinVerifier(bare, spec({ builtin: 'gomod' })),
    );
    assert.equal(none.ok, null);
    assert.match(none.note, /no Go module cache found/);
  });

  test('a vendored build is checked against modules.txt instead', () => {
    const root = tmp('manual-go-');
    write(root, 'go.mod', 'module example.com/demo\n\ngo 1.23\n\nrequire github.com/BurntSushi/toml v1.5.0\n');
    write(root, 'vendor/modules.txt', '# github.com/BurntSushi/toml v1.5.0\n## explicit; go 1.18\n');
    mkdir(root, 'vendor/github.com/!burnt!sushi/toml');
    const v = runBuiltinVerifier(root, spec({ builtin: 'gomod' }));
    assert.equal(v.ok, true);
    assert.match(v.note, /matching vendor\/modules\.txt/);

    write(root, 'vendor/modules.txt', '# golang.org/x/sys v0.30.0\n');
    const missing = runBuiltinVerifier(root, spec({ builtin: 'gomod' }));
    assert.equal(missing.ok, false);
    assert.match(missing.note, /not in vendor\/modules\.txt, e\.g\. github\.com\/BurntSushi\/toml@v1\.5\.0/);
  });

  test('the module cache can be declared outright', () => {
    const { root, cache } = makeCacheRepo();
    const nowhere = path.join(root, 'no-such-cache');
    const v = withEnv({ GOMODCACHE: nowhere, GOPATH: nowhere }, () => runBuiltinVerifier(root, spec({ builtin: 'gomod', modcache: cache })));
    assert.equal(v.ok, true);
    // The declared cache is the one it read: everything else it would have
    // looked at is under a path that does not exist.
    assert.match(v.note, /matching go\.mod \(cache: .*gomodcache\)/);
  });
});

describe('verifiers: crates', () => {
  const CARGO_LOCK = 'version = 4\n\n[[package]]\nname = "demo"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.228"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "9a8e"\n\n[[package]]\nname = "itoa"\nversion = "1.0.15"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';

  const makeCargoRepo = () => {
    const root = tmp('manual-cargo-');
    const home = path.join(root, 'cargo-home');
    write(root, 'Cargo.lock', CARGO_LOCK);
    mkdir(home, 'registry/src/index.crates.io-1949cf8c6b5b557f/serde-1.0.228');
    mkdir(home, 'registry/src/index.crates.io-1949cf8c6b5b557f/itoa-1.0.15');
    return { root, home };
  };

  test('the registry sources are compared against Cargo.lock', () => {
    const { root, home } = makeCargoRepo();
    const v = withEnv({ CARGO_HOME: home }, () => runBuiltinVerifier(root, spec({ builtin: 'crates' })));
    assert.equal(v.ok, true);
    // The workspace member has no `source`: it is on disk, not in the registry.
    assert.match(v.note, /2 crate\(s\) present, matching Cargo\.lock/);

    fs.rmSync(path.join(home, 'registry/src/index.crates.io-1949cf8c6b5b557f/itoa-1.0.15'), { recursive: true });
    const gone = withEnv({ CARGO_HOME: home }, () => runBuiltinVerifier(root, spec({ builtin: 'crates' })));
    // Reported, not judged: Cargo.lock also covers dev-dependencies and
    // target-specific crates, which a plain build never fetches.
    assert.equal(gone.ok, null);
    assert.match(gone.note, /1\/2 crate\(s\) missing, e\.g\. itoa@1\.0\.15/);
    assert.match(gone.note, /not a verdict: Cargo\.lock also covers dev-dependencies/);
  });

  test('the downloaded archive counts as present, and a vendor tree wins', () => {
    const { root, home } = makeCargoRepo();
    fs.rmSync(path.join(home, 'registry/src/index.crates.io-1949cf8c6b5b557f/itoa-1.0.15'), { recursive: true });
    write(home, 'registry/cache/index.crates.io-1949cf8c6b5b557f/itoa-1.0.15.crate', '');
    assert.equal(withEnv({ CARGO_HOME: home }, () => runBuiltinVerifier(root, spec({ builtin: 'crates' }))).ok, true);

    const vendored = tmp('manual-cargo-');
    write(vendored, 'Cargo.lock', CARGO_LOCK);
    mkdir(vendored, 'vendor/serde-1.0.228');
    mkdir(vendored, 'vendor/itoa-1.0.15');
    const v = runBuiltinVerifier(vendored, spec({ builtin: 'crates' }));
    assert.equal(v.ok, true);
    assert.match(v.note, /matching Cargo\.lock/);
  });
});

describe('verifiers: the plan prints which verifier will answer', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, '..', 'bin', 'manual.js');

  test('setup --plan resolves auto against the setup’s evidence, and says why', () => {
    const root = tmp('manual-plan-');
    write(root, 'requirements.txt', 'six==1.16.0\n');
    mkdir(root, '.venv/Lib/site-packages/six-1.16.0.dist-info');
    write(
      root,
      '.manual/manual.yaml',
      'schema: manual/v1\nsetup:\n  python:\n    run: "node -e \\"process.exit(0)\\""\n    evidence: ["requirements.txt"]\n    cache: [".venv"]\n    verify:\n      builtin: auto\n',
    );
    write(
      root,
      '.manual/claims/tests.plan.md',
      '---\nschema: manual/v1\nid: tests.plan\nkind: command\nstatement: The plan resolves its verifier.\npriority: normal\napplies_to: ["**"]\nevidence:\n  files:\n    - "requirements.txt"\ncheck:\n  requires: [python]\n  run: "node -e \\"process.exit(0)\\""\n  expect:\n    exit: 0\n    max_ms: 60000\nverify: on_change\nprovenance:\n  author: agent:manual-cli\n  origin: observed\n  evidence: "test"\nlifecycle: accepted\n---\n\nThe plan resolves its verifier.\n',
    );
    // Warm the prerequisite so the plan reports a satisfied step rather than
    // exiting 1 (which is what makes it usable as a preflight).
    execFileSync(process.execPath, [cli, 'setup', '--root', root, '--force'], { encoding: 'utf8', timeout: 120000 });

    const plan = JSON.parse(execFileSync(process.execPath, [cli, 'setup', '--root', root, '--plan', '--json'], { encoding: 'utf8', timeout: 120000 }));
    assert.equal(plan.plan[0].verify_builtin, 'venv', '`auto` is a question; the plan prints the answer');
    assert.equal(plan.plan[0].verify_why, 'matched requirements.txt (declared evidence)');
    assert.equal(plan.plan[0].cached, true);

    const text = execFileSync(process.execPath, [cli, 'setup', '--root', root, '--plan'], { encoding: 'utf8', timeout: 120000 });
    assert.match(text, /builtin:auto → venv \(matched requirements\.txt \(declared evidence\)\)/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('verifiers: a cached install is verified through the setup lifecycle', () => {
  test('the venv verifier distrusts and repairs a tree the witness cannot see into', async () => {
    const root = tmp('manual-venv-life-');
    const counter = path.join(root, 'installs.txt');
    write(root, 'requirements.txt', 'six==1.16.0\n');
    write(
      root,
      'fake-install.js',
      "const fs = require('node:fs');\n" +
        "fs.mkdirSync('.venv/Lib/site-packages/six-1.16.0.dist-info', { recursive: true });\n" +
        `fs.appendFileSync(${JSON.stringify(counter)}, 'install\\n');\n`,
    );
    const s = normalizeSetup({
      setup: { run: 'node fake-install.js', evidence: ['requirements.txt'], cache: ['.venv'], verify: { builtin: 'venv' } },
    });
    const installs = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').length : 0);

    resetSetupMemo();
    assert.equal((await ensureSetup(root, s, { quiet: true })).status, 'ran');
    resetSetupMemo();
    const reused = await ensureSetup(root, s, { quiet: true });
    assert.equal(reused.status, 'cached');
    assert.equal(reused.verify.builtin, 'venv', 'the result says which verifier answered');
    assert.match(reused.verify.note, /1 distribution\(s\) present/);
    assert.equal(installs(), 1);

    // A distribution vanishes from inside site-packages: `.venv` itself is
    // untouched, so the witness sees nothing and only the verifier can tell.
    fs.rmSync(path.join(root, '.venv/Lib/site-packages/six-1.16.0.dist-info'), { recursive: true });
    resetSetupMemo();
    let distrusted = null;
    const repaired = await ensureSetup(root, s, {
      quiet: true,
      onRun: () => {
        distrusted = readSetupCache(root).entries[setupKey(root, s)].invalidated;
      },
    });
    assert.equal(repaired.status, 'ran');
    assert.equal(installs(), 2);
    assert.equal(distrusted.by, 'verify', 'the verifier is what noticed, and the cache says so');
    assert.match(distrusted.note, /missing/);
  });
});
