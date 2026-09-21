import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Eject: copy this CLI into a repo at tools/manual-cli (excluding git state,
// the repo's own .manual, local state files, and the demo). After ejecting,
// CI workflows and hooks can call `node tools/manual-cli/bin/manual.js` with
// zero external setup.

const CLI_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(['.git', '.manual', 'node_modules', 'demo']);
const SKIP_FILES = new Set(['state.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    if (e.isFile() && SKIP_FILES.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

export function eject(root, { dryRun = false } = {}) {
  const dest = path.join(root, 'tools', 'manual-cli');
  const files = [];
  const collect = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      if (e.isFile() && SKIP_FILES.has(e.name)) continue;
      const relName = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) collect(path.join(dir, e.name), relName);
      else files.push(relName);
    }
  };
  collect(CLI_ROOT);

  if (!dryRun) {
    copyDir(CLI_ROOT, dest);
  }
  return { dest, files, count: files.length, dryRun };
}

export const VENDORED_CLI = path.join('tools', 'manual-cli', 'bin', 'manual.js');

export { CLI_ROOT };
