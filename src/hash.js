import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandFiles } from './glob.js';
import { spawnSync } from 'node:child_process';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const cut = (h) => 'sha256:' + h.slice(0, 32);

// Digest over every file matching the globs: sorted (path, size, content-hash).
export function filesDigest(root, patterns) {
  const files = expandFiles(root, patterns || []);
  const h = createHash('sha256');
  let bytes = 0;
  for (const f of files) {
    const abs = path.join(root, f);
    const st = statSync(abs);
    h.update(`${f}\0${st.size}\0${sha256(readFileSync(abs))}\n`);
    bytes += st.size;
  }
  return { digest: cut(h.digest('hex')), count: files.length, bytes };
}

// Env digest: presence + salted value hash. Values are never persisted.
export function envDigest(names, salt) {
  if (!names || names.length === 0) return null;
  const h = createHash('sha256');
  for (const n of names) {
    const v = process.env[n];
    h.update(`${n}=${v === undefined ? '<unset>' : sha256(String(salt) + String(v))}\n`);
  }
  return 'env:' + h.digest('hex').slice(0, 16);
}

function toolVersion(tool) {
  if (tool === 'node') return process.version;
  const r = spawnSync(tool, ['--version'], { encoding: 'utf8', timeout: 5000, shell: false });
  const line = (r.stdout || r.stderr || '').split(/\r?\n/)[0]?.trim();
  return r.status === 0 && line ? line : 'unavailable';
}

export function runtimeDigest(tools) {
  if (!tools || tools.length === 0) return null;
  const h = createHash('sha256');
  for (const t of tools) h.update(`${t}=${toolVersion(t)}\n`);
  return 'rt:' + h.digest('hex').slice(0, 16);
}

export function combine(...parts) {
  const h = createHash('sha256');
  for (const p of parts) if (p) h.update(String(p) + '\n');
  return cut(h.digest('hex'));
}

// Full evidence digest for one claim.
// `cache` (optional Map) dedupes identical evidence specs — repos commonly
// have many claims sharing the same globs, and each miss walks + hashes files.
export function evidenceDigest(root, evidence = {}, salt, cache = null) {
  const key = cache
    ? JSON.stringify([evidence.files || [], evidence.env || [], evidence.runtime || []])
    : null;
  if (cache && cache.has(key)) return cache.get(key);
  const f = filesDigest(root, evidence.files);
  const result = {
    digest: combine(f.digest, envDigest(evidence.env, salt), runtimeDigest(evidence.runtime)),
    files: f.count,
    bytes: f.bytes,
  };
  if (cache) cache.set(key, result);
  return result;
}
