---
schema: manual/v1
id: candidate.tighten.tests.suite
kind: candidate
proposes:
  update: tests.suite
  patch:
    check.expect.max_ms: 11000
observation:
  at: 2026-09-21T13:15:11.069Z
  by: agent:manual-cli
  samples: 3
  measured_ms: 3608
  evidence: "verify history in state.json; tighten proposal vs 120000ms bound"
review:
  needed: human-approve
---
Recent runs put p50 at 3608ms over 3 samples; the claim allows 120000ms.
Propose tightening to 11000ms (~3x headroom) so a future slowdown fails the claim instead of hiding.
