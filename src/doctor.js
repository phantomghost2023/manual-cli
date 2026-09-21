import { loadManual } from './claims.js';
import { evidenceDigest } from './hash.js';
import { parseTtl } from './util.js';
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
  return { rows, suspect, healthy, errors };
}

export function printDoctor(res) {
  for (const r of res.rows) {
    if (r.issues.length === 0) {
      console.log(`${c.green('✔')} ${r.id.padEnd(36)} ${c.grey(`${r.state}${r.tier ? '/' + r.tier : ''}`)}`);
    } else {
      console.log(`${c.amber('▲')} ${r.id.padEnd(36)} ${r.state}`);
      for (const i of r.issues) console.log(c.amber(`    - ${i}`));
    }
  }
  for (const e of res.errors) console.log(c.red(`✖ load error: ${e}`));
  const code = res.suspect.length || res.errors.length ? 1 : 0;
  console.log(
    c.bold(`\n${res.healthy} healthy, ${res.suspect.length} need attention, ${res.errors.length} load errors`),
  );
  return code;
}
