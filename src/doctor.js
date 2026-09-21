import { loadManual } from './claims.js';
import { evidenceDigest } from './hash.js';
import { parseTtl } from './util.js';
import { staleProposals } from './observe.js';
import { setupStatus } from './setup.js';
import { c } from './color.js';

// Doctor: a health report for the manual itself. Recomputes digests, checks
// stamp ages against TTLs, flags suspects and never-verified claims.

export function doctor(root, state) {
  const { claims, errors } = loadManual(root);
  const rows = [];
  const digestCache = new Map();

  for (const cl of claims) {
    const id = cl.fm.id;
    const stamp = state.stamp(id);
    const d = evidenceDigest(root, cl.fm.evidence || {}, state.salt, digestCache);
    const row = { id, state: 'unverified', tier: stamp?.tier || null, issues: [] };

    // A declared prerequisite is part of the claim's health: if it isn't
    // satisfied here, the next verify can only say "blocked", and the human
    // reading this report is the one who can install it.
    if (cl.setup) {
      const su = setupStatus(root, cl.setup);
      row.setup = { run: su.run, cached: su.cached, missing: su.missing, last: su.entry?.at || null };
      if (stamp?.state === 'blocked' && stamp.setup) {
        row.issues.push(`prerequisite not satisfied: ${su.run} — untested, not false (fix with \`manual setup --force\`)`);
      } else if (!su.cached && !stamp) {
        row.issues.push(`declares a prerequisite (${su.run}) that has not been satisfied here yet`);
      }
    }

    if (!stamp) {
      row.issues.push('never verified — run `manual verify`');
    } else {
      row.state = stamp.state;
      if (stamp.digest !== d.digest) row.issues.push('evidence changed since last verify (stale-suspect)');
      const ttl = parseTtl(cl.fm.ttl);
      if (ttl && stamp.verified_at) {
        const age = Date.now() - Date.parse(stamp.verified_at);
        if (age > ttl) row.issues.push(`TTL ${cl.fm.ttl} expired ${Math.round((age - ttl) / 86400e3)}d ago`);
      }
      if (stamp.state === 'broken') row.issues.push(`broken: ${stamp.note}`);
    }
    if (cl.fm.verify === 'on_demand' && !stamp) row.issues.push('on_demand claim — verify explicitly');
    rows.push(row);
  }

  const suspect = rows.filter((r) => r.issues.length > 0);
  const healthy = rows.length - suspect.length;
  // state is optional here: stale-candidate analysis needs history and stamps,
  // and a caller without one simply has no proposals to compare against.
  const stale = state ? staleProposals(root, state) : [];
  return { rows, suspect, healthy, errors, staleCandidates: stale };
}

export function printDoctor(res) {
  for (const r of res.rows) {
    if (r.issues.length === 0) {
      console.log(`${c.green('✔')} ${r.id.padEnd(36)} ${c.grey(`${r.state}${r.tier ? '/' + r.tier : ''}`)}`);
    } else {
      console.log(`${c.amber('▲')} ${r.id.padEnd(36)} ${r.state}`);
      for (const i of r.issues) console.log(c.amber(`    - ${i}`));
    }
    if (r.setup) {
      console.log(c.grey(`    ⚙ setup${r.setup.cached ? '' : ' (unsatisfied)'}: ${r.setup.run}${r.setup.missing.length ? ` — missing ${r.setup.missing.join(', ')}` : ''}`));
    }
  }
  for (const e of res.errors) console.log(c.red(`✖ load error: ${e}`));
  for (const s of res.staleCandidates || []) {
    console.log(c.amber(`▲ ${s.file} proposes max_ms ${s.proposes_in_file}, but the evidence now supports ${s.proposes_now}`));
  }
  const staleCount = (res.staleCandidates || []).length;
  const code = res.suspect.length || res.errors.length || staleCount ? 1 : 0;
  console.log(
    c.bold(`\n${res.healthy} healthy, ${res.suspect.length} need attention, ${staleCount} stale candidate(s), ${res.errors.length} load errors`),
  );
  return code;
}
