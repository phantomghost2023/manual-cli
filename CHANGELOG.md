# Changelog

All notable changes to manual-cli are documented here. Format: Keep a Changelog; versioning: SemVer.

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
