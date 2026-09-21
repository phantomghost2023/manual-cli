---
schema: manual/v1
id: policy.tests-registered
kind: policy
statement: Every file under src/ named *.test.js must import its tests from node:test so the runner discovers them.
priority: high
applies_to:
  - src/**
depends_on:
  - id: tests.demo
    required: true
evidence:
  files:
    - src/**
check:
  run: node -e "const fs=require('fs');const bad=fs.readdirSync('src').filter(f=>f.endsWith('.test.js')&&!fs.readFileSync('src/'+f,'utf8').includes('node:test'));if(bad.length){console.error('not registered with node:test: '+bad.join(', '));process.exit(1)}"
  expect:
    exit: 0
enforce:
  stage: pre-commit
  paths:
    - src/**
  severity: block
verify: on_change
provenance:
  author: mira
  origin: authored
  evidence: "incident: renamed test silently dropped from the run"
lifecycle: accepted
---
Every file under src/ named *.test.js must import its tests from node:test so the
runner discovers them.

The enforcement and the explanation are the same object: this claim's check is
the pre-commit hook. If the rule changes, the docs cannot drift from the gate.
