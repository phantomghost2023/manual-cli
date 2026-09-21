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
