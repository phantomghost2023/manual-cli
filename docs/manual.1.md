# manual(1) — self-verifying repository operating manual

## SYNOPSIS

```
manual <command> [--root <dir>] [options]
```

## DESCRIPTION

Every claim about a repository is a markdown file in `.manual/claims/` backed by an executable check. `verify` executes the checks and stamps truth; `brief` distills it for agents and humans; policies compile into git hooks; the flywheel proposes improvements for human approval. Checks run in a throwaway git worktree so they cannot dirty your checkout.

## COMMANDS

```
verify [--force] [--diff [base]] [--only <ids>] [--no-setup] [--setup-force]
       [--json]
    Run each claim's check (skipping unchanged evidence digests within TTL),
    stamp state.json, exit 1 if anything is broken or held back by a
    prerequisite that could not be established. --diff selects only claims
    relevant to changed files, plus all policies, plus dependency closure.
    --only takes a comma-separated list of claim ids and runs just those plus
    their transitive dependencies (a claim whose dependencies are unstamped
    reports `blocked`, which says nothing about the claim itself).
    --no-setup trusts the environment (CI installs its own dependencies) and
    refuses to call a claim broken when the prerequisite it declares is
    visibly absent; --setup-force re-runs an install the cache considers done.

setup [--force] [--all] [--claim <id>] [--json]
    What the manual needs installed before it can say anything: every
    prerequisite declared under `setup:` in .manual/manual.yaml, deduplicated by
    (command, evidence), plus any inline check.setup a claim carries — with the
    claims that reference each one, whether this machine has satisfied it, when
    it last ran, and how long it took. Listing is free — nothing is installed.
    --force runs what claims require (the same plumbing init and verify use),
    --all also runs declared steps no claim references, --claim narrows to one
    claim's prerequisites. Exit 1 if an install fails or times out, or if a
    claim requires a name nothing declares.

brief [--budget N] [--at <ref>] [--json] [files...]
    Token-budgeted briefing for the files in play. Weighted by priority x
    glob specificity x trust tier; traps score double; when:true always in.
    --at reconstructs the manual as of a past commit.

enforce [--stage pre-commit|pr]
    Run every policy claim's check as a gate. Block-severity failures exit 1.

observe
    Flywheel: compare recent measurements in state.json against claim bounds;
    write tighten/relax candidates to .manual/inbox/. Proposed bounds keep
    headroom over the tail (>= 3x p50, 1.5x p90, 1.1x worst observed) and a
    tightening is refused when the observed tail would violate it. Candidates
    whose evidence has since moved are reported as stale (also by doctor) —
    observe never rewrites a proposal a human may be reviewing.
    Each proposal explains the spread rather than just respecting it: cold
    start, upward/downward trend, single outlier, two clusters (bimodal),
    correlation with free memory or with 1-minute load average, spikes that
    followed a change to the claim's evidence (cold cache / artifact rebuild),
    and the case where one test dominates the suite's runtime. Load, memory and
    per-test data are recorded with each measurement; the diagnosis is written
    into the candidate frontmatter and body, into the journal entry, and is
    printed by `history`.

doctor
    Manual health: never-verified claims, evidence drift, expired TTLs.

init [--dry-run]
    Discover claims by inspection (package manager, module type, test runner,
    migrations, CODEOWNERS); scaffold .manual/, CI workflow, .gitignore.

inbox [accept|preview|undo <arg>]
    List candidates. preview <file> prints the exact frontmatter change a
    candidate would make (no writes). accept <file> applies it — merging
    proposes.patch into the target claim or moving a whole-claim candidate into
    claims/ — and then re-verifies the affected claim with force. A proposal
    whose check fails exits 1 and writes an undo snapshot to .manual/undo/.
    undo <token> restores the claim file byte-for-byte and returns the
    candidate to the inbox. Snapshots are pruned to the 20 most recent.

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

history [<claim-id>] [--limit N] [--json]
journal [<id>] [--json]
ledger [--json]
    Claim archaeology. Without an id: a table of every claim with its last
    state, observed break count, p50 runtime, and a unicode trend of recent
    runs. With an id: every state transition, runtime p50/p90/max, mean time
    to recovery, and the git provenance of the claim file. Joins state.json
    history (machine-local, capped at 500 events) with the committed trust
    ledger and with the commit history of the claim itself. Exits 1 when the
    named claim is currently broken.

journal [<id>] [--json]
    The durable audit trail for changes to the manual: one committed markdown
    file per accepted proposal recording the machine, the reason it was
    proposed, the exact diff, the previous file content and the verify verdict
    that followed. `journal revert <id>` restores the claim byte-for-byte from
    any checkout (no local undo snapshot needed), writes a revert entry
    pointing at the original, and puts the candidate back in the inbox. If the
    claim changed after that accept, the revert is refused: a byte-exact
    restore would discard the later edits. `--force` overwrites them anyway.
    Reverting cannot un-push; it makes a change traceable, not secret.

ledger [--json]
    The committed record of trust earned across machines (.manual/ledger.jsonl).
    Merged into every verify, so pass counts describe the repository rather than
    one checkout: gold tier requires passes on two machines that actually exist,
    and break/recovery history spans machines instead of one laptop's story.

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
    GET / (report), GET /api/graph, GET /api/claims, GET /api/inbox,
    GET /api/inbox/preview?file=, GET /health, POST /api/verify (re-runs the
    real checks and rewrites state.json), POST /api/journal/revert
    ({"id":"...", "force": false}) which reverts an accepted change from its
    journal entry — 409 with the reason when the claim has drifted since,
    POST /api/inbox/accept
    ({"file":"..."}) which applies a proposal and returns the verify verdict,
    and POST /api/inbox/undo ({"token":"..."}) which reverts it. Candidate names are validated
    to stay inside .manual/inbox/. Binds 127.0.0.1 only; if the port is taken
    it tries N+1 ... N+19. --pidfile lets scripts and editors find (and stop)
    the server.

help
    Show usage.
```

