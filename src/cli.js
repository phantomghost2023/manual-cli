import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { State } from './state.js';
import { verify, printVerifyReport } from './verify.js';
import { brief } from './brief.js';
import { listInbox, previewInbox, readInbox } from './inbox.js';
import { acceptAndVerify, undoAndVerify, revertFromJournal } from './flywheel.js';
import { readJournal } from './journal.js';
import { readLedger, allLedgerStats, machineName, GOLD_PASSES, GOLD_MACHINES } from './ledger.js';
import { enforce } from './enforce.js';
import { doctor, printDoctor } from './doctor.js';
import { init, probeCandidates } from './init.js';
import { writeProposals } from './observe.js';
import { installHook, uninstallHook, hookStatus } from './hooks.js';
import { eject } from './eject.js';
import { startWatch } from './watch.js';
import { buildGraph, graphToJson, toDot, toMermaid, printGraphSummary } from './graph.js';
import { writeReport } from './report.js';
import { serveCommand } from './serve.js';
import { loadManual } from './claims.js';
import { declaredPrereqs, ensureSetup, requiredNames, resolvePrereqs, setupKey, setupStatus } from './setup.js';
import { short } from './util.js';
import { buildTimeline, describeTimeline, fmtDuration, fmtWhen, sparkline } from './timeline.js';
import { diagnoseSeries, seriesEvents } from './observe.js';
import { c } from './color.js';

// A manual with no claims yet is the normal state right after `init`, and after
// reverting the last accepted claim. Say what is actually going on instead of
// printing a bare "0 claims".
function printEmptyManualHint(root) {
  let candidates = [];
  try {
    candidates = readInbox(root);
  } catch {
    candidates = [];
  }
  console.log(c.grey('\nno claims in .manual/claims/ yet'));
  if (candidates.length) {
    console.log(c.grey(`  ${candidates.length} candidate(s) waiting in the inbox — ` +
      `review with \`manual inbox list\`, accept with \`manual inbox accept <file>\``));
  } else {
    console.log(c.grey('  run `manual init` to discover your first candidates, or write one by hand'));
  }
}

function usage() {
  console.log(`manual — self-verifying repository operating manual (manual/v1)

Usage:
  manual verify [--root <dir>] [--force] [--diff [base]] [--only <ids>] [--no-setup]
                [--setup-force] [--json]   # prerequisites: see the setup command
  manual brief  [--root <dir>] [--budget N] [--json] [files...]
  manual enforce [--root <dir>] [--stage pre-commit|pr]
  manual setup  [--root <dir>] [--force] [--all] [--claim <id>] [--json]  # declared prerequisites
  manual observe [--root <dir>]          # flywheel: measurements -> inbox candidates
  manual doctor [--root <dir>]           # manual health report
  manual init   [--root <dir>] [--dry-run] [--no-probe]   # discover + scaffold .manual/
  manual inbox  [--root <dir>] [accept <file> | preview <file> | undo <token>]
  manual ledger [--root <dir>] [--json]                    # trust earned across machines
  manual journal [--root <dir>] [<id>] [--json]            # why the manual says what it says
  manual journal revert <id> [--force]                     # restore from a journal entry
  manual hooks  [--root <dir>] [install|uninstall|status]
  manual eject  [--root <dir>] [--dry-run]   # vendor the CLI into tools/manual-cli
  manual watch  [--root <dir>] [--debounce N]  # re-verify affected claims on change
  manual history [--root <dir>] [<claim-id>] [--json]      # transitions, runtimes, git history
  manual graph  [--root <dir>] [--dot|--mermaid|--json]   # dependency graph
  manual report [--root <dir>] [--out <file>] [--open]    # self-contained HTML report
  manual serve  [--root <dir>] [--port N] [--open] [--pidfile <f>]  # live dashboard over the report
  manual brief  --at <ref> [files...]     # manual as it was at a past ref

Verify runs each claim's check in a sandbox (git worktree when possible),
stamps state.json, and respects dependency edges, digests and TTLs.
--diff [base] verifies only claims relevant to changed files (plus policies
and their dependency closure). Brief emits a token-budgeted briefing for the
given files. Enforce compiles policy claims into pre-commit/PR gates.
Observe turns measurement drift into inbox candidates for human review.
A claim can declare check.setup ("npm ci", a build step): it runs once per
command+evidence pair, not per verify, and a claim whose setup did not complete
is reported blocked rather than broken. --no-setup trusts the environment.`);
}

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

