---
schema: manual/v1
id: tooling.cli-surface
kind: fact
statement: The CLI dispatcher handles verify, brief, enforce, observe, doctor, init, inbox, hooks, eject, watch, history, graph, report, and serve.
priority: high
applies_to:
  - "src/**"
  - "bin/**"
evidence:
  files:
    - "src/cli.js"
    - "bin/manual.js"
check:
  expr: "[\"verify\",\"brief\",\"enforce\",\"observe\",\"doctor\",\"init\",\"inbox\",\"hooks\",\"eject\",\"watch\",\"history\",\"graph\",\"report\",\"serve\"].every(c => read(\"src/cli.js\").includes(\"cmd === '\" + c + \"'\"))"
verify: on_change
provenance:
  author: agent:manual-cli
  origin: observed
  evidence: "authored while adding graph/report/serve; the list is checked against the source, not maintained by hand"
lifecycle: accepted
---

The CLI dispatcher handles every command this project documents.

The expression reads `src/cli.js` and requires a `cmd === '<name>'` branch for
each command. Renaming or dropping a command therefore breaks this claim before
it can break a user — and `docs.commands` depends on it, so the README cannot
keep claiming a command that no longer exists.
