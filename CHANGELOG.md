# Changelog

All notable changes to manual-cli are documented here. Format: Keep a Changelog; versioning: SemVer.

## [0.11.2] - 2026-09-22

### Fixed

- **The pnpm builtin reported up to 165 false "missing" packages on a freshly synced pnpm-12 tree.** Measured end to end on vuejs/core (660 lockfile entries, `pnpm install --frozen-lockfile` exit 0 immediately before the check). Four independent causes, each found on the wild repo and each fixed against it:
  1. **Peer-suffix directory names.** pnpm 11 named store dirs `name@version`; pnpm 12 names them after the lockfile's *snapshot* key — the peer-resolved form, peers joined by `_` — and past 60 characters stores `first 27 chars + '_' + sha256(key)[:32]`. The recipe was proven before use (19/19 hash directories matched, zero store directories uncovered) and matching is exact again, derived from the lockfile's own spelling rather than a heuristic.
  2. **A nested YAML key hijacked the parser.** `snapshots:` entries indent `dependencies:` maps; the section-key regex let four-space lines match, so the current entry flipped to a junk key and the `optional: true` that followed landed nowhere — `@emnapi/*` counted missing though its snapshot marks it optional. Regexes that count spaces now count them exactly.
  3. **The package manager records itself.** `packageManager: pnpm@12.4.2` produces a lockfile entry for pnpm that never materializes in the project's virtual store. Same rule as platform binaries: a package not supposed to be here is not missing.
  4. **pnpm 12 filters the recorded lockfile copy.** `node_modules/.pnpm/lock.yaml` holds 645 of 660 entries — exactly the other-OS binaries dropped — so neither full nor machine-expected set equality holds. The check is now subset in both directions: every copied package must be in the lockfile (a foreign resolve adds packages), and every package this machine must have must be in the copy (a copy from another machine lacks them).
  After the fixes the wild verdict is `ok: true — 489 package(s) present, matching pnpm-lock.yaml (152 platform-specific or optional skipped, 1 packageManager self-reference skipped)` in 17 ms, with damage detection re-proven both ways (deleted `vite@8.3.0` → flagged; `pnpm install --frozen-lockfile` → restored → `ok: true`).
- **A check stopped by its time bound stamped `broken exit ?`.** Broken means the check ran and said no; a killed run never ran to a verdict. It is `blocked — untested, not false`, with a note naming the bound and suggesting `max_ms`. Found on the same wild repo, whose suite needs ~5 minutes against the 120 s default. (The bare `exit null` note was made legible as `no exit within Ns` earlier in the same pass.)
- **`init` discovered nothing on a `pnpm-workspace.yaml` monorepo.** The earlier workspaces fix read `package.json`'s `workspaces` key; vuejs/core declares its packages in pnpm's own workspace file, so the same zero-candidates breakdown recurred on the very ecosystem this drill targets. `pnpm-workspace.yaml` now counts as evidence that packages with code exist.
- **Sandbox teardown could crash a verify that already had its results.** On Windows, an `EBUSY` while removing the temp worktree killed the run *after* the check but *before* `state.save()` — stamp lost, worktree leaked, observed live on the wild repo. Teardown is best-effort: retries briefly, then warns and moves on, so a verify's verdict survives a dirty teardown.

### Added

- The repo's own manual runs in GitHub Actions on every push and PR (`.github/workflows/manual.yml`), with the badge in the README — the same verify a contributor gets from the pre-commit gate, executed where nobody's laptop is involved.
- `CONTRIBUTING.md` documents regenerating the hero and social-preview images and keeping the two cards in sync.
- Regression tests for every fix above: the hash-truncated pnpm-12 directory (fixture uses the real pnpm-computed hash, not a reimplementation), the nested `optional: true`, the `packageManager` self-reference, the timeout-blocked stamp, and the EBUSY-tolerant teardown (platform-aware: a live process parked in the worktree on Windows, clean removal on POSIX).

