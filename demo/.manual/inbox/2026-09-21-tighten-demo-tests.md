---
schema: manual/v1
id: candidate.tighten-demo-tests
kind: candidate
proposes:
  update: tests.demo
  patch:
    check.expect.max_ms: 10000
observation:
  at: 2026-09-21T14:22:00Z
  by: agent:claude
  measured_ms: 210
  evidence: "verify stamps in state.json, 5 runs, p50 210ms — claim allows 30s"
review:
  needed: human-approve
---
Session measured the demo suite at 210ms p50 across 5 runs; current bound is 30s.
Propose tightening to 10s so a future 10x slowdown fails the claim instead of hiding.
