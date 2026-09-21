---
schema: manual/v1
id: tooling.modules
kind: fact
statement: This repo is pure ESM (`"type": "module"`); CJS requires crash at import time.
priority: critical
applies_to:
  - "**"
evidence:
  files:
    - "package.json"
check:
  expr: "manifest(\"package.json\").type === \"module\""
verify: on_change
provenance:
  author: agent:manual-cli
  origin: observed
  evidence: "discovered by manual init at 2026-09-21"
lifecycle: candidate
---

This repo is pure ESM (`"type": "module"`); CJS requires crash at import time.

## Notes
Use `import` everywhere, including scripts.