See `docs/FIELD-NOTES.md`, "Eighth pass", for the full drill narrative.

## [0.11.1] - 2026-09-22

### Fixed
- **`init` discovered nothing on a workspaces monorepo.** The gate deciding whether a repo has tests to discover checked four root directories (`test`, `tests`, `src`, `lib`); a workspaces repo keeps them under `packages/*/src` and `packages/*/test`, so `init` proposed zero claim candidates on remix-run/react-router v5.3.4 — a repo with one of the largest test suites in the ecosystem — and its plan was empty. A workspaces declaration is itself evidence that packages with code exist, so it now counts (`hasTestSources`).
- **A rebuild that did not repair the tree recorded a fresh witness, laundering the damage.** Found on the real yarn 1 clone: in-place damage trips the witness before the verifier is ever consulted; the declared `yarn install --frozen-lockfile` (a command that cannot repair — measured "Already up-to-date") runs as a no-op; the success path records a fresh witness of the *damaged* tree; and the reused path now trusts it. The verifier's `no` was architecturally unreachable — always outrun by the witness exactly when the tree was damaged. Every run the cache records is now held to its own verifier first, and a `no` is a failed install: recorded untrusted, never a fresh witness, retried like any other failure.

### Added
- The registry flake on the wild clone (`ESOCKETTIMEDOUT` at 317s into the first yarn install) confirmed the probe's honesty rule end to end: the candidate came out `blocked — the claim is untested, not false`, the journal carried the reason, and nothing false entered the manual. See `docs/FIELD-NOTES.md`, "Seventh pass".

## [0.11.0] - 2026-09-21

### Added
- **`yarn` and `bun` builtins, so every Node package manager a repo can use has a cached-install check.** `verify: { builtin: yarn }` reads both generations: classic yarn 1 compares the pattern → resolved-URL map in `node_modules/.yarn-integrity` with `yarn.lock` *and* checks that every directory the install claims to have linked is on disk (`topLevelPatterns` names them); berry compares each location in `node_modules/.yarn-state.yml` with the locators `yarn.lock` resolves, reporting a resolved package that has no location here (an optional or platform-specific dependency) rather than judging it missing. PnP stays unverifiable and says so: `.pnp.cjs` is generated from a binary install state and contains no locator list. `verify: { builtin: bun }` reads `bun.lock` (text, trailing commas and all) and knows both linkers — in a hoisted tree the lockfile key path under `node_modules` is the install, and in an isolated one (`node_modules/.bun` present) each resolved package has its own store directory `node_modules/.bun/<name>@<version>`, scoped names spelled `@scope+name`, with the workspace's own packages excluded and entries for another platform or marked optional skipped and counted. `bun.lockb` (the pre-1.2 binary lockfile) declares no verifier rather than one that can only answer "cannot tell".
- **`init` discovers both**: a `yarn.lock` or `bun.lock` repo gets a prerequisite with a verifier that reads it, and a classic yarn 1 lockfile gets `yarn install --frozen-lockfile --check-files`. `yarnKind` is exported from `src/verifiers.js` so discovery and verification agree on what the lockfile's format is.
- **A verdict must be one the declared command repairs — now enforced by the command itself, not by convention.** Classic yarn 1 trusts `.yarn-integrity` and nothing else: measured on a real 1.22.22 clone, deleting `node_modules/is-odd` left both the integrity file and `yarn install --frozen-lockfile` saying the install was fine ("Already up-to-date", 0.2s) with the package still gone, while `--check-files` and `--force` re-link it in the same 0.2s. So the classic-yarn builtin makes a missing linked directory a *verdict* only when the declared command re-links (`--check-files`/`--force`) and otherwise reports it with the flag that would fix it. bun's isolated linker is the third case of the same rule: a deleted `node_modules/.bun/<name>@<version>` is answered with "Checked 6 installs across 32 packages (no changes)", so its absence is reported, not judged, while a missing entry in a hoisted tree (repaired by a plain `bun install --frozen-lockfile` in 30–42ms, direct or transitive) is judged.

