---
schema: manual/v1
id: tooling.node-esm
kind: fact
statement: This repo is pure ESM on Node >= 20; CommonJS requires will crash at import time.
when: true
priority: critical
applies_to:
  - "**"
evidence:
  files:
    - package.json
check:
  expr: |
    manifest("package.json").type === "module" && nodeMajor() >= 20
verify: on_change
provenance:
  author: mira
  origin: authored
  evidence: "repo scaffold uses type: module throughout"
lifecycle: accepted
---
This repo is pure ESM on Node >= 20; CommonJS requires will crash at import time.

## Gotchas
`require()` of any local module throws ERR_REQUIRE_ESM. Use `import` everywhere,
including in scripts.
