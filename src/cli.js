import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { State } from './state.js';
import { verify, printVerifyReport } from './verify.js';
import { brief } from './brief.js';
import { listInbox, acceptInbox } from './inbox.js';
import { enforce } from './enforce.js';
import { doctor, printDoctor } from './doctor.js';
import { init } from './init.js';
import { writeProposals } from './observe.js';
import { installHook, uninstallHook, hookStatus } from './hooks.js';
import { eject } from './eject.js';
import { startWatch } from './watch.js';
import { buildGraph, graphToJson, toDot, toMermaid, printGraphSummary } from './graph.js';
import { writeReport } from './report.js';
import { serveCommand } from './serve.js';
import { loadManual } from './claims.js';
import { buildTimeline, describeTimeline, fmtDuration, fmtWhen, sparkline } from './timeline.js';
import { c } from './color.js';

function usage() {
  console.log(`manual — self-verifying repository operating manual (manual/v1)

Usage:
  manual verify [--root <dir>] [--force] [--diff [base]] [--json]
  manual brief  [--root <dir>] [--budget N] [--json] [files...]
  manual enforce [--root <dir>] [--stage pre-commit|pr]
  manual observe [--root <dir>]          # flywheel: measurements -> inbox candidates
  manual doctor [--root <dir>]           # manual health report
  manual init   [--root <dir>] [--dry-run]   # discover + scaffold .manual/
  manual inbox  [--root <dir>] [accept <file>]
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
Observe turns measurement drift into inbox candidates for human review.`);
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
      const res = await verify(root, { state, force, diff: diffArg });
      if (json) {
        console.log(JSON.stringify({
          errors: res.errors,
          results: res.results.map((r) => ({
            id: r.claim.fm.id,
            state: r.stamp.state,
            tier: r.stamp.tier,
            note: r.stamp.note,
            measured_ms: r.stamp.measured_ms ?? null,
          })),
        }, null, 2));
        const code = res.errors.length ? 2 : res.results.some((r) => r.stamp.state === 'broken') ? 1 : 0;
        return code;
      }
      const code = printVerifyReport(res);
      state.save();
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
      if (json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        if (res.existed) console.log(c.grey('.manual/ already exists — adding only what is missing'));
        console.log(res.dryRun
          ? `would create ${res.created.length} file(s), discovered ${res.findings} claim candidates`
          : `created ${res.created.length} file(s), discovered ${res.findings} claim candidates:`);
        for (const f of res.created) console.log(`  + ${f}`);
        console.log(c.yellow('\nCandidates are in .manual/inbox/ — review, then `manual inbox accept <file>`.'));
      }
      return 0;
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
        acceptInbox(root, file);
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