### Fixed
- **Paths in bun's reports were written with the host's separators** (`node_modules\.bun\is-odd@3.0.1` on Windows) because they were built with `path.join`. They are now written the way a path in a lockfile is — with forward slashes — since they are meant to be pasted into a message or a shell, not resolved by this process.
- **`init`'s classic/berry detection read `yarn.lock` relative to the working directory** instead of the repository root, so a classic lockfile seen from outside the repo was mistaken for a modern one and the repo got the install command that cannot repair a damaged tree. Caught by the test that writes both generations.

## [0.10.0] - 2026-09-21

### Added
- **Six ecosystem verifiers behind one word.** `verify: { builtin: … }` now covers `npm`, `pnpm`, `venv`, `gems`, `gomod` and `crates`, each comparing an installed tree against its own lockfile by reading directory listings instead of running the package manager's check: a Python virtualenv against the `dist-info` directories and versions its lockfile declares (`requirements.txt`, `poetry.lock`, `Pipfile.lock`, `uv.lock`, found in both `Lib/site-packages` and `lib/python3.x/site-packages`), a vendored Bundler tree (`vendor/bundle`, or whatever `.bundle/config`'s `BUNDLE_PATH` says) against `Gemfile.lock`'s `GEM` specs, `$GOMODCACHE` against `go.mod` (or `vendor/modules.txt` for a vendored build, in Go's `!`-escaped cache layout, with direct dependencies checked for source and the module graph for its `.mod`), and `$CARGO_HOME/registry` against `Cargo.lock`. `builtin: auto` resolves against the setup's own evidence — or the one lockfile in the checkout — and reports which verifier it picked and why; `lockfile` remains as the older spelling of `npm`.
- **`init` declares the verifier for the ecosystem it found**, and the virtualenv it declares is platform-correct (`.venv/Scripts` on Windows, `.venv/bin` elsewhere). The old command was POSIX-only, so the first `manual verify` on Windows wrote a prerequisite that could not run — a bug the Windows field probe found immediately.
- **A verifier reports rather than judges when a verdict would be unrepairable.** A builtin says "no" only when the declared command can put it right, which was measured rather than assumed: `npm ci` restores a deleted nested package, `pip install -r` restores a `dist-info`, `bundle install` restores a gemspec, `go mod download` restores a module. pnpm 11 does not — a satisfied `pnpm install` leaves a deleted `node_modules/.pnpm/<pkg>` and a modified `.pnpm/lock.yaml` alone, even with `--force` — so the pnpm builtin answers yes when the store and its lockfile copy agree and otherwise names exactly what it saw. `crates` reports for the same reason: `Cargo.lock` covers dev-dependencies and target-specific crates that a plain build never fetches. Those cases print on the verify path, where the person who can act on them is looking: `⚙ setup: … — reused, not re-confirmed: …`.
- **A subset install is recognised.** `npm ci --omit=dev`, `bundle install --without test`, `uv sync --no-dev`, `poetry install --only main` install part of a lockfile; there, a package that is absent is a fact about the command rather than a gap in the tree, and the verdict says so instead of rebuilding on every verify.
- **A verifier that cannot answer is reported on every surface that asks** — the plan, `manual setup`, `doctor` and the dashboard — and a verifier that *could* answer and declined is printed on the verify path, because "unverifiable" and "verified" are different facts about a tree.

