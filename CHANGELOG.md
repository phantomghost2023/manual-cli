# Changelog

All notable changes to manual-cli are documented here. Format: Keep a Changelog; versioning: SemVer.

## [0.6.0] - 2026-09-21

### Added
- `manual journal [<id>]` and `manual journal revert <id>`: a committed audit trail of every accepted change — who accepted it, on which machine, the reason it was proposed, the exact diff, the previous file content, and the verify verdict that followed. Revert restores the claim byte-for-byte from any checkout (or after a push), journals the revert as its own entry, and returns the candidate to the inbox. The local `.manual/undo/` snapshot stays as the fast path; the journal is the durable one.
- `manual ledger [--json]`: trust earned across machines in a committed `.manual/ledger.jsonl`, merged into every verify. Gold tier now requires passes on machines that actually exist rather than one laptop's synthetic count, and `history` shows trust alongside the git provenance it already had.
- Per-test timings: for checks whose runner reports them (node TAP, mocha/jest spec output) each measurement records the slowest test, the test count, and the suite total, so a diagnosis can name the test that dominates a runtime.
- Environment per measurement: free memory and 1-minute load average are recorded with every run, and `digest_changed` marks runs that followed a change to the claim's evidence.
- `observe` now explains spiky series instead of only respecting them: cold start, trend, outlier, bimodal, memory correlation, load correlation, cold cache, and dominant test. The diagnosis is written into the candidate, the journal entry, and `manual history`.
- `init` probes every discovered candidate in the sandbox and records `observation.probe_state` / `probe_note`, plus a body line telling the human not to accept a check that does not pass. `--no-probe` skips it.
- The sandbox links gitignored dependency trees (`node_modules`, `.venv`, `venv`, `vendor/bundle`) from the checkout into its worktree — without this, every check needing an installed dependency failed in the verifier while passing in the working tree.
- `docs/FIELD-NOTES.md`: what happened when the tool was pointed at expressjs/express.

### Fixed
- **`verify --json` never persisted anything.** It returned before `state.save()`, so the machine-readable mode — the one CI and agents use — printed fresh states and discarded them, leaving stamps, trust history and the flywheel's measurements stale on disk. Found by re-verifying a real repo and finding no new history entry for a run that had just reported success.
- An empty `.manual/claims/` threw (`contains no claim files`), so `verify`, `doctor`, `graph`, `brief` and `report` all died on a repo that had just run `init`, or had just reverted its only claim. It is now a state, not an error: the read-only commands report it, count the candidates waiting in the inbox, and exit 0. `verify` no longer prints a bare `0 claims:`.
- An inbox name that included its own path (`.manual/inbox/x.md` — what `ls` and the reports print) was rejected as unsafe by `inbox accept`/`preview`, and where it was accepted the sanitized name was then discarded, so the join produced `.manual/inbox/.manual/inbox/x.md`. Paths naming the inbox are now accepted and always reduced to their basename.
- `acceptAndVerify` read the candidate text through the raw argument, so accepting by path silently recorded no `candidate_text` and a later revert lost the proposal.
- `observe` used the tighten formula for relax proposals too; relaxing is about the observed worst case, not 3× the median.

## [0.5.0] - 2026-09-21

### Added
- Accepting a proposal now **re-verifies the affected claim** (forced, and scoped with `verify --only`). The verdict is returned to the CLI and rendered in the dashboard: fresh, or *"proposal turned out false"* with an undo button.
- `manual inbox undo <token>` and `POST /api/inbox/undo` restore the claim file byte-for-byte and put the candidate back in the inbox. Snapshots persist under `.manual/undo/` (gitignored, pruned to the last 20) so an undo works from a later process, not just the one that accepted.
- `manual inbox preview <file>` prints a candidate's exact frontmatter change without writing anything.
- `verify --only <ids>` runs named claims plus their transitive dependencies — verifying one claim without its dependencies just reports `blocked`.
- `observe` proposes bounds that respect the tail (≥3× p50, 1.5× p90, 1.1× worst observed) and **refuses** a tightening the observed tail would violate.
- `staleProposals` (surfaced by `observe` and `doctor`) flags inbox candidates whose evidence has moved since they were written — previously a stale candidate silently blocked the corrected one forever.

### Fixed
- `observe`'s tighten heuristic used 3× p50 alone. On a spiky series (p50 9s, p90 25s, worst 47s) it proposed an 11s bound — guaranteed flapping. This was caught by accepting a real proposal in the dashboard and watching it break the claim.
- The accept handler shadowed the HTTP `res` with its result object (`res.writeHead is not a function`).
- `acceptAndVerify` printed `acceptInbox`'s "review the diff, then commit" line, which contradicts the verify that just ran.

## [0.4.0] - 2026-09-21

