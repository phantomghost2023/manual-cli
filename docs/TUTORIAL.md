# manual-cli in 5 minutes

From zero to a self-verifying manual on a repo you already have.

## 0. Get the CLI

Dependency-free — just point at it:

```bash
alias manual="node /c/Users/bainb/Desktop/manual-cli/bin/manual.js"
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

## 3. Verify (30 seconds)

```bash
manual verify --force
```

Each check runs in a throwaway git worktree; stamps land in `.manual/state.json` (gitignored — local machine state, not truth). Exit 1 if anything is broken. Fix doc or code — you now know which, and why.

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

If runs consistently take 2s while a claim allows 30s, observe writes a *tighten* candidate. If a bound itself broke a claim, it proposes a *relax*. You review, accept or delete — the manual drifts toward truth as a side effect of work, not because anyone maintains it.

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
{ "mcpServers": { "manual": { "command": "node", "args": ["/c/Users/bainb/Desktop/manual-cli/bin/manual.js", "mcp", "--root", "."] } } }
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
- `blocked` → a dependency isn't fresh; fix upstream first.
- Trust demotes on broken and is re-earned by execution — that's the point.