### Fixed
- **A `lockfileVersion: 1` npm lockfile declared nothing**, and a verifier that declares nothing used to report "0 package(s) present, matching package-lock.json" — a *yes* for an empty tree. v1 locks are read (nested `dependencies`), and a lockfile that declares no installed packages is `cannot tell`, never a yes.
- **A `builtin:name` written as a string** is read as the same declaration instead of being run as a shell command (`builtin:npm: command not found`), which is the shape of the bug that silently degraded every cached install to a reinstall in 0.9.0.
- **Builtin options survive normalization.** `{ builtin: gems, path: … }` is no longer dropped when a spec is normalized a second time, which is what resolution does.
- **`npm` availability names another package manager's lockfile** when that is what the checkout has, so a pnpm/yarn/bun repo is told which verifier covers it rather than reading as "no lockfile at all".

## [0.9.0] - 2026-09-21

### Added
- **Prerequisites can depend on each other.** One step usually sits on another — a build needs the install, codegen needs the build — and the edge is now written down rather than implied by the order someone typed: `build: { run: make build, requires: [node], cache: ["dist"] }`. A claim's requirements are expanded through those edges and ordered topologically, so a claim that lists `[build, node]` still installs before it builds, and `requires` inside `manual.yaml` is validated when the config is read (a cycle or a dangling edge is reported there, not later as a confusing blocked claim).
- **`manual setup --plan`** prints the ordered, deduplicated sequence a full verify would execute — with the claims each step is for, whether it is satisfied here or can be borrowed from another checkout, and nothing executed. It exits 1 while any step is unsatisfied, which makes it a CI preflight ("how many installs will this run pay for?" answered before paying).
- **A satisfied prerequisite is verifiable, not merely remembered.** `verify:` re-checks a cached install before it is trusted: a command that exits 0, or the builtin `{ builtin: lockfile }`, which compares the installed tree against `package-lock.json`/`npm-shrinkwrap.json` by stat. On a 403-package express tree that is **64ms**, against **10.9s** for `npm ls --depth=0` — the obvious command was too slow to ever run on the verify path, which is why a tree that had lost a subtree stayed trusted. The map form is required for builtins so a bare word is never ambiguous.
- **A distrusted install explains itself**, naming the layer that caught it: `cached install distrusted — verify: 3/403 installed package(s) missing, e.g. node_modules/mocha/node_modules/brace-expansion`, then `rebuilding the distrusted install`. Losing a nested subtree is exactly what the cheapest layer cannot see: the immediate contents of `node_modules` are unchanged.
- **`share: true` lets another checkout borrow a verified install** instead of installing it again. The store records *where* an install was verified (not a copy of it), keyed by platform + command + evidence content; a checkout whose evidence matches links those directories. Opt-in, because the tree is then genuinely shared — and the record is re-verified at the moment of borrowing, so damaging the source tree sends the next checkout back to its own install rather than inheriting the damage. `setupStatus.borrowable_from` and the plan's `can be borrowed` surface it before anything runs.

### Fixed
- **A verifier now answers three ways: yes, no, and "there is nothing here to compare against".** Express ships `.npmrc` with `package-lock=false`, so `builtin: lockfile` had no lockfile — and `false` there means distrusting every cached install and reinstalling on every verify, for a repository that is perfectly fine. `ok: null` is not a reason to rebuild, and the gap is *reported* (`⚠ builtin:lockfile cannot run here: no package-lock.json or npm-shrinkwrap.json in this checkout`) in `manual setup` and in the plan rather than letting an unverifiable tree read as a verified one. The honest limit, stated because the feature rests on it: the lockfile builtin is only as good as the lockfile's provenance.
- **A builtin verifier declared in `manual.yaml` was silently downgraded to a shell command.** A normalized spec carries `verifyBuiltin` and `verify: "builtin:lockfile"`; normalizing it a second time (which is what resolution does) re-derived the builtin from that string, which the design deliberately cannot do, so the runner executed `bash -c 'builtin:lockfile'` — `command not found`, exit 127, on every verify. Every cached install was therefore distrusted and reinstalled, which reads exactly like a cache that does not work. `normalizeSetup` is idempotent now. Found by running it on a real repo, not by the suite.
- A prerequisite **cycle** produced an `order` containing the steps inside it — a sequence that cannot be executed. Cycled steps are refused as a load error and left out of `order`; the claims that reach them are `blocked` and nothing installs.
- The reinstall reason printed as `⚙ setup: npm install ( missing)` when the declared directories were present and the *verifier* was the reason, hiding the one piece of information that made the reinstall explicable.
- `setup --plan` printed `satisfied here` for a step that declares a verifier without saying that the tree is re-checked when it is used; it now reads `satisfied here (re-checked with builtin:lockfile before use)`. The cheap layers stay cheap, and say so.

