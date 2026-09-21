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
