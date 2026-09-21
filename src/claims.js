import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter, splitSections } from './md.js';
import { parseYaml } from './yaml.js';
import { normalizeSetup, normalizeSetupMap, prereqOrder, requiredNames } from './setup.js';

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

  // check.requires names a prerequisite declared once in .manual/manual.yaml;
  // checking the names exist needs the config, so it happens in loadManual.
  if (check.requires !== undefined && check.requires !== null) {
    const names = Array.isArray(check.requires) ? check.requires : [check.requires];
    if (names.length === 0 || names.some((n) => typeof n !== 'string' || !n.trim())) {
      throw new ClaimError(file, 'check.requires must be a prerequisite name or a list of names');
    }
    if (!check.run) {
      throw new ClaimError(file, 'check.requires only applies to command claims (needs check.run)');
    }
  }

  // check.setup declares the prerequisite an install/build must satisfy before
  // `run` can mean anything. It is meaningless without a command to gate.
  let setup = null;
  if (check.setup !== undefined && check.setup !== null) {
    setup = normalizeSetup(check);
    if (!setup || !setup.run || setup.run === 'undefined') {
      throw new ClaimError(file, 'check.setup needs a command: either `setup: npm ci` or `setup: { run: npm ci }`');
    }
    if (!check.run) {
      throw new ClaimError(file, 'check.setup only applies to command claims (needs check.run); expr checks have no dependencies to install');
    }
    if (typeof check.setup === 'object') {
      if (check.setup.evidence !== undefined && !Array.isArray(check.setup.evidence)) {
        throw new ClaimError(file, 'check.setup.evidence must be a list of files/globs');
      }
      if (check.setup.cache !== undefined && !Array.isArray(check.setup.cache)) {
        throw new ClaimError(file, 'check.setup.cache must be a list of directories the setup creates');
      }
      if (check.setup.timeout_s !== undefined && !(Number(check.setup.timeout_s) > 0)) {
        throw new ClaimError(file, 'check.setup.timeout_s must be a positive number of seconds');
      }
    }
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
    setup,
  };
}

// Process-level parse cache keyed by absolute path and validated by
// statSync(mtimeMs, size). Repeated loadManual calls in one process (watch
// mode, brief+verify flows, benchmarks) skip re-reading unchanged files —
// on some systems (AV-per-open overhead) the read dominates cold load time.
const parseCache = new Map();

function parseClaimCached(file) {
  let st;
  try { st = fs.statSync(file); } catch { parseCache.delete(file); return parseClaim(fs.readFileSync(file, 'utf8'), file); }
  const hit = parseCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    if (hit.err) throw hit.err;
    return hit.parsed;
  }
  try {
    const parsed = parseClaim(fs.readFileSync(file, 'utf8'), file);
    parseCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
    return parsed;
  } catch (e) {
    parseCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, err: e });
    throw e;
  }
}

export function loadManual(root) {
  const dir = path.join(root, '.manual', 'claims');
  if (!fs.existsSync(dir)) {
    throw new Error(`no .manual/claims/ directory under ${root} — nothing to verify`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  // An empty claims directory is a *state*, not an error: a repo that has just
  // run `init` and not yet accepted anything is in exactly that state, and
  // every read-only command used to die on it (found on a real repo, right
  // after reverting the only claim). Callers decide what to say about it.
  if (files.length === 0) {
    const empty = loadConfig(root);
    return { claims: [], errors: [...(empty.setupErrors || [])], empty: true, config: empty };
  }

  const claims = [];
  const errors = [];
  const seen = new Set();
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const c = parseClaimCached(full);
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
  // validate prerequisite references. A named prerequisite that does not exist
  // would otherwise be silently skipped, and the claim would run unprepared and
  // report its check's failure as truth.
  const config = loadConfigCached(root);
  errors.push(...(config.setupErrors || []));
  for (const c of claims) {
    for (const name of requiredNames(c)) {
      if (!config.setup[name]) {
        const known = Object.keys(config.setup);
        errors.push(
          `${path.basename(c.file)}: requires unknown prerequisite "${name}"` +
            (known.length ? ` (declared in .manual/manual.yaml: ${known.join(', ')})` : ' (nothing is declared in .manual/manual.yaml)'),
        );
      }
    }
  }
  return { claims, errors, config };
}

export function loadConfig(root) {
  const p = path.join(root, '.manual', 'manual.yaml');
  const defaults = {
    brief: { budget_tokens: 2000 },
    verify: { default_timeout_s: 60, ci: { required: [], diff_base: 'origin/main' } },
    setup: {},
  };
  if (!fs.existsSync(p)) return { ...defaults, setupErrors: [] };
  let cfg = {};
  const setupErrors = [];
  try {
    cfg = parseYaml(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // A broken config must not take the whole manual down with it: the errors
    // travel with the config so verify and doctor can print them.
    return { ...defaults, setupErrors: [`manual.yaml: ${e.message}`] };
  }
  const { specs, errors } = normalizeSetupMap(cfg.setup);
  setupErrors.push(...errors);
  // The prerequisite graph is validated even when no claim references it: a
  // cycle or a dangling edge is a property of the declaration, and it would
  // otherwise surface as a confusing blocked claim much later.
  const graph = prereqOrder({ setup: specs });
  for (const u of graph.unknown) {
    setupErrors.push(`manual.yaml: prerequisite "${u.required_by}" requires "${u.name}", which is not declared`);
  }
  for (const c of graph.cycles) {
    setupErrors.push(`manual.yaml: prerequisite cycle ${c.join(' → ')} — no order satisfies it`);
  }
  return {
    brief: { ...defaults.brief, ...(cfg.brief || {}) },
    verify: {
      ...defaults.verify,
      ...cfg.verify,
      ci: { ...defaults.verify.ci, ...((cfg.verify || {}).ci || {}) },
    },
    setup: specs,
    setupOrder: graph.order,
    setupErrors,
  };
}

// Same object per root unless the file changed (statSync mtime+size). `verify`
// loads it once, but a per-claim runCheck in a 500-claim manual would otherwise
// re-read and re-parse it 500 times.
const configCache = new Map();

export function loadConfigCached(root) {
  const p = path.join(root, '.manual', 'manual.yaml');
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    configCache.delete(root);
    return loadConfig(root);
  }
  const hit = configCache.get(root);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.config;
  const config = loadConfig(root);
  configCache.set(root, { mtimeMs: st.mtimeMs, size: st.size, config });
  return config;
}