export async function main(argv = []) {
  let root = process.cwd();
  const rootIdx = argv.indexOf('--root');
  if (rootIdx !== -1) {
    root = path.resolve(argv[rootIdx + 1]);
    argv.splice(rootIdx, 2);
  }

  const cmd = argv[0] || 'help';
  const rest = argv.slice(1);
  const json = rest.includes('--json');
  const force = rest.includes('--force');
  const dryRun = rest.includes('--dry-run');
  const budgetIdx = rest.indexOf('--budget');
  const stage = flag(rest, '--stage') || 'pre-commit';

  try {
    if (cmd === 'help' || rest.includes('-h') || rest.includes('--help')) {
      usage();
      return 0;
    }

    if (cmd === 'verify') {
      const state = new State(root);
      const diffArg = rest.includes('--diff')
        ? (flag(rest, '--diff') || true)
        : undefined;
      const only = rest.reduce((acc, a, i) => {
        if (a === '--only') acc.push(...String(rest[i + 1] || '').split(',').filter(Boolean));
        return acc;
      }, []);
      const res = await verify(root, {
        state,
        force,
        diff: diffArg,
        only,
        noSetup: rest.includes('--no-setup'),
        setupForce: rest.includes('--setup-force'),
      });
      // Persist before reporting, not after: the JSON branch used to return
      // early, so `verify --json` — the mode CI and agents actually use —
      // printed fresh states and then threw them away, leaving stamps, trust
      // history and the flywheel's evidence behind on disk.
      state.save();
      if (json) {
        console.log(JSON.stringify({
          errors: res.errors,
          results: res.results.map((r) => ({
            id: r.claim.fm.id,
            state: r.stamp.state,
            tier: r.stamp.tier,
            note: r.stamp.note,
            measured_ms: r.stamp.measured_ms ?? null,
            // So CI can tell "the code is wrong" from "the environment isn't
            // ready" without parsing prose.
            setups: (r.result?.setups || r.stamp.setups || []).map((s) => ({
              name: s.name ?? null,
              run: s.run ?? null,
              status: s.status,
              ms: s.ms ?? null,
            })),
          })),
        }, null, 2));
        const code = res.errors.length
          ? 2
          : res.results.some((r) => r.stamp.state === 'broken' || r.result?.blocked)
            ? 1
            : 0;
        return code;
      }
      const code = printVerifyReport(res);
      if (res.results.length === 0) printEmptyManualHint(root);
      return code;
    }

    if (cmd === 'brief') {
      const state = new State(root);
      const files = rest.filter((a) => !a.startsWith('--') && a !== (flag(rest, '--budget') ?? NaN)).map((f) => path.relative(root, path.resolve(f)));
      const budget = budgetIdx !== -1 ? Number(rest[budgetIdx + 1]) : undefined;
      const out = brief(root, files, { state, budget, at: flag(rest, '--at') || null, quiet: json });
      if (json) console.log(JSON.stringify(out, null, 2));
      return 0;
    }

    if (cmd === 'hooks') {
      const sub = rest.find((a) => !a.startsWith('--')) || 'status';
      if (sub === 'install') {
        const binPath = path.resolve(fileURLToPath(new URL('../bin/manual.js', import.meta.url)));
        const r = installHook(root, { binPath });
        console.log(`${c.green('✔')} enforce gate ${r.status}: ${r.hookPath}`);
        return 0;
      }
      if (sub === 'uninstall') {
        const r = uninstallHook(root);
        console.log(`${c.grey('•')} enforce gate ${r.status}: ${r.hookPath}`);
        return 0;
      }
      const r = hookStatus(root);
      console.log(`${r.status}: ${r.hookPath}`);
      return 0;
    }

    if (cmd === 'enforce') {
      const state = new State(root);
      const { ran, failures, errors } = await enforce(root, state, { stage });
      state.save();
      for (const e of errors) console.error(c.red(`load error: ${e}`));
      if (json) {
        console.log(JSON.stringify({ ran, failures }, null, 2));
      } else {
        for (const f of failures) {
          console.error(c.red(`✖ ${f.id} (${f.severity}): ${f.note}`));
        }
        if (failures.length === 0) console.log(c.green(`✔ ${ran.length} policy gate(s) passed (${stage})`));
      }
      const blocking = failures.filter((f) => f.severity === 'block');
      return errors.length ? 2 : blocking.length ? 1 : 0;
    }

    if (cmd === 'observe') {
      const state = new State(root);
      const written = writeProposals(root, state, { quiet: json });
      if (json) console.log(JSON.stringify(written, null, 2));
      return 0;
    }

    if (cmd === 'doctor') {
      const state = new State(root);
      const res = doctor(root, state);
      if (json) console.log(JSON.stringify(res, null, 2));
      else return printDoctor(res);
      return res.suspect.length || res.errors.length ? 1 : 0;
    }

    if (cmd === 'init') {
      const res = init(root, { dryRun });
      if (!dryRun && !rest.includes('--no-probe')) {
        console.log(c.grey('\nprobing discovered candidates before proposing them…'));
        const probes = await probeCandidates(root, { setup: !rest.includes('--no-setup') });
        const bad = probes.filter((p) => p.state !== 'fresh');
        const fixed = probes.filter((p) => p.setup);
        if (fixed.length) {
          console.log(c.grey(`${fixed.length} candidate(s) needed a prerequisite first; the setup is declared in the file so verify can repeat it.`));
        }
        if (bad.length) {
          console.log(c.amber(`\n${bad.length} candidate(s) do not pass here — they are marked in the file; fix the command or install dependencies before accepting`));
        }
      }
      if (json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        if (res.existed) console.log(c.grey('.manual/ already exists — adding only what is missing'));
        console.log(res.dryRun
          ? `would create ${res.created.length} file(s), discovered ${res.findings} claim candidates`
          : `created ${res.created.length} file(s), discovered ${res.findings} claim candidates:`);
        for (const f of res.created) console.log(`  + ${f}`);
        if (res.declared.length) {
          const written = res.declared.filter((d) => !/\(not written/.test(d));
          const skipped = res.declared.filter((d) => /\(not written/.test(d));
          if (written.length) console.log(c.grey(`prerequisites declared in .manual/manual.yaml: ${written.join(', ')} (claims reference them by name)`));
          for (const s of skipped) console.log(c.amber(`prerequisite ${s} — add it by hand if you want the detected command`));
        }
        console.log(c.yellow('\nCandidates are in .manual/inbox/ — review, then `manual inbox accept <file>`.'));
      }
      return 0;
    }

    if (cmd === 'setup') {
      // Prerequisites are a property of the repository — declared once in
      // .manual/manual.yaml and referenced by name — but they are reported and
      // run per *distinct* command: twelve claims that need `npm ci` need it
      // once, and a claim with an inline step keeps it.
      const { claims, errors, config } = loadManual(root);
      for (const e of errors) console.error(c.red(`load error: ${e}`));
      const onlyClaim = flag(rest, '--claim');
      const groups = new Map();
      const note = (name, spec, claimId) => {
        const key = setupKey(root, spec);
        if (!groups.has(key)) groups.set(key, { name, spec, key, claims: [], declared: Boolean(name) });
        const g = groups.get(key);
        // A declared prerequisite keeps its name even when an inline step in a
        // claim happens to be identical: the name is what the failure reports.
        if (name && !g.name) g.name = name;
        if (claimId && !g.claims.includes(claimId)) g.claims.push(claimId);
        return g;
      };
      // Declared first, so an unreferenced install still shows up as a declared
      // fact about the repo rather than disappearing until someone uses it.
      for (const { name, spec } of declaredPrereqs(config)) note(name, spec, null);
      for (const cl of claims) {
        if (onlyClaim && cl.fm.id !== onlyClaim) continue;
        for (const { name, spec } of resolvePrereqs(cl, config).specs) note(name, spec, cl.fm.id);
      }
      const unknown = new Map();
      for (const cl of claims) {
        if (onlyClaim && cl.fm.id !== onlyClaim) continue;
        for (const name of requiredNames(cl)) if (!config.setup?.[name]) unknown.set(name, [...(unknown.get(name) || []), cl.fm.id]);
      }
      if (groups.size === 0 && unknown.size === 0) {
        if (json) console.log(JSON.stringify({ setups: [], unknown: [] }, null, 2));
        else console.log(c.grey(onlyClaim
          ? `claim ${onlyClaim} declares no prerequisite`
          : 'no prerequisites declared — add a setup: block to .manual/manual.yaml, or check.setup to a claim'));
        return onlyClaim ? 1 : 0;
      }
      const shouldRun = force || rest.includes('--run');
      // --force warms what claims need. A declared install no claim references
      // is a fact about the repo, not a request to run it: `--all` says so.
      const all = rest.includes('--all');
      const out = [];
      let failed = 0;
      for (const g of groups.values()) {
        const st = setupStatus(root, g.spec);
        const label = g.name ? `${g.name} → ${st.run}` : st.run;
        if (shouldRun && !all && g.claims.length === 0) {
          if (json) out.push({ name: g.name, run: st.run, key: st.key, claims: [], declared: true, skipped: true, cached: st.cached });
          else console.log(c.grey(`• ${label}  declared, no claim requires it — skipped (--all to run it)`));
          continue;
        }
        if (!shouldRun) {
          if (json) {
            out.push({ name: g.name, run: st.run, key: st.key, claims: g.claims, declared: g.declared, cached: st.cached, missing: st.missing, last: st.entry || null });
          } else {
            console.log(`${st.cached ? c.green('✔') : c.amber('▲')} ${label}  ${c.grey(g.claims.length ? g.claims.join(', ') : 'declared, unreferenced')}`);
            console.log(c.grey(`    ${st.key} · ${st.cached
              ? `cached — ran ${st.entry.at} (${st.entry.ms}ms)`
              : st.entry
                ? `last attempt failed: ${short(st.entry.note, 120)}`
                : 'not satisfied on this machine yet'}${st.missing.length ? ` · missing: ${st.missing.join(', ')}` : ''}`));
          }
          continue;
        }
        const r = await ensureSetup(root, g.spec, { force: true });
        out.push({ name: g.name, run: r.run, key: r.key, claims: g.claims, status: r.status, ms: r.ms ?? null, note: r.note || null });
        if (r.status === 'failed' || r.status === 'timeout') failed += 1;
        if (!json) {
          console.log(`${r.status === 'ran' || r.status === 'cached' ? c.green('✔') : c.red('✖')} ${label}  ${short(r.note || r.status, 120)}`);
        }
      }
      for (const [name, ids] of unknown) {
        failed += 1;
        if (json) out.push({ name, unknown: true, claims: ids });
        else console.log(c.red(`✖ ${name}  required by ${ids.join(', ')}, but nothing declares it in .manual/manual.yaml`));
      }
      if (json) console.log(JSON.stringify({ setups: out, unknown: [...unknown.keys()], ran: shouldRun }, null, 2));
      else if (!shouldRun) console.log(c.grey('\nrun them with `manual setup --force` (or let verify run what it needs)'));
      return failed ? 1 : 0;
    }

    if (cmd === 'watch') {
      const state = new State(root);
      const debounceMs = Number(flag(rest, '--debounce') || 400);
      const session = startWatch(root, { debounceMs });
      console.log(c.bold(`manual watch — ${path.basename(root)} (debounce ${debounceMs}ms)`));
      console.log(c.grey('  watching for changes; claims whose evidence matches are re-verified'));
      console.log(c.grey('  Ctrl+C to stop\n'));
      const stop = () => {
        session.stop();
        console.log(c.grey('\nwatch stopped'));
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await new Promise(() => {}); // run until signaled
      return 0;
    }

    if (cmd === 'eject') {
      const res = eject(root, { dryRun });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(res.dryRun
          ? `would copy ${res.count} file(s) to ${res.dest}`
          : `ejected ${res.count} file(s) to ${res.dest}`);
        if (!res.dryRun) {
          console.log(c.green('CI and hooks can now run fully self-contained:'));
          console.log(`  node ${'tools/manual-cli/bin/manual.js'} verify --diff HEAD~1`);
        }
      }
      return 0;
    }

    if (cmd === 'history') {
      const state = new State(root);
      const limit = Number(flag(rest, '--limit') || 20);
      const skip = new Set(['--limit', String(limit)]);
      const only = rest.find((a) => !a.startsWith('--') && !skip.has(a));
      let kinds = new Map();
      try {
        kinds = new Map(loadManual(root).claims.map((cl) => [cl.fm.id, cl.fm.kind]));
      } catch { /* claims may be unreadable: git history is still useful */ }
      const tl = buildTimeline(root, state, { claimIds: [...kinds.keys()] });

      const rows = [...tl.claims.values()]
        .filter((t) => !only || t.id === only)
        .sort((a, b) => (b.brokeCount - a.brokeCount)
          || ((b.stats?.p50 || 0) - (a.stats?.p50 || 0))
          || a.id.localeCompare(b.id));

      if (json) {
        console.log(JSON.stringify({
          summary: tl.summary,
          claims: rows.map((t) => ({
            id: t.id,
            last_state: t.lastState,
            breaks: t.brokeCount,
            transitions: t.transitions,
            stats: t.stats,
            recoveries: t.recoveries,
            series: t.series,
            git: t.files,
          })),
        }, null, 2));
        return 0;
      }

      if (only) {
        const t = rows[0];
        if (!t) {
          console.log(c.grey(`no history for "${only}" — never verified here and not in git`));
          return 1;
        }
        console.log(c.bold(`${t.id}  [${kinds.get(t.id) || 'unknown'}] ${t.lastState || 'unknown'}`));
        for (const line of describeTimeline(t)) console.log(`  ${line}`);
        if (t.series.length) console.log(`  trend (newest last): ${sparkline(t.series.map((s) => s.ms), limit)}`);
        const diagnosis = diagnoseSeries(seriesEvents(state, t.id, limit));
        if (diagnosis.length > 1 || diagnosis[0]?.kind !== 'stable') {
          console.log('  why the spread:');
          for (const d of diagnosis) console.log(`    ${d.kind}: ${d.text}`);
        }
        return t.lastState === 'broken' ? 1 : 0;
      }

      console.log(c.bold(`manual history — ${path.basename(root)}`));
      console.log(c.grey(`${tl.summary.claims} claims · ${tl.summary.events} verify events · ${tl.summary.transitions} transitions${tl.summary.meanTimeToRecoveryMs != null ? ` · mean time to recovery ${fmtDuration(tl.summary.meanTimeToRecoveryMs)}` : ''}${tl.summary.git ? '' : ' · no git history'}`));
      console.log('');
      if (rows.length === 0) {
        console.log(c.grey('nothing recorded yet — run `manual verify`'));
        return 0;
      }
      console.log(c.grey(`  ${'claim'.padEnd(30)} ${'last'.padEnd(9)} ${'breaks'.padEnd(7)} ${'p50'.padEnd(8)} trend`));
      for (const t of rows) {
        const last = t.lastState || 'unknown';
        const color = { fresh: c.green, broken: c.red, stale: c.amber, blocked: c.grey, unknown: c.grey }[last] || c.grey;
        const trend = t.series.length ? sparkline(t.series.map((s) => s.ms), limit) : '';
        console.log(
          `  ${t.id.padEnd(30)} ${color(last.padEnd(9))} ${String(t.brokeCount).padEnd(7)} ${fmtDuration(t.stats?.p50).padEnd(8)} ${c.grey(trend)}`,
        );
      }
      if (tl.summary.slowest.length) {
        console.log(c.grey(`\nslowest by p50: ${tl.summary.slowest.map((s) => `${s.id} ${fmtDuration(s.p50)} (n=${s.n})`).join(', ')}`));
      }
      console.log(c.grey('verification history is machine-local (state.json, capped at 500 events); git columns come from commit history'));
      return 0;
    }

    if (cmd === 'ledger') {
      const stats = allLedgerStats(root);
      const entries = readLedger(root);
      if (json) {
        console.log(JSON.stringify({ machine: machineName(), entries, trust: Object.fromEntries(stats) }, null, 2));
        return 0;
      }
      console.log(c.bold(`manual ledger — ${path.basename(root)}`));
      console.log(c.grey(`this machine: ${machineName()} · ${entries.length} recorded outcome(s)`));
      if (entries.length === 0) {
        console.log(c.grey('\nnothing recorded yet — trust is earned by verifying, and the ledger is written when a claim changes state, is first verified, or earns a new machine'));
        return 0;
      }
      console.log('');
      console.log(c.grey(`  ${'claim'.padEnd(28)} ${'passes'.padEnd(7)} ${'machines'.padEnd(9)} tier`));
      for (const [id, s] of [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        // Gold needs passes across distinct machines — the rule the ledger exists
        // to make satisfiable outside one checkout.
        const gold = s.passes >= GOLD_PASSES && s.machines.length >= GOLD_MACHINES;
        const tier = gold ? c.amber('gold') : s.passes >= 1 ? 'silver' : 'bronze';
        console.log(`  ${id.padEnd(28)} ${String(s.passes).padEnd(7)} ${String(s.machines.length).padEnd(9)} ${tier}`);
      }
      console.log(c.grey('\n  recent outcomes:'));
      for (const e of entries.slice(-8).reverse()) {
        const color = { fresh: c.green, broken: c.red, stale: c.amber, blocked: c.grey }[e.state] || c.grey;
        console.log(`  ${String(e.at).slice(0, 19)} ${String(e.machine).padEnd(16)} ${color(String(e.state).padEnd(8))} ${e.id} ${c.grey(`(${e.reason})`)}`);
      }
      console.log(c.grey('\nledger.jsonl is committed to git: it is how trust (and recovery history) travels between machines'));
      return 0;
    }

    if (cmd === 'journal') {
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub === 'revert') {
        const id = rest.filter((a) => !a.startsWith('--'))[rest.filter((a) => !a.startsWith('--')).indexOf('revert') + 1];
        if (!id) { console.error('usage: manual journal revert <id> [--force]'); return 2; }
        const state = new State(root);
        const res = await revertFromJournal(root, id, { state, force: rest.includes('--force') });
        if (res.forcedOverDrift) {
          console.log(c.amber('forced over later edits to the claim — they are gone (they are in git) '));
        }
        state.save();
        if (!res.changed) console.log(c.grey('claim already matches the recorded content — nothing to do'));
        return 0;
      }
      const entries = readJournal(root);
      const filter = rest.find((a) => !a.startsWith('--'));
      const shown = filter
        ? entries.filter((e) => String(e.id).includes(filter) || String(e.file_name).includes(filter))
        : entries;
      if (json) { console.log(JSON.stringify(shown, null, 2)); return 0; }
      if (shown.length === 0) {
        console.log(c.grey(filter ? `no journal entries matching "${filter}"` : 'journal is empty — nothing has been accepted yet'));
        return filter ? 1 : 0;
      }
      if (filter && shown.length === 1) {
        const e = shown[0];
        console.log(c.bold(`${e.id}  [${e.entry}]`));
        console.log(`  at       ${e.at}  (${e.machine})`);
        console.log(`  claim    ${e.claim || '—'}`);
        console.log(`  candidate ${e.file || '—'}  mode ${e.mode || '—'}`);
        if (e.reverts) console.log(`  reverts  ${e.reverts}`);
        if (e.reason) console.log(`  reason   ${e.reason}`);
        if (e.verdict) console.log(`  verdict  ${e.verdict.state}${e.verdict.note ? ` (${e.verdict.note})` : ''}`);
        console.log(`  before   ${e.before_hash || '—'}`);
        console.log(`  after    ${e.after_hash || '—'}`);
        console.log('');
        console.log(e.body);
        return 0;
      }
      console.log(c.bold(`manual journal — ${path.basename(root)} (${shown.length} entries)`));
      console.log('');
      for (const e of shown) {
        const mark = { accept: '✔', undo: '↩', revert: '⟲' }[e.entry] || '•';
        const verdict = e.verdict ? `${e.verdict.state}` : '—';
        console.log(`  ${mark} ${String(e.id).padEnd(34)} ${String(e.entry).padEnd(7)} ${String(e.claim || '—').padEnd(22)} ${verdict.padEnd(7)} ${short(e.reason || '', 60)}`);
      }
      console.log(c.grey('\neach entry records the exact previous file content, so `manual journal revert <id>` works from any checkout'));
      return 0;
    }

    if (cmd === 'graph') {
      const state = new State(root);
      const { claims, errors } = loadManual(root);
      const graph = buildGraph(claims, state.data.stamps);
      if (rest.includes('--dot')) { process.stdout.write(toDot(graph)); return 0; }
      if (rest.includes('--mermaid')) { process.stdout.write(toMermaid(graph)); return 0; }
      if (json) { console.log(JSON.stringify(graphToJson(graph), null, 2)); return 0; }
      for (const line of printGraphSummary(graph)) console.log(line);
      for (const e of errors) console.log(c.red(`load error: ${e}`));
      return graph.cycles.length || graph.missing.length || errors.length ? 1 : 0;
    }

    if (cmd === 'report') {
      const state = new State(root);
      const out = flag(rest, '--out') || undefined;
      const res = writeReport(root, { state, out });
      if (json) {
        console.log(JSON.stringify({ out: res.out, claims: res.data.claims.length, inbox: res.data.inbox.length }, null, 2));
        return 0;
      }
      console.log(`${c.green('✔')} report written: ${res.out}`);
      console.log(c.grey(`  ${res.data.claims.length} claims · ${res.data.graph.edges.length} edges · ${res.data.inbox.length} inbox candidate(s)`));
      if (rest.includes('--open')) {
        const { spawn } = await import('node:child_process');
        const pair = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', res.out]]
          : process.platform === 'darwin' ? ['open', [res.out]]
            : ['xdg-open', [res.out]];
        try { spawn(pair[0], pair[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* best effort */ }
      }
      return 0;
    }

    if (cmd === 'serve') {
      await serveCommand(root, {
        port: Number(flag(rest, '--port') || 4242),
        open: rest.includes('--open'),
        pidfile: flag(rest, '--pidfile') || null,
      });
      return 0;
    }

    if (cmd === 'inbox') {
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub === 'accept') {
        const file = rest[rest.indexOf('accept') + 1];
        if (!file) { console.error('usage: manual inbox accept <file>'); return 2; }
        const state = new State(root);
        const res = await acceptAndVerify(root, file, { state });
        state.save();
        if (res.verified && res.ok === false) {
          console.error(c.red(`the accepted proposal is false: ${res.verified.id} is now broken (${res.verified.note})`));
          console.error(c.grey(`  undo: manual inbox undo ${res.token}`));
          return 1;
        }
        if (res.verified) console.log(c.green(`verified: ${res.verified.id} is ${res.verified.state}`));
        return 0;
      }
      if (sub === 'undo') {
        const token = rest[rest.indexOf('undo') + 1];
        if (!token) { console.error('usage: manual inbox undo <token>'); return 2; }
        const state = new State(root);
        const res = await undoAndVerify(root, token, { state });
        state.save();
        if (res.verified) console.log(c.green(`restored: ${res.verified.id} is ${res.verified.state}`));
        return 0;
      }
      if (sub === 'preview') {
        const file = rest[rest.indexOf('preview') + 1];
        if (!file) { console.error('usage: manual inbox preview <file>'); return 2; }
        const p = previewInbox(root, file);
        console.log(c.bold(`${p.file} — ${p.summary}`));
        console.log(p.diff);
        return 0;
      }
      listInbox(root);
      return 0;
    }

    usage();
    return 2;
  } catch (e) {
    console.error(c.red(`manual: ${e.message}`));
    return 2;
  }
}
