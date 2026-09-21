# manual(1) — self-verifying repository operating manual

## SYNOPSIS

```
manual <command> [--root <dir>] [options]
```

## DESCRIPTION

Every claim about a repository is a markdown file in `.manual/claims/` backed by an executable check. `verify` executes the checks and stamps truth; `brief` distills it for agents and humans; policies compile into git hooks; the flywheel proposes improvements for human approval. Checks run in a throwaway git worktree so they cannot dirty your checkout.

## COMMANDS

```
verify [--force] [--diff [base]] [--json]
    Run each claim's check (skipping unchanged evidence digests within TTL),
    stamp state.json, exit 1 if anything is broken. --diff selects only claims
    relevant to changed files, plus all policies, plus dependency closure.

brief [--budget N] [--at <ref>] [--json] [files...]
    Token-budgeted briefing for the files in play. Weighted by priority x
    glob specificity x trust tier; traps score double; when:true always in.
    --at reconstructs the manual as of a past commit.

enforce [--stage pre-commit|pr]
    Run every policy claim's check as a gate. Block-severity failures exit 1.

observe
    Flywheel: compare recent measurements in state.json against claim bounds;
    write tighten/relax candidates to .manual/inbox/.

doctor
    Manual health: never-verified claims, evidence drift, expired TTLs.

init [--dry-run]
    Discover claims by inspection (package manager, module type, test runner,
    migrations, CODEOWNERS); scaffold .manual/, CI workflow, .gitignore.

inbox [accept <file>]
    List candidates; accept merges proposes.patch into the target claim or
    moves a whole-claim candidate into claims/.

hooks install|uninstall|status
    Manage the pre-commit gate (marked, idempotent block in .git/hooks/pre-commit).

eject [--dry-run]
    Vendor the CLI into tools/manual-cli/ for self-contained CI and hooks.

mcp [--root <dir>]
    Model Context Protocol server over stdio: manual_brief, manual_verify,
    manual_doctor, manual_inbox tools for coding agents.

watch [--debounce N]
    Watch the repo; on file change, re-verify claims whose evidence globs
    match the changed file, plus bidirectional dependency closure. Stop with
    Ctrl+C. Runs until signaled; writes stamps to state.json.

graph [--dot|--mermaid|--json]
    The evidence graph as data: nodes are claims, edges are depends_on
    (solid = required, dashed = optional). Prints claims/edges/layers and any
    cycles, dangling edges, or isolated claims. --dot and --mermaid emit
    diagram source for embedding. Exit 1 if a cycle or dangling edge exists.

report [--out <file>] [--open]
    Write a single self-contained HTML page (default .manual/report.html):
    inline SVG evidence graph, one card per claim with state/tier badges,
    doctor issues, the flywheel inbox, and live filters. No CDN, no build
    step, no network requests — safe to attach to CI or email.

serve [--port N] [--open] [--pidfile <file>]
    Serve the same page as a loopback dashboard, regenerated per request:
    GET / (report), GET /api/graph, GET /api/claims, GET /health, and
    POST /api/verify which re-runs the real checks and rewrites state.json.
    Binds 127.0.0.1 only. If the port is taken it tries N+1 ... N+19.
    --pidfile lets scripts and editors find (and stop) the server.

help
    Show usage.
```

## GLOBAL FLAGS

`--root <dir>` operate on dir (default cwd) · `--json` machine output · `-h/--help`

## FILE FORMATS

Claim file `.manual/claims/<id>.md` — YAML frontmatter (schema, id, kind, statement, priority, applies_to, evidence, depends_on, check, verify, ttl, provenance, lifecycle) + prose body. `check` is one of `run` (shell + expect{exit,stdout_matches,stderr_matches,max_ms}), `expr` (sandboxed predicate over exists/read/manifest/env/nodeMajor/codeowners/lockActive), or `enforce` (policy gate: stage, paths, severity).

Kinds: `fact`, `command`, `trap` (broken = gotcha fixed → retire), `policy`, `ownership`. Trust tiers: ghost → bronze → silver (≥1 pass) → gold (≥5 passes across ≥2 machines); broken demotes and resets the ledger.

`.manual/state.json` is gitignored machine state: stamps, digests, measurement history, env salt (env values are never stored).

## EXIT CODES

0 all fresh/passed · 1 something broken, a blocked gate, a graph cycle, or a
suspect doctor report · 2 usage errors, load errors, or an unrunnable command.

## PERFORMANCE

Evidence digests are deduplicated per evidence spec (repos commonly share globs
across claims), and parsed claims are cached per process, validated by stat.
`npm run bench` synthesizes 500 claims and measures every hot path.
