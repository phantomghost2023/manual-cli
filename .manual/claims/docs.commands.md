---
schema: manual/v1
id: docs.commands
kind: fact
statement: The README documents every command the CLI exposes, so the docs cannot drift from the surface.
priority: high
applies_to:
  - "README.md"
  - "src/**"
depends_on:
  - id: tooling.cli-surface
    required: true
evidence:
  files:
    - "README.md"
    - "src/cli.js"
check:
  expr: "[\"verify\",\"brief\",\"enforce\",\"observe\",\"doctor\",\"init\",\"inbox\",\"hooks\",\"eject\",\"watch\",\"history\",\"graph\",\"report\",\"serve\"].every(c => read(\"README.md\").includes(c))"
verify: on_change
provenance:
  author: agent:manual-cli
  origin: observed
  evidence: "authored after adding graph/report/serve; it failed the first time the new commands were omitted from the command list"
lifecycle: accepted
---

The README documents every command the CLI exposes.

Documentation drift is the default failure mode of every tool: the code gains a
command and the README keeps describing last month's surface. This claim makes
that drift a red check. It depends on `tooling.cli-surface`, so if the surface
itself is broken the doc claim is reported `blocked` — not a false pass over a
lie.

## Gotchas

- The list of commands is duplicated in this claim and in `tooling.cli-surface`.
  A third command would need both lists updated. That duplication is deliberate:
  the two claims check different artifacts (source vs. prose), and a claim that
  read the list from `cli.js` could not detect a command missing from `cli.js`.