## GLOBAL FLAGS

`--root <dir>` operate on dir (default cwd) · `--json` machine output · `-h/--help`

## FILE FORMATS

Claim file `.manual/claims/<id>.md` — YAML frontmatter (schema, id, kind, statement, priority, applies_to, evidence, depends_on, check, verify, ttl, provenance, lifecycle) + prose body. `check` is one of `run` (shell + expect{exit,stdout_matches,stderr_matches,max_ms}), `expr` (sandboxed predicate over exists/read/manifest/env/nodeMajor/codeowners/lockActive), or `enforce` (policy gate: stage, paths, severity).

Prerequisites that have to exist before `run` can mean anything are declared
once, in `.manual/manual.yaml`, and referenced by name:

    setup:
      node:
        run: npm ci
        evidence: ["package.json", "package-lock.json"]
        cache: ["node_modules"]
        timeout_s: 900

    check:
      requires: [node, python]     # names from manual.yaml, in order
      setup:                       # optional per-claim step, runs last
        run: make build
        cache: ["dist"]
      run: npm test

Each prerequisite takes `run` (required), `evidence` (files whose *content*
invalidates the install; default: the repo's lockfiles), `cache` (the directories
its success is measured by; default node_modules) and `timeout_s` (default 900);
the shorthand `node: npm ci` is also accepted. Deduplication is by (command,
evidence) — a name, a second name for the same command, and an identical inline
step are one install — so ten claims requiring `node` pay for it once, and a
claim requiring two ecosystems pays for two, once each. Prerequisites run in the
order the claim lists them, then the claim's own inline step, once per (command,
evidence) pair rather than once per verify, in the checkout rather than the
sandbox, before the clock starts — so `measured_ms` stays the check's own
runtime and `setup_ms` records the install separately in `history`.

