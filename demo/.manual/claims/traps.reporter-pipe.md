---
schema: manual/v1
id: traps.reporter-pipe
kind: trap
statement: `node --test --test-reporter=pipe` exits 7 with ERR_INVALID_ARG_VALUE — "pipe" looks like a valid reporter but is not.
priority: critical
applies_to:
  - src/**
  - package.json
depends_on:
  - id: tests.demo
    required: true
evidence:
  files:
    - src/**
    - package.json
check:
  run: node --test --test-reporter=pipe 2>/dev/null
  expect:
    exit: 7
  sandbox: worktree
verify: on_change
on_broken: retire
provenance:
  author: agent:claude
  origin: observed
  evidence: "session 2026-09-21: agent 'fixed' flaky output by piping, suite went red"
  approved_by:
    - mira
lifecycle: accepted
---
`node --test --test-reporter=pipe` exits 1 with ERR_INVALID_ARG_VALUE — "pipe" looks
like a valid reporter but is not.

## Looks right
`--test-reporter=pipe` reads like "pipe output to stdout" — and TAP/stream names
suggest it should work.

## What actually happens
Node rejects the reporter name with ERR_INVALID_ARG_VALUE and the suite exits 7
before running any test.

## Do instead
Use `--test-reporter=dot` (or the default spec reporter). Valid: spec, tap, dot,
junit, list.
