---
schema: manual/v1
id: candidate.tighten.tests.suite
kind: candidate
proposes:
  update: tests.suite
  patch:
    check.expect.max_ms: 69000
observation:
  at: 2026-09-21T18:50:20.943Z
  by: agent:manual-cli
  samples: 17
  measured_ms: 9429
  p50_ms: 9429
  p90_ms: 45575
  worst_ms: 46906
  evidence: "verify history in state.json; tighten proposal vs 120000ms bound"
review:
  needed: human-approve
---
Recent runs: p50 9429ms, p90 45575ms, worst 46906ms over 17 samples. The claim allows 120000ms.
Propose tightening to 69000ms — at least 3x the median, 1.5x the 90th percentile, and
1.1x the worst run seen here — so a real slowdown fails the claim while ordinary
variance does not.
