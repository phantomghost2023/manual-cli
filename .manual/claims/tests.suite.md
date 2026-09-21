---
schema: manual/v1
id: tests.suite
kind: command
statement: The test suite runs with `node --test`.
priority: high
applies_to:
  - "src/**"
  - "test/**"
  - "lib/**"
depends_on:
  - id: tooling.modules
    required: true
evidence:
  files:
    - "package.json"
    - "src/**"
    - "test/**"
check:
  run: "node --test \"test/*.test.js\""
  expect:
    exit: 0
    max_ms: 120000
verify: on_change
provenance:
  author: agent:manual-cli
  origin: observed
  evidence: "discovered by manual init at 2026-09-21"
lifecycle: candidate
---

The test suite runs with `node --test`.

## Notes
Discovered from package.json scripts.test = "node --test "test/*.test.js"".