### Notes
- Verified on a fresh `expressjs/express` clone (403 packages, 1261 tests): the lockfile builtin answers in **64ms** against **10.9s** for `npm ls --depth=0`; a deleted `node_modules/mocha/node_modules` — invisible to the witness — is caught by the verifier and repaired (`verify` 27.0s with the reinstall, 20.1s once satisfied, no install line at all); and a **second clone of the same repo, with the same evidence and nothing installed, borrowed the first clone's tree**: `borrowed from …\express-org (verified there, never installed here)`, 16.3s end to end against 43.0s to install for itself.

## [0.8.0] - 2026-09-21

### Added
- **Prerequisites are declared once, in `.manual/manual.yaml`, and referenced by name.** A repository does not have one prerequisite — it has an install per ecosystem (npm and a Python venv), a build, a codegen step — and every command claim that touched them had to restate the same command. The same command written twice is two chances to disagree, so `setup.<name>` now holds the definition and `check.requires: node` (or a list) holds the reference. Inline `check.setup` still works for the one claim with the one awkward step that is nobody else's business.
- **Deduplication follows the command, not the claim.** A named prerequisite runs once per (command, evidence) pair however many claims reference it, so ten claims requiring `node` pay for one install; two names for the same command, or a claim listing a name and the identical inline step, are also one. A claim requiring two ecosystems pays for two, once each, in the order it lists them, with its own inline step last — the specific build that sits on top of the installs.
- `stamp.setups[]` and `history.setups` / `setup_ms` / `setup_status`: each claim records every prerequisite it used, by name, with the status each ended in — so a failure says *which* step (`node: npm ci`) rather than "setup failed", and two installs are still not the suite's runtime.
- `manual setup` is the inventory: declared prerequisites, the claims that reference each, whether this machine has satisfied it, when it last ran and how long it took. `--force` runs what claims require; `--all` also runs declared steps no claim references (a declared install is a fact about the repo, not a request to run it); `--claim` narrows to one claim. `--json` carries name, claims, `declared` and `cached`.
- `init` writes the detected ecosystems into `manual.yaml` (`node`; `python` when a virtualenv is present; `make deps` when the Makefile declares that target) and points candidates at them by name. An existing `setup:` block is never rewritten — the detected name is reported as not written instead, so a human's file keeps its comments and ordering.
- A claim that requires a name nothing declares is a **load error** (`verify` exits 2, `doctor` reports it) *and* blocks the claim: a check that runs without its install reports its own failure as the repository's truth. `manual setup` exits 1 and names the typo.
- Config hygiene: `manual.yaml` is stat-cached per process (a phase-2 per-claim runCheck no longer re-reads it for every claim), its `setup:` block is validated (names, shapes, timeouts) and a malformed one is reported alongside the claims' load errors rather than crashing the manual.
- `doctor`, `brief` (`⚙ needs: node: npm ci (missing node_modules)`) and the report/dashboard all show every prerequisite of a claim, by name, with whether this machine has it.

## [0.7.0] - 2026-09-21

