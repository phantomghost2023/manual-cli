import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installHook, uninstallHook, hookStatus } from '../src/hooks.js';
import { promoteTier } from '../src/runner.js';
import { claimsAtRef, listManualCommits } from '../src/history.js';
import { brief } from '../src/brief.js';
import { serveMcp } from '../src/mcp.js';
import { State } from '../src/state.js';
import { PassThrough } from 'node:stream';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');

const tmp = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  fs.cpSync(ROOT, dir, { recursive: true });
  fs.rmSync(path.join(dir, '.manual', 'state.json'), { force: true });
  return dir;
};
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

function gitInit(dir) {
  execSync('git init -q', { cwd: dir });
  execSync('git -c user.email=t@t -c user.name=t add -A', { cwd: dir });
  execSync('git -c user.email=t@t -c user.name=t commit -qm init', { cwd: dir });
}

describe('hooks installer', () => {
  test('install, idempotent, status, uninstall round-trip', () => {
    const dir = tmp('manual-hook-');
    gitInit(dir);
    const bin = path.join(dir, 'does-not-exist', 'manual.js');
    let r = installHook(dir, { binPath: bin });
    assert.equal(r.status, 'installed');
    let content = fs.readFileSync(r.hookPath, 'utf8');
    assert.match(content, /manual-cli:enforce/);
    assert.match(content, /enforce --root/);

    r = installHook(dir, { binPath: bin });
    assert.equal(r.status, 'already-installed');
    content = fs.readFileSync(r.hookPath, 'utf8');
    // one managed block = one start marker (end marker says "end manual-cli:...")
    assert.equal(content.match(/# manual-cli:enforce \(managed block/g)?.length, 1);

    assert.equal(hookStatus(dir).status, 'installed');
    r = uninstallHook(dir);
    assert.equal(r.status, 'uninstalled');
    assert.equal(hookStatus(dir).status, 'absent');
    cleanup(dir);
  });

  test('preserves an existing user hook', () => {
    const dir = tmp('manual-hook2-');
    gitInit(dir);
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\nnpm lint-staged\n');
    installHook(dir, { binPath: 'x' });
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.match(content, /npm lint-staged/); // user content intact
    assert.match(content, /manual-cli:enforce/); // block appended
    cleanup(dir);
  });

  test('refuses to install outside a git repo', () => {
    const dir = tmp('manual-hook3-');
    assert.throws(() => installHook(dir, { binPath: 'x' }), /not a git repository/);
    cleanup(dir);
  });
});

describe('tier promotion', () => {
  test('bronze -> silver -> gold requires 2 machines', () => {
    assert.equal(promoteTier('ghost', 1, 1), 'bronze');
    assert.equal(promoteTier('bronze', 1, 1), 'silver');
    assert.equal(promoteTier('silver', 5, 1), 'silver'); // 1 machine: stuck
    assert.equal(promoteTier('silver', 5, 2), 'gold'); // 2 machines: gold
  });
});

describe('time travel', () => {
  test('brief --at reads the manual as of a past commit', () => {
    const dir = tmp('manual-tt-');
    gitInit(dir);
    // v1: only the ESM claim exists (delete the other three, commit as "v1")
    const claimsDir = path.join(dir, '.manual', 'claims');
    for (const f of ['tests.demo.md', 'traps.reporter-pipe.md', 'policy.tests-registered.md']) {
      fs.rmSync(path.join(claimsDir, f));
    }
    execSync('git -c user.email=t@t -c user.name=t add -A', { cwd: dir });
    execSync('git -c user.email=t@t -c user.name=t commit -qm v1-manual', { cwd: dir });
    const ref = listManualCommits(dir)[0]?.sha;
    assert.ok(ref, 'expected a manual commit');

    const { claims } = claimsAtRef(dir, ref);
    assert.deepEqual(claims.map((c) => c.fm.id), ['tooling.node-esm']);

    // brief @ ref shows only the historical claim
    const state = new State(dir);
    const out = brief(dir, ['src/anything.ts'], { state, budget: 400, at: ref, quiet: true });
    assert.match(out.lines.join('\n'), /tooling\.node-esm/);
    assert.doesNotMatch(out.lines.join('\n'), /tests\.demo/);
    assert.match(out.lines.join('\n'), /@/); // historical marker
    cleanup(dir);
  });

  test('claimsAtRef excludes retired claims', () => {
    const dir = tmp('manual-tt2-');
    gitInit(dir);
    fs.writeFileSync(
      path.join(dir, '.manual', 'claims', 'tooling.node-esm.md'),
      fs.readFileSync(path.join(dir, '.manual', 'claims', 'tooling.node-esm.md'), 'utf8').replace('lifecycle: accepted', 'lifecycle: retired'),
    );
    execSync('git -c user.email=t@t -c user.name=t add -A', { cwd: dir });
    execSync('git -c user.email=t@t -c user.name=t commit -qm retire', { cwd: dir });
    const ref = listManualCommits(dir)[0].sha;
    const { claims, retired } = claimsAtRef(dir, ref);
    // at that commit the other three claims are still accepted
    assert.deepEqual(claims.map((c) => c.fm.id).sort(), ['policy.tests-registered', 'tests.demo', 'traps.reporter-pipe']);
    assert.ok(retired.includes('tooling.node-esm'));
    cleanup(dir);
  });
});

describe('mcp server', () => {
  function rpc(root, messages) {
    const input = new PassThrough();
    const chunks = [];
    const output = new PassThrough();
    output.on('data', (c) => chunks.push(c.toString()));
    const done = serveMcp(root, { input, output });
    for (const m of messages) input.write(JSON.stringify(m) + '\n');
    input.end();
    return done.then(() => chunks.join(''));
  }

  test('initialize, tools/list, manual_brief over JSON-RPC', async () => {
    const dir = tmp('manual-mcp-');
    const out = await rpc(dir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'manual_brief', arguments: { files: ['src/db/queries.ts'] } } },
      { jsonrpc: '2.0', id: 4, method: 'no/such' },
    ]);
    const lines = out.split('\n').filter((l) => l.trim());
    const byId = Object.fromEntries(lines.map((l) => [JSON.parse(l).id, JSON.parse(l)]));
    assert.equal(byId[1].result.serverInfo.name, 'manual-cli');
    assert.ok(byId[2].result.tools.some((t) => t.name === 'manual_brief'));
    const briefText = byId[3].result.content[0].text;
    assert.match(briefText, /tooling\.node-esm/);
    assert.equal(byId[4].error.code, -32601);
    cleanup(dir);
  });

  test('manual_verify reports broken claims as tool error', async () => {
    const dir = tmp('manual-mcpv-');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.type = 'commonjs';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    const out = await rpc(dir, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'manual_verify', arguments: { force: true } } },
    ]);
    const msg = JSON.parse(out.split('\n').find((l) => l.includes('"result"') || l.includes('"error"')));
    assert.equal(msg.result.isError, true);
    assert.match(msg.result.content[0].text, /tooling\.node-esm: broken/);
    cleanup(dir);
  });
});