### Added
- `history [<claim-id>] [--limit N] [--json]` — claim archaeology: state transitions, per-claim runtime trend (p50/p90/max), observed break count, mean time to recovery, and the git provenance of the claim file. Joins `state.json` verify history with the claim's own commit history; degrades gracefully on a root that is not a git repo.
- Timeline section in `report`/`serve`: verify-event and transition counts, mean time to recovery, and the most recent state flips across the manual.
- Per-claim runtime sparklines (inline SVG) plus break counts and file provenance on every card.
- Flywheel review in the dashboard: `GET /api/inbox/preview?file=` returns the exact frontmatter change a candidate proposes, and `POST /api/inbox/accept` applies it — so a human reviews a diff instead of accepting blind. The static report keeps the buttons hidden.
- Expr checks now record a runtime, so the cheapest claims are no longer invisible to the trend lines and the flywheel.
- Candidate filenames are validated (`safeInboxName`) so the HTTP surface cannot reach outside `.manual/inbox/`.

### Fixed
- `describeTimeline` crashed for any claim without git history (`files` was initialized to a truthy `[]`), which would break `manual history <id>` on an uncommitted claim.
- A claim that was already broken when the history window opened now reports that break instead of showing a `broken → fresh` transition beside "0 breaks".

## [0.3.0] - 2026-09-21

### Added
- `graph [--dot|--mermaid|--json]` — the evidence graph as data: layers by depth, cycle detection, dangling-edge and isolated-claim reporting; exits 1 on cycles or dangling edges.
- `report [--out <file>] [--open]` — one self-contained HTML page (inline SVG graph, claim cards, doctor issues, inbox, live filters). No CDN, no network requests, safe as a CI artifact.
- `serve [--port N] [--open] [--pidfile <f>]` — loopback dashboard regenerated per request, with `GET /api/graph`, `GET /api/claims`, `GET /health`, and `POST /api/verify` that re-runs the real checks; port failover N+1…N+19; pidfile for scripting.
- `readInbox(root)` — structured inbox contents (listInbox now renders it), shared by the report, the dashboard, and the MCP server.
- This repo's manual now documents the tool's own surface: `tooling.cli-surface`, `docs.commands` (fails if the README stops mentioning a command the CLI exposes), and `policy.claims-valid` (a real pre-commit gate against malformed claims).
- Tests: graph model/cycles/exporters, report rendering and escaping, HTTP end-to-end including pidfile and real CLI boot.

### Fixed
- The report's `check` row invented a schema (`check.run.expect`, `code`, `contains`). It now mirrors `runner.runCheck`: `run`/`expr` strings with `expect` as a sibling (`exit`, `stdout_matches`, `stderr_matches`, `max_ms`) — caught by looking at the served dashboard, where every check rendered empty.
- Policy `enforce` metadata was unreachable behind the `run` branch; the gate (stage, severity, paths) is now always shown.
- `serve.test.js` raced the pidfile against the stdout URL line (flaky ~1 in 3 under load). Caught by the dashboard's own `POST /api/verify` reporting `tests.suite` broken.
- Removed a dead placeholder (`globFiles`) left in `expr.js`.

## [0.2.0] - 2026-09-21

### Added
- `watch` — re-verify claims affected by file changes (debounced fs.watch; `affectedClaims` selection + dependency closure exported for editor integrations).
- `eject` — vendor the CLI into `tools/manual-cli/` for self-contained CI and hooks; `init`'s workflow template requires the vendored copy.
- `lockActive(owner, {withinDays})` expr API — ownership claims can detect in-flight work (recent owned branches, checked-out worktrees).
- `hooks install|uninstall|status` — managed pre-commit block running `manual enforce`.
- `brief --at <ref>` — bitemporal briefs: the manual as of any commit, lifecycle-filtered.
- MCP server (`manual mcp`) — `manual_brief`, `manual_verify`, `manual_doctor`, `manual_inbox` over stdio JSON-RPC.
- `doctor` — manual health: never-verified, evidence drift, expired TTLs.
- `observe` — flywheel: tighten/relax candidates from measurement history.
- `init` — claim discovery by inspection; scaffolds `.manual/`, CI workflow, gitignore.
- `verify --diff [base]` — CI mode: only claims relevant to changed files + policies + dep closure.
- Gold tier requires ≥5 passes across ≥2 machines; broken resets the ledger.
- Fuzz suite: 500 seeded random + targeted malformed inputs never crash parser/loader.
- Docs: 5-minute tutorial, man page, bash completions.

### Fixed
- Sandbox now preserves the manual's subdirectory offset inside worktrees (checks ran from repo root for nested manuals).
- Sandbox overlays untracked files (`ls-files --full-name`) so mid-work checks see new sources.
- `NODE_TEST_CONTEXT` is stripped from check environments (changed node:test CLI behavior and corrupted results).
- Glob character classes that would compile to invalid RegExps (e.g. `[z-a]`) degrade to literal matches instead of throwing.
- YAML: double-quoted scalars process escapes; single-quoted stay literal (regex-friendly); plain scalar sequence items no longer parse as `{}`.
- `runCheck` no longer clobbers computed `ok` with the raw expr result (spread order).

## [0.1.0] - 2026-09-21

### Added
- manual/v1 claim format: kinds (fact/command/trap/policy/ownership), evidence digests, dependency edges, provenance and trust tiers, TTLs.
- `verify`, `brief` (token-budgeted, trap-weighted), `inbox accept` (patch-merging).
- Worktree sandbox with dirty-overlay; expr API (exists/read/manifest/env/nodeMajor/codeowners).
- Demo repo with five executable claims, including a self-retiring trap.
