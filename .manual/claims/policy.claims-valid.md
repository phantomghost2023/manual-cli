---
schema: manual/v1
id: policy.claims-valid
kind: policy
statement: Every file in .manual/claims/ must load as a valid manual/v1 claim before it can be committed.
priority: critical
applies_to:
  - ".manual/**"
depends_on:
  - id: tooling.modules
    required: true
evidence:
  files:
    - ".manual/claims/**"
    - "src/claims.js"
check:
  run: node -e "import('./src/claims.js').then(m => { const r = m.loadManual('.'); if (r.errors.length) { console.error(r.errors.join(' | ')); process.exit(1); } console.log(r.claims.length + ' claims parsed'); }).catch(e => { console.error(e.message); process.exit(1); })"
  expect:
    exit: 0
enforce:
  stage: pre-commit
  paths:
    - ".manual/claims/**"
  severity: block
verify: on_change
provenance:
  author: agent:manual-cli
  origin: authored
  evidence: "a typo'd claim silently disappears from verify; this gate makes that impossible to commit"
lifecycle: accepted
---

Every file in `.manual/claims/` must load as a valid manual/v1 claim before it
can be committed.

A claim that fails to parse is worse than a missing claim: `verify` reports it as
a load error, but nothing stops it from being committed and forgotten. This
policy is the gate — the loader is run against the staged tree, and a malformed
claim fails the commit.

## Gotchas

- `verify` tolerates load errors so a broken claim cannot mask the state of the
  others. That tolerance is exactly why this gate exists.
- The check runs in a sandbox worktree, so it sees the staged content, not your
  working tree.
