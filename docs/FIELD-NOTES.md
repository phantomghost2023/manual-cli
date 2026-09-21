# Field notes: running this on a repo it didn't grow up with

Every claim in this project until now was tested against `demo/` and against
`manual-cli` itself — two repositories built for the tool, which is the most
flattering possible test. These are notes from pointing it at
[expressjs/express](https://github.com/expressjs/express) instead: a fresh
`--depth 1` clone, 214 tracked files, CommonJS, `mocha` tests, no
`packageManager` field, no lockfile at the root, dependencies not installed.

Everything below is from actual runs, not from reading the code.

## What worked on first contact

```
$ manual init --root .
✔ probed init-tests.suite.md: fresh (721ms)      # in a fixture whose test command works
created 1 file(s), discovered 1 claim candidates:
  + init-tests.suite.md
  + .github/workflows/manual.yml

$ manual graph --root .       → 1 claims, 0 edges, 1 layer(s)
$ manual doctor --root .      → 0 healthy, 1 need attention, 0 stale candidate(s)
$ manual inbox accept init-tests.suite.md
proposal init-tests.suite.md: broke it: exit 127
  journaled:  .manual/journal/20260921T191203Z-tests.suite.md
  undo with:  manual inbox undo 474a587e-…
```

`init` scaffolded the manual, the sandbox ran the check in a worktree of the
real repo, the accept-and-verify step caught that the claim was false, the
journal recorded why, and `graph`/`doctor`/`report` all rendered. No crashes, no
path bugs, no surprises in the plumbing.

## Where it actually breaks down

**1. `init` finds one claim and calls it a manual.** For express it discovered
the test script and nothing else. `scripts.lint` (`eslint .`) was ignored.
CommonJS was correctly *not* claimed as ESM, but nothing recorded "this repo is
CommonJS". `engines.node` was ignored. A real manual for express would need
dozens of claims about routing, middleware ordering, and the test harness — the
kind of thing only a human or a long-running agent session knows. **`init` is
not how you get a manual; it is how you get the flywheel's first input.** That
is now stated in the README rather than implied.

**2. The first claim it ever proposed for a real repo was false on arrival.**
`exit 127`: `mocha: not found`, because the discovered check runs the test
script and dependencies were not installed. The discovery is trivially cheap
(parse `package.json`, notice a `test/` directory); the *claim* was expensive
and wrong. Fixed: `init` now **probes** each candidate in the sandbox and writes
`observation.probe_state`/`probe_note` into the file, plus a body line telling
the human not to accept a check that does not pass (`--no-probe` skips it).

**3. The statement contradicted the check.** For an unrecognized runner, `init`
fell back to the prose "runs with `npm test`" while the check ran the raw script
(`mocha --require test/support/env …`). A claim whose prose and whose check
disagree is worse than no claim. Fixed: the statement now names the runner it
actually runs.

**4. The verifier could not see installed dependencies at all.** This was the
most serious finding. Checks run in a `git worktree`, and `node_modules/` is
gitignored, so it is neither in the worktree nor in the untracked overlay —
meaning **every** check that needs an installed dependency failed in the
sandbox while passing in the working tree.

Reproduced minimally:

```
$ manual verify --root . --force
❌ dep.check    broken   exit 1        # require('./node_modules/local.js') — file is there, worktree can't see it
```

Fixed: the sandbox now links `node_modules`, `.venv`, `venv`, and
`vendor/bundle` from the source checkout into the worktree (shared, not copied —
a check that mutates a dependency mutates yours, exactly as running the command
by hand would). Same check, after the fix: `✅ dep.check  fresh  209ms`.

**5. There is no notion of prerequisites.** Real repos need `npm ci`, a build
step, or a generated file before any command check can pass. The tool models
*evidence* (what a claim depends on changing) but not *setup* (what must be true
before a claim can even run). On express this shows up as a claim that can only
ever be `broken` on a fresh clone, and the honest workaround today is a human
editing the check to `npm ci && mocha …` — which then re-installs dependencies
on every verify. A `requires:` field, or a per-claim setup command run once per
sandbox, is the missing concept.

**6. One claim makes the interesting features vacuous.** The dependency graph,
the timeline, the flywheel, tier promotion — all of them need a claim set with
structure. `1 claims, 0 edges, 1 layer` demonstrates nothing. The tool's value
scales with manual *size*, and nothing in it helps you grow from 1 to 50 claims
except writing them.

**7. Suites are slow, and gating is coarse.** Express's suite is minutes, not
seconds; the claim as generated allowed 120s. Digest gating and TTLs mean it
runs rarely, but when it does run it dominates a verify. Per-claim time budgets
exist (`max_ms`), per-claim *scheduling* does not.

## What these notes changed

- `init` probes candidates and records the outcome (finding 2).
- `init`'s statement matches its check (finding 3).
- The sandbox links ignored dependency trees (finding 4).
- The README states plainly that `init` seeds a manual rather than producing one
  (findings 1, 6).

## Second pass: the same repo, after the fixes

Re-running the whole loop on the same clone, in a clean `.manual/`, this time
following the human path end to end. What worked, verbatim:

```
$ manual init
probing discovered candidates before proposing them…
✖ probed init-tests.suite.md: broken (exit 127)

1 candidate(s) do not pass here — they are marked in the file; fix the command
or install dependencies before accepting

$ manual inbox accept .manual/inbox/init-tests.suite.md
proposal init-tests.suite.md: broke it: exit 127
  journaled:  .manual/journal/20260921T194044Z-tests.suite.md
  undo with:  manual inbox undo 8a70e265-…
the accepted proposal is false: tests.suite is now broken (exit 127)

$ manual journal
  ✔ 20260921T194044Z-tests.suite   accept   tests.suite   broken  moves inbox/…

$ manual journal revert 20260921T194044Z-tests.suite
reverted 20260921T194044Z-tests.suite: tests.suite restored → unknown
  candidate back in the inbox: inbox/init-tests.suite.md
  journaled:  .manual/journal/20260921T194046Z-tests.suite.md
```

A false claim was proposed, flagged *before* being accepted, accepted anyway (a
human's prerogative), caught by its own check, journaled with the reason, and
reverted byte-for-byte from a separate process — with the proposal returned to
the inbox. That is the whole design working on a repo it had never seen.

### What round two broke, and what that says

Every remaining bug was found by running the tool on this repo, and every one of
them was in the path a *new user* takes.

**A. `verify --json` reported success and persisted nothing.** The JSON branch
returned before `state.save()`. For the mode CI and agents use, the run printed
five fresh claims and threw away the stamps, the measurements and the trust
history. It was invisible from the outside — the exit code was right, the output
was right, only the disk disagreed. It surfaced here because a verify that
printed `tests.suite fresh 29s` had left no corresponding history entry, and no
new entry meant nothing for the timeline, the flywheel, or a diagnosis to read.

**B. An empty `.manual/claims/` killed every read-only command.** `verify`,
`doctor`, `graph`, `brief` and `report` all threw `contains no claim files` —
which is the state a repo is in *between `init` and its first accepted claim*,
and again right after reverting its only claim, i.e. exactly what the sequence
above produces. A missing manual is an error worth reporting; an accepted-but-
empty one is a stage of adoption. It now says so and points at the inbox.

**C. Path-shaped arguments were rejected, then silently mishandled.**
`manual inbox accept .manual/inbox/x.md` — the string a user copies from `ls`,
from `init`'s own output path, or from the report — was refused as an *unsafe
candidate name*. Loosening that exposed the real bug underneath: the sanitized
name was computed and then discarded, so the join built
`.manual/inbox/.manual/inbox/x.md`, and `acceptAndVerify` read the candidate text
through it, which is why an accepted proposal recorded no candidate body and a
later revert lost the file. Neither bug is reachable from the test suite, which
always passes bare filenames.

**D. Reverting a whole-claim accept deleted the claim and the argument for it.**
Correct about the claim (it had no predecessor), silent about the candidate: the
journal stored the diff and the reason but not the candidate text, so a revert
left nothing to review or re-apply. The journal now carries the candidate text
and a revert puts it back in the inbox.

**E. One test can be the whole runtime, and nothing knew.** On this repo's own
suite the diagnosis is blunt: 140 tests, 103s of test time, and
`"detects recent owned branches, ignores stale ones and other handles"` at 7.0s
— 6.8% of the total, while the suite's *wall* time is 20s. A bound derived from
the suite total is a bound on one test's mood. That is now parsed out of TAP and
spec output, recorded with each run, named in the diagnosis, and written into
the proposal the human reads.

### Scale, measured rather than asserted

| what | express (214 files, 1 claim) | 500 synthetic claims |
|---|---|---|
| `doctor` | 0.4s | 98ms |
| `graph` | 0.3s | — |
| `brief <file>` | 0.2s | 66ms |
| `verify --force` | 0.2s (nothing runnable) | 309ms |
| `verify` (warm, digest skip) | — | 71ms |

The synthetic numbers hold because evidence digests are deduped per spec and
parsed claims are stat-cached. The honest limit is not claim count, it is
*check cost*: one claim running a real repo's test suite dominates any verify it
participates in, and `max_ms` is the only scheduling control that exists.

### Still open

- **Prerequisites** (finding 5): a real repo needs `npm ci` or a build before a
  command check can pass at all. A `requires:` field or a once-per-sandbox setup
  step is the missing concept, and without it the first accepted claim on a
  fresh clone can only ever be broken.
- **Scheduling** (finding 7): no per-claim schedule, so a minutes-long suite and
  a 1ms `exists()` check compete in the same verify.
- **Manual size** (finding 6): `init` produces one or two claims on a real repo.
  Growing from 2 to 50 is still human work — the tool's value scales with a
  manual it cannot yet help you write.