A claim whose prerequisite did not complete is `blocked`, not `broken`: it keeps
the trust it earned, fails CI, and says which step failed. A `requires` name that
nothing declares is a load error (exit 2) and blocks the claim, because a check
that runs without its install reports its own failure as the repository's truth.
`requires` is rejected on `expr` checks, which have nothing to install.

Kinds: `fact`, `command`, `trap` (broken = gotcha fixed → retire), `policy`, `ownership`. Trust tiers: ghost → bronze → silver (≥1 pass) → gold (≥5 passes across ≥2 machines); broken demotes and resets the ledger.

`.manual/state.json` is gitignored machine state: stamps, digests, measurement history, env salt (env values are never stored).

## PREREQUISITES

A fresh clone is not a broken repository. `npm test` without an install exits
127, and before `check.setup` existed that made the first claim on any real repo
false on arrival — the repository was blamed for the checkout. Now the
prerequisite is declared, run once per command+evidence pair, cached in
`.manual/cache/` (machine state, gitignored) with its result recorded in the
stamp and `history`, and its failure is reported as `blocked` with the command
that would fix it. `init` declares it from the repo's own package manager when
dependencies are missing, and infers it from a "Cannot find module" probe when
they aren't obviously package-managed. A script that begins with a system binary
(node, pytest, make) is run as written; one that calls a local binary (mocha,
jest, vitest) is run through the package manager's own entry point, because that
is the only place node_modules/.bin reaches PATH — the same reason the sandbox
prepends dependency bin directories to PATH for every check.

## EXIT CODES

0 all fresh/passed · 1 something broken, a blocked gate, a claim whose declared
prerequisite could not be established, a graph cycle, or a suspect doctor report
· 2 usage errors, load errors, or an unrunnable command.

## PROPOSALS MUST PROVE THEMSELVES

A candidate is an observation, and observations can be wrong. Accepting one is
therefore not a file edit: the affected claim is re-verified immediately, with
force (a proposal that only edits the claim's own frontmatter may not move its
evidence digest, so an unforced verify would happily re-report the old stamp).
Exit 0 means the proposal is now true; exit 1 means it is false, and the claim
is left exactly as the proposal made it — visible as broken, with an undo token.

## TIMELINE

`state.json` history records one event per executed check ({id, state, at, ms,
freemem_mb, loadavg1, digest_changed, and — when the runner reports them —
slowest_test, slowest_ms, test_count, test_total_ms}), so `history` can answer
questions the current stamp cannot: which claims flip most, whether a claim's
runtime is creeping toward its bound, and how long a claim stayed wrong after it
broke. It is an operational record on one machine, not an audit log; the trust
columns come from the committed ledger (.manual/ledger.jsonl) and the git
columns (`introduced`, `commits`, `last`) from the claim file's own commit
history, so both are shared by everyone.

## RESPONSIBILITY

Only `verify`, `watch` and the dashboard's re-verify write stamps; only `inbox
accept`, `journal revert` and `inbox undo` write claims; only `observe`, `init`
and `eject` write new files. An empty `.manual/claims/` is treated as a state,
not an error: read-only commands report it, count what is waiting in the inbox,
and exit 0, so a repo between `init` and its first accepted claim is usable.
`verify --json` persists stamps and history before printing, because CI reads
that output and a report that is not written down is not a verification.

## CONFIGURATION

`.manual/manual.yaml`: `brief.budget_tokens`, `verify.default_timeout_s`,
`verify.ci.required` / `verify.ci.diff_base`, and `setup.<name>` prerequisites.
The config is stat-cached per process, and a malformed block is reported with
the claims' load errors rather than taking the manual down. `init` writes the
detected ecosystems (`node`, `python` when a virtualenv is present, `make` when
the Makefile declares a `deps:` target) into this file and points candidates at
them by name; an existing `setup:` block is never rewritten — the detected name
is reported instead, so a human's file keeps its comments.

## PERFORMANCE

Evidence digests are deduplicated per evidence spec (repos commonly share globs
across claims), and parsed claims are cached per process, validated by stat.
`npm run bench` synthesizes 500 claims and measures every hot path.