### Added
- **`check.setup`: a declared prerequisite for command checks.** A fresh clone is not a broken repository, but `npm test` without an install exits 127 and the claim used to read `broken` — blaming the repo for the checkout. A claim can now declare the install or build step it depends on (`setup: npm ci`, or a map with `run`, `evidence`, `cache`, `timeout_s`), and a claim whose setup did not complete reports **`blocked`**: untested, not disproven, keeping the trust it earned, failing CI with the reason instead of the claim's name. Setup is rejected on `expr` checks.
- It runs **once per (command, evidence) pair, not per verify**: the key is the command plus the *content* of its evidence, so a lockfile change re-installs and re-verifying untouched code does not; twelve claims needing `npm ci` pay for it once (memoised within a run, cached on disk across runs in `.manual/cache/`, gitignored). The cache is only trusted while the directories it declares still exist — delete `node_modules` by hand and the next verify reinstalls it. Failures are recorded for diagnosis but never trusted, so a transient network failure cannot blind the manual.
- Installs run in the checkout, not the sandbox: dependency trees belong where the developer puts them, a throwaway worktree would reinstall on every verify, and the sandbox's existing link of `node_modules` into the worktree makes the result visible to the check. Setup cost is excluded from `measured_ms`, so bounds and the flywheel's proposals keep meaning the suite's own runtime; the stamp and `history` record it separately.
- `manual setup [--force] [--claim <id>] [--json]`: what is declared, whether this machine has satisfied it, when it last ran, and how long it took — deduplicated by command. Listing installs nothing; `--force` runs them.
- `verify --no-setup` (trust the environment — the CI path, where the workflow installs dependencies itself) and `verify --setup-force` (re-run an install the cache considers done). `--no-setup` refuses to call a claim broken when the prerequisite it declares is visibly absent.
- `init` declares the prerequisite it can see: dependencies declared, `node_modules` missing, and the install command follows the repo's own manager (npm/pnpm/yarn/bun, lockfile-aware). When dependencies aren't obviously package-managed, the probe learns it from the failure instead — a check that exits with "Cannot find module" gets the inferred setup written into the candidate and is probed again, so the second probe is the one that says something about the repo.
- A discovered test script that starts with a system binary (`node`, `pytest`, `make`) is run as written; one that calls a local binary (`mocha`, `jest`, `vitest`) is run through the package manager's own entry point (`npm test`), because that is the only place `node_modules/.bin` reaches `PATH` — and the statement names both. The check no longer silently disagrees with its own prose.
- The sandbox prepends dependency `bin` directories (`node_modules/.bin`, `.venv/bin`, `vendor/bin`) to `PATH` for every check, the way `npm run` and `pip` do, so a claim that runs `mocha test/` works and is not reported as a failing suite.
- `doctor` reports prerequisites that are declared but unsatisfied (with the command that fixes them), `brief` marks a claim whose prerequisite is missing on this machine (`⚙ needs: npm ci`), and the report/dashboard shows a setup row per claim.

### Fixed
- **A pre-commit policy gate passed policies it never ran.** `enforce` only reported `broken` as a failure, so a `blocked` policy — an unfresh dependency, or now a prerequisite that could not be installed — passed the gate silently. A gate that reports success for a check it did not run is worse than no gate; every non-fresh state now fails it, with the reason.
- **The sandbox emptied the developer's `node_modules` on Windows.** A recursive delete follows a junction into its target, so tearing the worktree down removed the *contents* of the linked dependency tree while leaving the directory in place — the sandbox appeared to work and the repo was broken afterwards. Found by verifying twice in one test: the second run reported a missing dependency the install had already satisfied. The links are now removed by the sandbox that made them, before the worktree is deleted.
- Discovery probed with a flat 20-second cap, which killed a real suite mid-run and proposed the candidate as `broken`. The probe now waits at least as long as the claim's own `max_ms`, because a false "broken" during discovery is worse than a slow one.

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
- A `journal revert` that would discard edits made *after* the accepted change now refuses and explains (`--force` overrides; the dashboard returns 409 and offers a *revert anyway* button) — a byte-exact restore is the only honest revert, but silently overwriting later work is not.
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
