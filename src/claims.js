import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter, splitSections } from './md.js';
import { parseYaml } from './yaml.js';

export const KINDS = new Set(['fact', 'command', 'trap', 'policy', 'ownership']);
const CHECK_SHAPES = new Set(['run', 'expr', 'enforce']);
export const TIERS = ['gold', 'silver', 'bronze', 'ghost'];

export class ClaimError extends Error {
  constructor(file, msg) {
    super(`${path.basename(file)}: ${msg}`);
  }
}

function need(fm, file, fields) {
  for (const f of fields) {
    if (fm[f] === undefined || fm[f] === null || fm[f] === '') {
      throw new ClaimError(file, `missing required field: ${f}`);
    }
  }
}

export function parseClaim(text, file) {
  const { fm: fmRaw, body } = splitFrontmatter(text);
  if (!fmRaw) throw new ClaimError(file, 'missing YAML frontmatter (--- ... ---)');
  const fm = parseYaml(fmRaw);

  need(fm, file, ['schema', 'id', 'kind', 'statement']);
  if (fm.schema !== 'manual/v1') {
    throw new ClaimError(file, `unsupported schema ${fm.schema}`);
  }
  if (!KINDS.has(fm.kind)) {
    throw new ClaimError(file, `unknown kind "${fm.kind}" (kinds change state semantics; allowed: ${[...KINDS].join(', ')})`);
  }
  const idOk = /^[a-z0-9][a-z0-9.-]*$/.test(fm.id);
  if (!idOk) throw new ClaimError(file, `bad id "${fm.id}" (lowercase, dots/dashes only)`);

  const base = path.basename(file);
  if (base !== `${fm.id}.md`) {
    throw new ClaimError(file, `filename must be <id>.md (expected ${fm.id}.md)`);
  }

  const check = fm.check ?? {};
  const shapes = Object.keys(check).filter((k) => CHECK_SHAPES.has(k));
  if (shapes.length === 0 && fm.kind !== 'ownership') {
    throw new ClaimError(file, 'claim needs a check (run | expr | enforce)');
  }
  if (fm.kind === 'policy' && !check.enforce && !fm.enforce) {
    throw new ClaimError(file, 'policy claims must define enforce { stage, paths, severity } (in check or at top level)');
  }

  const { intro, sections } = splitSections(body);
  if (!intro || intro.length < 8) {
    throw new ClaimError(file, 'prose body must start with a paragraph restating the statement');
  }

  return {
    file,
    fm,
    body: body.trim(),
    intro,
    gotchas: sections.get('gotchas') || null,
    check,
  };
}

export function loadManual(root) {
  const dir = path.join(root, '.manual', 'claims');
  if (!fs.existsSync(dir)) {
    throw new Error(`no .manual/claims/ directory under ${root} — nothing to verify`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) throw new Error('.manual/claims/ contains no claim files');

  const claims = [];
  const errors = [];
  const seen = new Set();
  for (const f of files) {
    try {
      const c = parseClaim(fs.readFileSync(path.join(dir, f), 'utf8'), path.join(dir, f));
      if (seen.has(c.fm.id)) errors.push(`${f}: duplicate id ${c.fm.id}`);
      seen.add(c.fm.id);
      claims.push(c);
    } catch (e) {
      errors.push(e.message);
    }
  }
  // validate dependency edges exist
  for (const c of claims) {
    for (const d of c.fm.depends_on ?? []) {
      if (!d.id || !seen.has(d.id)) errors.push(`${path.basename(c.file)}: depends_on unknown claim "${d.id}"`);
    }
  }
  return { claims, errors };
}

export function loadConfig(root) {
  const p = path.join(root, '.manual', 'manual.yaml');
  const defaults = {
    brief: { budget_tokens: 2000 },
    verify: { default_timeout_s: 60, ci: { required: [], diff_base: 'origin/main' } },
  };
  if (!fs.existsSync(p)) return defaults;
  const cfg = parseYaml(fs.readFileSync(p, 'utf8'));
  return {
    brief: { ...defaults.brief, ...(cfg.brief || {}) },
    verify: {
      ...defaults.verify,
      ...cfg.verify,
      ci: { ...defaults.verify.ci, ...((cfg.verify || {}).ci || {}) },
    },
  };
}
