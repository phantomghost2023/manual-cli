import fs from 'node:fs';
import path from 'node:path';

// Hook installer: wires `manual enforce` into .git/hooks/pre-commit.
// Idempotent and removable — the generated block is delimited by a marker.

const MARKER = '# manual-cli:enforce (managed block — do not edit between markers)';
const MARKER_END = '# end manual-cli:enforce';

function block(binPath, root) {
  const bin = binPath.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/');
  return `\n${MARKER}\nnode "${bin}" enforce --root "${r}" || exit 1\n${MARKER_END}\n`;
}

export function installHook(root, { binPath }) {
  const hooksDir = path.join(root, '.git', 'hooks');
  if (!fs.existsSync(path.join(root, '.git'))) {
    throw new Error('not a git repository (no .git) — run git init first');
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');
  let content = '';
  if (fs.existsSync(hookPath)) content = fs.readFileSync(hookPath, 'utf8');
  if (content.includes(MARKER)) return { status: 'already-installed', hookPath };

  if (!content.trim()) content = '#!/bin/sh\n';
  content = content.replace(/\n*$/, '\n') + block(binPath, root);
  fs.writeFileSync(hookPath, content);
  try { fs.chmodSync(hookPath, 0o755); } catch { /* best-effort on Windows */ }
  return { status: 'installed', hookPath };
}

export function uninstallHook(root) {
  const hookPath = path.join(root, '.git', 'hooks', 'pre-commit');
  if (!fs.existsSync(hookPath)) return { status: 'absent', hookPath };
  const lines = fs.readFileSync(hookPath, 'utf8').split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.includes(MARKER)) { inBlock = true; continue; }
    if (inBlock && line.includes(MARKER_END)) { inBlock = false; continue; }
    if (!inBlock) out.push(line);
  }
  const cleaned = out.join('\n');
  // Drop the file entirely if only comments/shebang/blank lines remain.
  const hasCommands = cleaned
    .split('\n')
    .some((l) => l.trim() && !l.trim().startsWith('#'));
  if (!hasCommands) fs.rmSync(hookPath);
  else fs.writeFileSync(hookPath, cleaned);
  return { status: 'uninstalled', hookPath };
}

export function hookStatus(root) {
  const hookPath = path.join(root, '.git', 'hooks', 'pre-commit');
  if (!fs.existsSync(hookPath)) return { status: 'absent', hookPath };
  const content = fs.readFileSync(hookPath, 'utf8');
  return { status: content.includes(MARKER) ? 'installed' : 'present-other', hookPath };
}
