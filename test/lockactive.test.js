import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { makeExprApi } from '../src/expr.js';

describe('lockActive', () => {
  test('detects recent owned branches, ignores stale ones and other handles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-lock-'));
    const g = (args, env = {}) =>
      execSync(`git ${args}`, {
        cwd: dir,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    g('init -q -b main');
    g('-c user.email=t@t -c user.name=t add -A');
    g('-c user.email=t@t -c user.name=t commit -qm init --allow-empty');
    // dana's in-flight branch: committed now
    g('checkout -q -b dana/drizzle-to-kysely');
    g('-c user.email=t@t -c user.name=t commit -qm wip --allow-empty');
    g('checkout -q main');
    // stale branch: committer date 2020
    g('checkout -q -b old/feature-thing');
    g('-c user.email=t@t -c user.name=t commit -qm stale --allow-empty', {
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    });
    g('checkout -q main');

    const api = makeExprApi(dir);
    assert.equal(api.lockActive('dana'), true); // recent dana/* branch
    assert.equal(api.lockActive('@dana'), true); // @ prefix tolerated
    assert.equal(api.lockActive('dana', { withinDays: 21 }), true);
    assert.equal(api.lockActive('nobody'), false); // no such handle
    assert.equal(api.lockActive('old', { withinDays: 21 }), false); // stale branch
    assert.equal(api.lockActive(''), false); // degenerate input
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
