---
schema: manual/v1
id: tests.demo
kind: command
statement: The test suite runs with plain `node --test` and finishes in under a second.
priority: high
applies_to:
  - src/**
depends_on:
  - id: tooling.node-esm
    required: true
evidence:
  files:
    - src/**
check:
  run: node --test
  expect:
    exit: 0
    max_ms: 30000
verify: on_change
provenance:
  author: mira
  origin: authored
  evidence: "suite is node:test since the repo was created"
lifecycle: accepted
---
The test suite runs with plain `node --test` and finishes in under a second.

No test runner dependency is needed; the suite discovers `src/**/*.test.js`
by convention. See `policy.tests-registered` for the registration rule.
