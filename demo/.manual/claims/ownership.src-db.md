---
schema: manual/v1
id: ownership.src-db
kind: ownership
statement: No in-flight feature or migration branches touch src/ — safe to refactor. This claim breaks for review when one appears.
priority: high
applies_to:
  - src/**
evidence:
  files:
    - src/**
check:
  expr: |
    !lockActive("feature") && !lockActive("migration") && !lockActive("dana")
verify: on_change
provenance:
  author: mira
  origin: authored
  evidence: "single-maintainer repo; branches named feature/*, migration/* or containing a contributor handle mean in-flight work"
lifecycle: accepted
---
No in-flight feature or migration branches touch src/ — safe to refactor.

## Gotchas
This claim goes amber (broken) when a branch named `feature/*`, `migration/*`,
or containing a contributor handle (e.g. `dana/drizzle-to-kysely`) has recent
commits or is checked out in a worktree. Amber means *review*, not *wrong*:
coordinate before refactoring.
