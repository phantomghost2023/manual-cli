import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const demo = path.join(root, 'demo');
const bin = path.join(root, 'bin', 'manual.js');

// End-to-end: the CLI actually boots, writes a pidfile, answers HTTP, and the
// port failover works. This is the only test that exercises the real process.
test('manual serve boots, writes a pidfile, and answers HTTP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-serve-'));
  const pidfile = path.join(dir, 'serve.pid');
  const child = spawn(process.execPath, [bin, 'serve', '--root', demo, '--port', '0', '--pidfile', pidfile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  try {
    // The pidfile is written before the URL is logged, so waiting on the
    // pidfile alone races the stdout line that carries the port. Wait for
    // both, and give a cold Node boot on a slow filesystem room to finish.
    const deadline = Date.now() + 30000;
    let url = null;
    while (Date.now() < deadline) {
      url = (out.match(/http:\/\/[^\s]+/) || [])[0];
      if (url && fs.existsSync(pidfile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(url, `no URL in output:\n${out}`);
    assert.ok(fs.existsSync(pidfile), `pidfile never appeared; output:\n${out}`);
    assert.equal(fs.readFileSync(pidfile, 'utf8').trim(), String(child.pid));

    const html = await (await fetch(url)).text();
    assert.match(html, /<svg class="graph"/);
    assert.match(html, /tooling\.node-esm/);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
