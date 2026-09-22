# manual-cli in 5 minutes

From zero to a self-verifying manual on a repo you already have.

## 0. Get the CLI

Dependency-free — just point at it:

```bash
alias manual="node /path/to/manual-cli/bin/manual.js"
```

## 1. Discover (30 seconds)

```bash
cd your-repo
manual init
```

`init` inspects package.json, lockfiles, test scripts, migrations and CODEOWNERS, then writes everything it can *back with evidence* into `.manual/inbox/` as candidates — never straight into claims. Nothing enters your manual on vibes.

## 2. Review (2 minutes)

```bash
manual inbox
```

For each candidate:
- **Agree?** Convert it: move the file to `.manual/claims/`, fill out `kind`, `check` and `statement` (init's candidates are honest stubs — they state what was observed, not what's enforced), then commit.
- **Disagree?** Delete it.

Or accept a patch-style candidate directly (it merges into the target claim's frontmatter):

```bash
manual inbox accept 2026-09-21-tighten-tests.demo.md
```

Accepting is not a file edit followed by a promise: the affected claim is
re-verified on the spot. And the accept is written to `.manual/journal/` — a
committed entry carrying the reason, the diff, the previous content and the
verdict — so it can be traced and undone later, from any checkout, by anyone:

```bash
manual journal                                   # what changed, why, and did it hold
manual journal 20260921T194044Z-tests.demo       # one entry in full
manual journal revert 20260921T194044Z-tests.demo  # restore it and re-verify
```

A revert also puts the candidate back in the inbox, so a rejected proposal is
still reviewable rather than gone.

## 3. Verify (30 seconds)

```bash
manual verify --force
```

Each check runs in a throwaway git worktree; stamps land in `.manual/state.json` (gitignored — local machine state, not truth). Exit 1 if anything is broken. Fix doc or code — you now know which, and why.

## 3b. When the tests need dependencies installed

Every real repository has this problem: on a fresh clone, `npm test` exits 127,
and the first claim about the suite is false before anyone has typed anything.
`init` sees it (no `node_modules`, dependencies declared), writes the install
into `manual.yaml` once, and points the candidate at it by name:

```yaml
# .manual/manual.yaml
setup:
  node:
    run: npm install
    evidence: ["package.json"]
    cache: ["node_modules"]
```

```yaml
# .manual/claims/tests.suite.md
check:
  requires: node
  run: npm test          # not the raw script: mocha needs node_modules/.bin on PATH
  expect: { exit: 0, max_ms: 120000 }
```

One install per ecosystem, however many claims need it — a second claim that
needs npm says `requires: node` and costs nothing; a claim that needs npm *and*
a Python virtualenv lists both and pays for two, once each, in that order.

The probe runs the setup, then probes again, and reports what it actually found:

```
$ manual init
probing discovered candidates before proposing them…
✔ probed init-tests.suite.md: fresh (19546ms)
1 candidate(s) needed a prerequisite first; the setup is declared in the file so verify can repeat it.
```

From then on the install is part of the claim's premise, not a surprise:

```bash
manual setup                   # declared prerequisites, who needs them, what this machine has
manual setup --plan            # the ordered sequence a full verify would run, and none of it is run
manual setup --force           # install what claims need, now instead of waiting for verify
manual setup --all             # also run declared steps no claim references
manual verify --no-setup       # trust the environment (CI already installed)
```

The install runs **once per command+evidence pair**, not once per verify, and if
it cannot complete the claim is `blocked` — untested, not disproven — so a laptop
without network never demotes a claim that was true on three other machines.

Two things make a *satisfied* install trustworthy rather than merely remembered.
Steps can depend on each other (`build: { requires: [node] }`), so the order is
computed, and `manual setup --plan` shows it before paying for it:

```console
$ manual setup --plan
prerequisite plan — 2 step(s), 3 claim(s), in the order a full verify runs them

  1. node → npm install  tests.suite, build.bundle  satisfied here (re-checked before use)
       re-checked with: builtin:npm
  2. build → make build  tests.suite  will run  needs node

1 satisfied, 1 to establish — verify pays for each once, in this order.
```

And `verify:` answers "is this install still the one the lockfile describes?" —
cheaply, with a builtin for whichever ecosystem the step installs:

```yaml
setup:
  node:
    run: npm install
    evidence: ["package.json", "package-lock.json"]
    cache: ["node_modules"]
    verify: { builtin: auto }       # resolves to npm here: 64ms on a 403-package tree
    share: true                     # other checkouts on this machine may borrow it

  python:
    run: python -m venv .venv && .venv/bin/pip install -r requirements.txt
    evidence: ["requirements.txt"]
    cache: [".venv"]
    verify: { builtin: venv }       # every declared distribution, at the declared version
```

The Node package managers are all covered, and each one's check knows what that
manager's own install does when the tree is damaged:

```yaml
setup:
  node:
    run: yarn install --frozen-lockfile --check-files   # what `init` writes for yarn 1
    evidence: ["package.json", "yarn.lock"]
    cache: ["node_modules"]
    verify: { builtin: yarn }       # v1's integrity map + the directories it linked;
                                    # berry's linked locations vs the locators
```

That `--check-files` is not decoration. Classic yarn trusts its integrity file,
which records *which lockfile the tree came from* and nothing about the tree:
delete `node_modules/is-odd` and a plain `yarn install --frozen-lockfile` answers
"Already up-to-date" in 0.2s with the package still gone, while `--check-files`
re-links it in the same 0.2s. So the builtin only *judges* a missing directory
when the declared command repairs it, and otherwise reports it — the same rule
that makes pnpm and `bun --linker isolated` report a missing store directory
instead of reinstalling forever.

When it says no, the reinstall explains itself instead of looking like a cache
that does not work:

```console
⚙ setup: npm install (cached install distrusted — verify: 3/403 installed package(s) missing, e.g. node_modules/mocha/node_modules/brace-expansion)
⚙ setup: npm install (rebuilding the distrusted install)
```

## 4. Use it daily

Before editing files, ask what the manual knows:

```bash
manual brief src/db/queries.ts
```

Before committing, let policies gate the commit:

```bash
manual hooks install     # once; adds a marked block to .git/hooks/pre-commit
git commit ...           # enforce runs automatically on staged-file matches
```

In CI, verify only what a PR touches (after `manual eject`, see below):

```bash
manual verify --diff origin/main
```

## 5. Feed the flywheel

After a few days of work:

```bash
manual observe
```

If runs consistently take 2s while a claim allows 30s, observe writes a *tighten* candidate. If a bound itself broke a claim, it proposes a *relax*. Proposed bounds keep headroom over the tail (p90 and the worst run seen), not just the median, and observe refuses to propose a tightening the tail would violate.

Then review and accept it:

```bash
manual inbox                          # list candidates
manual inbox preview 2026-09-21-tighten-tests.suite.md   # the exact diff
manual inbox accept  2026-09-21-tighten-tests.suite.md   # apply AND verify
```

Accepting is not blind and not the end: the affected claim is re-verified immediately.
If the proposal was wrong, the claim is left broken, the command exits 1, and you get an
undo token:

```bash
manual inbox undo <token>             # restore the claim byte-for-byte
```

The manual drifts toward truth as a side effect of work — but only proposals that can
survive their own check get to stay.

## 5b. See it

The manual is a graph of claims that depend on each other. `report` renders that graph as one self-contained HTML page, and `serve` exposes the same page as a live dashboard:

```bash
manual report --open            # writes .manual/report.html and opens it
manual serve --port 4242        # http://127.0.0.1:4242/
```

Nodes are colored by state and arrows point from a claim to what it depends on; click a node to jump to its card. The page has state/kind filters, the flywheel inbox, and whatever `doctor` is worried about. On the served dashboard there's also a **re-verify now** button: it re-runs the real checks in a sandbox and reloads with fresh stamps.

Once the manual has run for a while, ask what has been happening to it:

```bash
manual history                  # every claim: breaks, runtime trend, recovery time
manual history tests.suite      # one claim: transitions, p50/p90, git provenance
```

The dashboard shows the same timeline, and lets a human review a flywheel
proposal (its exact frontmatter diff) and accept it from the browser.

When you want the graph somewhere else, it exports:

```bash
manual graph                    # text summary (cycles, dangling edges, layers)
manual graph --mermaid          # paste into a PR or README
manual graph --dot | dot -Tsvg  # if graphviz is installed
```

## 6. For agent sessions

Point your coding agent at the MCP server so it starts every session with verified context instead of exploration:

```json
{ "mcpServers": { "manual": { "command": "node", "args": ["/path/to/manual-cli/bin/manual.js", "mcp", "--root", "."] } } }
```

The agent calls `manual_brief` with the files it's about to touch. Two minutes of setup replaces ten minutes of flailing per session.

## 7. Make it portable (optional)

```bash
manual eject
```

Vendors the CLI into `tools/manual-cli/` inside the repo, so CI workflows and hooks work with zero external setup — the repo carries its own verifier.

## When a claim goes red

- `fact`/`command` broken → repo changed: update claim or fix code.
- `trap` broken → **celebrate**: the gotcha is fixed; retire the claim.
- `blocked` → either a dependency claim isn't fresh (fix upstream) or a
declared prerequisite (`check.setup`) didn't complete: install it, then re-run.
`manual setup` names the command.
- Trust demotes on broken and is re-earned by execution — that's the point.
- `manual history <id>` says *why* it went red when the numbers explain it:
cold start, trend, outlier, two clusters, memory or load correlation, cold
cache after an evidence change, or one test dominating the suite.
- `manual journal` and `manual ledger` answer who changed it, whether it held,
and how many machines have independently re-verified it.
