import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { State } from './state.js';
import { verify } from './verify.js';
import { buildReportData, renderReport } from './report.js';
import { graphToJson } from './graph.js';
import { c } from './color.js';

// `manual serve` — a local dashboard over the same artifact `manual report`
// writes. Loopback only, no auth, no dependencies. The HTML regenerates per
// request so it always reflects state.json as it is right now, and POST
// /api/verify lets the page re-run the checks in place.

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function json(res, code, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

export function createHandler(root, opts = {}) {
  const version = opts.version ?? readVersion();
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    if (route === '/' || route === '/index.html') {
      try {
        const data = buildReportData(root, { state: new State(root), version, served: true });
        const html = renderReport(data);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`manual serve: ${e.message}`);
      }
      return;
    }

    if (route === '/api/graph') {
      const data = buildReportData(root, { state: new State(root), skipDoctor: true });
      return json(res, 200, graphToJson(data.graph));
    }

    if (route === '/api/claims') {
      const data = buildReportData(root, { state: new State(root), skipDoctor: true });
      return json(res, 200, {
        root: data.root,
        claims: data.claims.map((cl) => ({
          id: cl.fm.id,
          kind: cl.fm.kind,
          statement: cl.fm.statement,
          priority: cl.fm.priority || 'normal',
          applies_to: cl.fm.applies_to || [],
          depends_on: (cl.fm.depends_on || []).map((d) => d.id),
          state: data.graph.nodes.get(cl.fm.id)?.state || 'unknown',
          tier: data.graph.nodes.get(cl.fm.id)?.tier || 'bronze',
          verified_at: data.graph.nodes.get(cl.fm.id)?.verified_at || null,
        })),
      });
    }

    if (route === '/api/verify' && (req.method === 'POST' || req.method === 'GET')) {
      try {
        const state = new State(root);
        const force = url.searchParams.get('force') === '1';
        const result = await verify(root, { state, force });
        state.save();
        return json(res, result.results.some((r) => r.stamp.state === 'broken') ? 409 : 200, {
          errors: result.errors,
          results: result.results.map((r) => ({
            id: r.claim.fm.id,
            state: r.stamp.state,
            tier: r.stamp.tier,
            note: r.stamp.note || null,
          })),
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    if (route === '/health') {
      return json(res, 200, { ok: true, root: path.resolve(root), version });
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };
}

export async function startServer(root, opts = {}) {
  const host = opts.host || '127.0.0.1';
  const basePort = Number(opts.port || 4242);
  const handler = createHandler(root, opts);

  // Port failover: a dev machine may already have something on the default
  // port (another thread's server, another repo's dashboard).
  let lastErr = null;
  for (let i = 0; i < 20; i++) {
    const port = basePort + i;
    const server = http.createServer(handler);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const actual = server.address().port; // port 0 lets the OS choose
      return {
        server,
        port: actual,
        host,
        url: `http://${host}:${actual}/`,
        close: () => new Promise((resolve) => server.close(resolve)),
      };
    } catch (e) {
      lastErr = e;
      server.close();
      if (e.code !== 'EADDRINUSE') break;
    }
  }
  throw new Error(`could not bind ${host}:${basePort}-${basePort + 19} (${lastErr?.code || lastErr?.message})`);
}

export async function serveCommand(root, opts = {}) {
  const s = await startServer(root, opts);
  // A pidfile lets editors, scripts, and agent sessions find (and stop) the
  // dashboard they started instead of guessing at ports and processes.
  const pidfile = opts.pidfile ? path.resolve(opts.pidfile) : null;
  if (pidfile) {
    fs.mkdirSync(path.dirname(pidfile), { recursive: true });
    fs.writeFileSync(pidfile, `${process.pid}\n`);
  }
  console.log(`${c.green('✔')} manual dashboard on ${c.bold(s.url)}`);
  console.log(c.grey(`  serving ${path.resolve(root)} — Ctrl+C to stop`));
  if (pidfile) console.log(c.grey(`  pid ${process.pid} written to ${pidfile}`));
  if (opts.open) {
    const { spawn } = await import('node:child_process');
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', s.url]]
      : process.platform === 'darwin' ? ['open', [s.url]]
        : ['xdg-open', [s.url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* best effort */ }
  }
  const stop = () => {
    if (pidfile) { try { fs.rmSync(pidfile); } catch { /* already gone */ } }
    s.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
  return s;
}
