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

### Third pass: a clone whose dependencies are not installed

Finding 5 above was the one that made adoption fail at step one, so the fix was
built and then pointed back at the same repo — this time at a fresh `git clone`
of express, with no `node_modules` at all.

```
$ manual init
probing discovered candidates before proposing them…
✔ probed init-tests.suite.md: fresh (19546ms)
1 candidate(s) needed a prerequisite first; the setup is declared in the file so verify can repeat it.

$ manual inbox accept init-tests.suite.md
proposal init-tests.suite.md: verified: fresh
verified: tests.suite is fresh
```

The candidate that discovery produced, and the states the same claim reports when
the machine changes under it:

```yaml
check:
  setup:
    run: npm install          # no lockfile in this repo; npm ci when there is one
    evidence: ["package.json"]
    cache: ["node_modules"]
  run: npm test               # scripts.test is `mocha --require …`
  expect: { exit: 0, max_ms: 120000 }
```

```
$ rm -rf node_modules && manual verify --force
  ⚙ setup: npm install (node_modules missing)
  ⚙ setup: ok (31714ms)
✅ tests.suite     fresh    26660ms          # install excluded from the measurement

$ manual verify --no-setup --force             # dependencies absent, setup declined
🚫 tests.suite     blocked  setup skipped — dependencies missing
exit=1 · tier silver, passes 1 — untouched: untested is not disproven

$ manual setup
✔ npm install  tests.suite
    setup-b6a38a7cb290b4c8 · cached — ran 2026-09-21T22:22:14.067Z (31714ms)
```

Every bug below was found by running that sequence, and each one was in the path
a new user takes on their first real repository.

**F. The check ran the script body, which cannot run outside `npm run`.**
`scripts.test` here is `mocha --require test/support/env …`, and `mocha` lives in
`node_modules/.bin` — a directory npm puts on `PATH` and a plain shell does not.
So the probe installed dependencies successfully (36.9s, cache entry `ok: true`)
and *then* reported `exit 127`: a successful install followed by "broken" reads
as a failing test suite. Discovery now runs a script whose first word is a local
binary through the package manager's own entry point, and says so in both the
statement and the note, so the claim's prose and its check cannot drift apart
again. The same reason motivated prepending dependency `bin` directories to
`PATH` in the sandbox: a hand-written `mocha test/` claim has the same right to
work.

**G. The probe gave every suite twenty seconds.** The first attempt after the
install fix still said `broken (exit null)` — the process had been killed, not
failed. `exit null` is a timeout masquerading as a verdict, and on a suite that
takes 26s under load it is guaranteed. The probe now waits at least as long as
the claim's own `max_ms`, because a false "broken" during discovery costs more
than a slow one.

**H. Verifying twice emptied `node_modules`.** The worst bug of the three, and
the least visible: the first verify linked the installed tree into its worktree,
and the teardown's recursive delete **followed the junction into the target**,
leaving `node_modules` present, on disk, and empty. The sandbox looked healthy
and the repository was broken afterwards — in the developer's own checkout, from
a read-only-looking command. Two verifies in a row in the test suite surfaced it
(the second reported the dependency the first had installed as missing). The
sandbox now removes the links it created before the worktree is deleted, and a
test asserts the installed tree survives a verify.

Re-run with prerequisites promoted to the repository (one `node` step in
`manual.yaml`, candidates saying `requires: node`), the same clone behaves the
same way and says more: `manual setup` prints `✔ node → npm install  tests.suite`
with the run it is reusing, `verify --force` after deleting `node_modules` prints
`⚙ setup: npm install (node_modules missing) → ok (17440ms)` and then measures
the suite at **20228ms** (the install excluded), and `--no-setup` names the step
in the failure — `node: npm install` — rather than "setup failed". Two named
prerequisites in one claim (an install per ecosystem, ordered, deduped, inline
step last) are proven by fixture rather than by a second real clone: two real
installs is minutes of network per run, and the ordering rule is not what a
second download would test.

**I. A gate that passed a policy it never ran.** `enforce` treated only
`broken` as a failure, so a policy that reported `blocked` — an unfresh
dependency, and now a prerequisite that could not be installed — passed the
pre-commit gate silently. It is the same shape as finding A (`verify --json`
reporting success and persisting nothing): the exit code is right, the output is
right, and nothing was checked. Every non-fresh state fails a gate now.

## Fourth pass: the verifier, on a real dependency tree

Same clone of `expressjs/express` (403 packages, 1261 tests, ~15s suite). The
feature under test was "a satisfied install is verified, not just remembered" —
and this pass is mostly the story of how the first attempt at it lied.

```console
$ manual setup --plan
prerequisite plan — 1 step(s), 1 claim(s), in the order a full verify runs them

  1. node → npm install  tests.suite  will run
       re-checked with: builtin:lockfile

0 satisfied, 1 to establish — verify pays for each once, in this order.
```

**J. A builtin verifier declared in `manual.yaml` was silently run as a shell
command.** The symptom was a `broken` claim one run and a reinstall on every
verify afterwards:

```console
⚙ setup: npm install (cached install distrusted — verify: bash: line 1: builtin:lockfile: command not found)
⚙ setup: npm install (rebuilding the distrusted install)
```

A normalized spec carries `verifyBuiltin` *and* `verify: "builtin:lockfile"`,
and resolution normalizes a spec a second time — which re-derived the builtin
from that string. The design deliberately cannot do that (the map form exists so
that a bare word is never ambiguous), so the verifier became a command that does
not exist: exit 127, distrust, reinstall, every time. The suite caught nothing,
because the tests hand-built their specs with a single normalization; the real
repo did it in one run. After the fix, a complete tree is reused and the whole
verify is 20.1s of suite with no install line at all.

**K. "No" and "cannot tell" were the same answer.** Express ships `.npmrc` with
`package-lock=false` — it does not commit a lockfile, and `npm install` does not
generate one — so `builtin: lockfile` had nothing to compare against and returned
`ok: false`. On that repository every verify would have reinstalled, for a
legitimate reason. A verifier now answers three ways, and "cannot tell" is not a
reason to rebuild: the plan and `manual setup` report it (`⚠ builtin:lockfile
cannot run here: no package-lock.json or npm-shrinkwrap.json in this checkout`)
rather than letting an unverifiable tree read as a verified one. Worth stating
plainly, since the whole feature rests on it: **the lockfile builtin is only as
good as the lockfile's provenance.** On the express clone the 101KB
`package-lock.json` the comparison ran against was generated by hand
(`npm install --package-lock-only`), because the repository has none; a tree
cannot be "verified against" an artifact the repo's own install will never
produce or maintain.

**L. What the layers can and cannot see, measured.**

```console
$ rm -rf node_modules/mocha/node_modules      # top level of node_modules untouched
$ manual setup --plan
  1. node → npm install  tests.suite  satisfied here (re-checked with builtin:lockfile before use)
$ manual verify --force
  ⚙ setup: npm install (cached install distrusted — verify: 3/403 installed package(s) missing, e.g. node_modules/mocha/node_modules/brace-expansion)
  ⚙ setup: npm install (rebuilding the distrusted install)
  ⚙ setup: ok (24780ms)
✅ tests.suite  fresh  27001ms
```

The witness — the immediate entries of `node_modules`, hashed and counted —
cannot see this, and said so honestly in the plan ("satisfied here") because the
plan deliberately does not pay for a verifier. That is the whole argument for
having a third layer, in one output. The same deletion against a spec with no
`verify:` stays trusted, which is why the layer is worth declaring. Measuring the
builtin itself: **64ms** on this tree against **10.9s** for `npm ls --depth=0` —
the command everyone reaches for is 170x too slow to run on every verify, which is
why the check that answers the question was not being run at all.

**M. Borrowing, on a second real clone.** The same repository cloned again, with
the same evidence content and nothing installed:

```console
$ manual setup --plan
  1. node → npm install  tests.suite  can be borrowed
$ manual verify --force
  ⚙ setup: npm install — borrowed from ...\express-org (verified there, never installed here)
✅ tests.suite  fresh  15089ms
```

16.3s end to end, none of it an install, against 43.0s the same clone took to
install for itself minutes earlier. Two honest caveats: the borrow only happened
after the two checkouts held byte-identical evidence (the first attempt said
`will run`, correctly — one clone's lockfile was the hand-made one and the
other's was absent), and the store is a machine-wide file keyed by platform +
command + evidence content, so it is a shortcut for *this* machine, not a
distributed artifact cache. The source tree is re-verified at the moment of
borrowing: delete `node_modules/fake-dep` (fixture) or a nested subtree (real
repo) and the next checkout installs for itself instead of inheriting the damage.

**N. A `broken` verdict on the first real run, that a reinstall fixed.** Before
any of the above, the first `manual verify` on this clone ran `npm install`
(30.6s) and then reported the claim `broken` — exit 1 after 40.0s — while
`npm test` in the same checkout passed 1261 tests in 11s. The next run, after a
reinstall, was `fresh` in 13.9s. We did not establish which of the two it was
(a 30s `npm install` over an existing tree leaving it in a state the suite fails
in, or something environmental in that first sandboxed run), and the honest
finding is the one that does not depend on the answer: **a check that fails once
and passes after an install is exactly the case a marker-only cache cannot
distinguish from a real breakage** — and the install in between was forced by
finding J, i.e. by accident. With the verifier fixed, the same clone has been
`fresh` on every run since.

### Still open

- **Prerequisites** are first-class and now belong to the repository rather than
  to each claim (`setup:` in `manual.yaml`, referenced with `check.requires`), so
  two ecosystems cost two installs once, not one per claim. What is still open is
  *scheduling* them: they run at most once per verify, but a 30s install and a
  1ms `exists()` check still share one window, and nothing can say "install this
  hourly, run that on every commit".
- **Scheduling** (finding 7): no per-claim schedule, so a minutes-long suite and
  a 1ms `exists()` check compete in the same verify. An install that takes 30s
  now sits inside that same window, which makes the case stronger, not weaker.
- **This repo's own bound is now tight, and the evidence says so.** The setup
  tests added a git worktree and several sandboxed verifies, so `npm test` here
  went from ~38s to ~76s against a 120s `max_ms` — with a busy machine already
  producing a 100s run. The inbox proposal to tighten `tests.suite` to 69s was
  written before any of this existed and is now actively wrong; `doctor` flags it
  as stale and recomputes what the recorded tail would support, which is the tool
  telling on itself. Relaxing the bound is a human
  decision, and the honest note is that the feature which makes installs cheap
  made the suite that proves it expensive.
- **Manual size** (finding 6): `init` produces one or two claims on a real repo.
  Growing from 2 to 50 is still human work — the tool's value scales with a
  manual it cannot yet help you write.
- **The order is computed, but nothing schedules it.** `requires` edges give a
  correct sequence for the steps a verify needs (and `setup --plan` prints it),
  but the plan is still derived from the claims that happen to be in the manual:
  a prerequisite only one candidate references is invisible until that candidate
  is accepted, and two independent installs still share one window. "Install
  hourly, build on commit, run this spec on demand" remains unexpressed.
- **Verification of a shared tree is per checkout, not per tree.** The store
  records where an install was verified and re-checks it on borrow (finding M),
  but two checkouts linked to the same `node_modules` can each hold an entry
  describing the same directories; a mutation in one is not pushed to the other's
  record, so the second checkout's next verify is what catches it. A global tree
  registry (with a lockfile digest per *tree*, not per checkout) would close it.
- **A verifier per ecosystem was hand-written, and the tri-state result (finding
  K) was the interface to build the rest against** — done for npm, pnpm, Python
  virtualenvs, Bundler, Go modules and Cargo in the fifth pass below, which also
  shows what a builtin may *not* claim. Yarn, bun, pipenv and uv are still
  uncovered, and uv's gaps are reported rather than judged.

## Fifth pass: the same question, in six ecosystems

> Superseded by the sixth pass, below, which added the last two Node package
> managers and the `--check-files` finding that changed `init`.

Probed on 2026-09-21, on Windows, against real trees rather than fixtures: an npm
11 project with a nested dependency, a pnpm 11 project, a `python -m venv` with
two distributions, a vendored `bundle install` (bundler 2.6.9, rake 13.4.2), a Go
module with two requires in a scratch `GOMODCACHE` (go 1.25.3), and a crate
fetched into a scratch `CARGO_HOME` (cargo 1.90). Each was driven through
`manual init` / `setup` / `verify`, damaged on disk, and verified again.

- **The question this release turned on: can the declared command repair what the
  verifier reports?** Measured, not assumed. Deleting
  `node_modules/is-odd/node_modules/is-number` and running `npm ci` restores it.
  Deleting `.venv/Lib/site-packages/six-1.16.0.dist-info` and running the
  declared `python -m venv … && … pip install -r requirements.txt` restores it
  (8.7s). Deleting
  `vendor/bundle/ruby/3.4.0/specifications/rake-13.4.2.gemspec` and running
  `bundle install` restores it (3.4s). Deleting
  `$GOMODCACHE/github.com/google/uuid@v1.6.0` together with its `.ziphash` and
  running `go mod download` restores both (0.3s). Where that holds, a builtin may
  say "no"; where it does not, saying "no" is a reinstall nobody can stop.
- **pnpm 11 fails that test, twice, and the field probe is what caught it.** A
  satisfied `pnpm install` leaves `node_modules/.pnpm/<pkg>` alone after the
  directory is deleted, and leaves a hand-modified `node_modules/.pnpm/lock.yaml`
  alone; `pnpm install --force` did not restore the copy either. Two reinstalls
  later the state was still there — the first version of this check judged it,
  and re-ran the install on every verify of a real repo. It now reports:
  `1/2 package(s) the lockfile lists are not in node_modules/.pnpm, e.g.
  is-number@6.0.0; node_modules/.pnpm/lock.yaml matches pnpm-lock.yaml — not a
  verdict: a satisfied pnpm install re-imports only when the lockfile itself
  changes`. The store check is still worth keeping: it sees a gap the top-level
  witness cannot, and it is the reason a *yes* is now a stronger statement than
  "the directory exists".
- **crates reports for a different reason.** The registry check found the missing
  crate at once (`1/1 crate(s) missing, e.g. itoa@1.0.18`), but `Cargo.lock` also
  covers dev-dependencies and target-specific crates that a plain `cargo build`
  never fetches, so a verdict would fail the same way pnpm's did. It says
  `not a verdict: Cargo.lock also covers dev-dependencies …` and leaves the tree
  alone; the run stays silent about nothing and loud about nothing it cannot
  prove.
- **A prerequisite written by `init` was platform-wrong.** It proposed
  `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, which
  cannot run on Windows at all — the interpreter is `python`, the scripts live in
  `.venv/Scripts`. Running `init` on the probe venv now writes
  `python -m venv .venv && .venv/Scripts/pip install -r requirements.txt` with
  `verify: { builtin: venv }`, and that command ran for real as part of the probe.
  On the same run `init` also proposed the prerequisite for a repo that had no
  virtualenv yet, which is the state a fresh clone is always in.
- **The verifier is the only layer that sees inside a tree.** Deleting a
  `dist-info` (venv), a `gemspec` (gems), a store directory (pnpm) or a module
  (go) leaves the declared `cache` directory's own listing unchanged, so the
  witness passes and the install stays trusted until a verifier looks. In every
  case the run printed the layer that caught it (`cached install distrusted —
  verify: …`) instead of a bare "rebuilt".
- **When a verifier could answer and declined, the verify path now says so** —
  `⚙ setup: pnpm install --frozen-lockfile — reused, not re-confirmed: 1/2
  package(s) …`. Without that line the third answer was invisible on exactly the
  path where a tree is reused, which makes "cannot tell" look like "fine".
- **`auto` is a question, and the plan prints its answer.** `builtin:auto →
  pnpm (matched pnpm-lock.yaml (declared evidence))` appeared in `setup --plan`
  on the probe repo before anything ran, and `cannot tell which ecosystem:
  package-lock.json, Cargo.lock are all here` is what a monorepo with two
  ecosystems gets — correct, and still a paper cut for whoever wrote `auto`
  expecting it to guess.
- **Still uncovered, and still honest about it.** Yarn (`yarn.lock`) and bun
  (`bun.lockb`) have no builtin, so `init` declares none for them rather than one
  that could only ever answer "cannot tell"; poetry's default virtualenv lives
  outside the checkout, where the venv builtin reports "no virtualenv to inspect"
  instead of guessing; and every builtin inherits the provenance of the lockfile
  it reads — a lockfile that was never committed, or hand-edited to match what is
  installed, verifies perfectly. The journal and the tier system are what cover
  that, not this.

## Sixth pass: the last two Node package managers, and a command that had to
## change shape

Both new builtins went through the same rule as pnpm and crates — *only say no
when the declared command repairs it* — and both times the rule changed what got
built. This was measured on a real yarn 1.22.22 clone, a real yarn 4.9.0
(corepack) clone and a real bun 1.2 clone, each damaged and repaired.

- **Classic yarn's integrity file says nothing about the tree, and that is the
  whole finding.** Delete `node_modules/is-odd` from a yarn 1 clone and
  `.yarn-integrity` still matches `yarn.lock`; `yarn install --frozen-lockfile`
  answers "Already up-to-date. Done in 0.20s" and leaves the package gone;
  `yarn install --force` (0.20s) and `yarn install --check-files` (0.21s, and it
  prints `[3/4] Linking dependencies...`) put it back. So the first version of
  the check — map versus lockfile, which is exactly yarn's own IntegrityChecker —
  reported `true` for a tree that could not `require('is-odd')`. The map check
  stayed (it *is* repaired: corrupt the map and a plain install re-links in
  0.2s), and on top of it the builtin now checks that the directories
  `topLevelPatterns` claims to have linked are on disk.
- **That finding changed `init`'s command, which is the interesting part.** A
  classic repo's discovered prerequisite is now `yarn install --frozen-lockfile
  --check-files`, so the missing-directory verdict is one the command repairs and
  the verify path self-heals in the same 0.2s a plain install would have wasted
  saying nothing. Berry rejects that flag outright (`Unknown Syntax Error:
  Unsupported option name ("--check-files")`), and does not need it: a plain
  `yarn install --frozen-lockfile` re-linked a deleted location in 155ms — so
  `yarnKind` decides which generation gets which command, and the two verdicts
  are allowed to differ because the two commands do.
- **One clone, three answers, all measured** (`manual verify` on the probe, with
  the flag in the declared command):

  ```console
  yarn: true  | 2 package pattern(s) present, matching yarn.lock; 1 linked directory present on disk | 2ms
  yarn (yarn install --frozen-lockfile):          null  | 1/1 top-level package(s) yarn linked are not in node_modules, e.g. is-odd (installed for is-odd@3.0.1) — not a verdict: a satisfied `yarn install` trusts .yarn-integrity and leaves them missing (measured: "Already up-to-date", 0.2s). `yarn install --check-files` (or `--force`) re-links them in the same 0.2s
  yarn (yarn install --frozen-lockfile --check-files): false | 1/1 top-level package(s) yarn linked are not in node_modules, e.g. is-odd …
  ```

  End to end through the lifecycle on that clone, the witness usually fires
  first — deleting a top-level package changes `node_modules`'s own listing — and
the run reads `⚙ setup: yarn install --frozen-lockfile --check-files (cached
install distrusted — witness: the declared directories changed since it ran)`,
  `(rebuilding the distrusted install)`, `ok (1109ms)`, claim `fresh`. The
  verifier is for the damage the witness cannot see: anything *inside* a package
  directory, a nested store, or a fresh checkout that arrived with a state file.
- **bun has two linkers and the check cannot be the same for both.** A fresh
  `bun install` on the probe produced a hoisted tree (no `.bun` at all), while
  `bun install --linker isolated` (and the `bun add` that created the lockfile)
  produced `node_modules/.bun/<name>@<version>/node_modules/<name>` plus a
  symlink farm. Hoisted: the lockfile key path (`node_modules/is-number`, and
  `node_modules/is-odd/node_modules/is-number` for a key that could not be
  hoisted) is the install, and deleting one — direct *or* transitive — was
  restored by `bun install --frozen-lockfile` in 33–42ms, so a missing entry is a
  verdict. Isolated: transitive packages have no top-level entry at all, so the
  store directory is the install, and bun does **not** rebuild a deleted one:
  `Checked 6 installs across 32 packages (no changes)` and it stayed gone (and in
  the earlier `bun add` tree, deleting `.bun/is-odd@3.0.1` produced
  `+ is-odd@3.0.1 / 1 package installed` — which restored only the *top-level*
  copy and left the farm symlink dangling). That is pnpm's case again, and it
  reports:

  ```console
  bun: true | 6 package(s) present, matching bun.lock (hoisted); 25 not checked (another platform or optional here, e.g. @esbuild/aix-ppc64) | 5ms
  bun: false | 1/6 installed package(s) missing, e.g. node_modules/is-odd        # hoisted — a plain install repairs this
  bun: null  | 1/6 package(s) bun.lock resolves have no directory in node_modules/.bun, e.g. node_modules/.bun/is-odd@3.0.1 — not a verdict: bun considers the install satisfied …
  ```
- **A wrong version is invisible to the isolated linker, and that is a feature.**
  The store directory embeds the version (`is-odd@3.0.1`), so a version that
  differs from the lockfile *is* a missing directory there. In the hoisted tree a
  `package.json` edited to `9.9.9` is reported rather than judged, because
  measured: `bun install` leaves an edited package.json alone (`+ 1 package
  installed` only when files are missing).
- **A bug the fixture found before a real repo did.** The reported paths were
  built with `path.join`, so on Windows the note read
  `node_modules\.bun\is-odd@3.0.1` — wrong for the thing the line is for, which
  is a human pasting it into a shell or a search. They are forward slashes now,
  and there is a test that would have caught them on any platform.
- **`init`'s classic/berry test read the wrong file.** The detection used a path
  relative to the process's working directory, so a classic lockfile was seen as
  modern whenever the tool was run from outside the repo, and the repo got the
  install command with no `--check-files` — the one shape that cannot repair a
  damaged tree. The verifier's answer depended on where you stood; the test that
  writes both generations caught it, which is the argument for testing the
  command and the check together rather than separately.
- **What is still open.** A classic yarn repo whose `topLevelPatterns` is absent
  (older 1.x) has its map checked and its directories not; nested packages under
  a hoisted classic yarn tree are only checked where the pattern maps to a
  top-level directory; a bun isolated tree that lost a store directory stays
  reported rather than repaired on every verify, which is honest but noisy on a
  repo somebody damaged by hand; and `bun.lockb` — still the only lockfile some
  repos have — remains unreadable by anything here.

## Seventh pass: a wild yarn 1 repo, and the bug that could only be found there

### The pickings changed

The obvious wild yarn-1 repos are gone: axios, mocha, and chalk all read
`package-lock.json` on `main` today. The wild migrates. react-router at
`v5.3.4` still ships the real thing — `yarn.lock` v1, 103 top-level packages, a
workspaces monorepo — so that is the repo this pass ran against, fresh clone,
nothing installed.

### Breakdown one: discovery proposed nothing at all

`init` on a monorepo discovered **zero** claim candidates on a repo with one of
the largest test suites in the ecosystem. The gate that decides whether a repo
has tests to discover checked exactly four root directories — `test`, `tests`,
`src`, `lib` — and a workspaces repo keeps its tests under
`packages/*/src` and `packages/*/test`. The root has none of them. A
workspaces declaration is itself evidence that packages with code exist, so it
now counts; a fixture with the v5 shape would have caught this before the wild
did.

### The registry flake the probe refused to lie about

The first install died at 317 seconds on
`ESOCKETTIMEDOUT ... registry.yarnpkg.com/rxjs/-/rxjs-6.5.3.tgz`. The probe
marked the candidate **blocked — "the claim is untested, not false"** — rather
than broken. The direct rerun completed in 142.7s. A flaky network is the
checkout's story, and the tool kept it out of the repository's.

### Breakdown two: the fresh-witness laundering (the one that mattered)

With the install cached and the declared command the plain
`yarn install --frozen-lockfile` (the command that *cannot* repair), deleting a
top-level package produced, on every later verify:

```
⚙ setup: yarn install --frozen-lockfile (cached install distrusted — witness: the declared directories changed since it ran)
⚙ setup: yarn install --frozen-lockfile (rebuilding the distrusted install)
⚙ setup: ok (1751ms)          # "Already up-to-date" — it repaired nothing
```

and the *next* verify — the one after the rebuild — said nothing at all, with
the package still missing from disk. The sequence: in-place damage trips the
witness before the verifier is ever consulted; the rebuild runs; the success
path records a fresh witness of the *damaged* tree; and the reused path now
trusts it. The verifier's `no` was architecturally unreachable — consulted
only on the reused path, always outrun by the witness on the damaged one. The
cache had learned to launder the exact damage the verifier exists to catch.

**The fix is a rule, not a patch: a successful run is not evidence of a
repaired tree.** Every run the cache records is now held to its own verifier
first; a `no` is a failed install — recorded untrusted, never a fresh witness.
The suite's regression test replicates the yarn shape (first run creates the
tree, satisfied runs are "Already up-to-date" no-ops) and asserts the witness
is *not* written for a tree the verifier called broken.

Two effects on the real repo, both correct:

- With the non-repairing command still declared, the missing package is now
  **reported on every verify** instead of being laundered after one rebuild:
  `⚙ setup: yarn install --frozen-lockfile — reused, not re-confirmed: 6/103
  top-level package(s) yarn linked are not in node_modules, e.g. react
  (installed for react@>=15) — not a verdict: a satisfied `yarn install`
  trusts .yarn-integrity and leaves them missing (measured: "Already
  up-to-date", 0.2s). `yarn …` — the message names the flag that fixes it.
- With `init`'s command (`--check-files`) restored, the same damage produces
  distrust → rebuild → **53.5s** → react back on disk → verifier confirms.

And the loop was demonstrated both ways on the wild repo: the tool reported a
laundered tree before the fix, and a self-healing one after it.

### Also true of this repo, stated plainly

- `yarn test` on this clone fails on Windows/Node 22 outside the tool too
  (jest 24 cannot resolve its glob project config here), so the accepted
  claim's `broken` is the repository's real story on this machine — complete
  with journal entry and undo token. The tool recorded a truth, not an error.
- One fixture bug during the fix was the tool's own doing: a generated script
  with a mangled escape made the *fixture* a SyntaxError, and the first
  debugging hour went to the implementation before the note
  (`verify: bash: -c: line 1: syntax error`) pointed at the test. The
  assertions that print `note:` now exist because of it.

## Eighth pass: a wild pnpm-12 monorepo, where every naming rule was wrong

vuejs/core is the heaviest pnpm checkout in the ecosystem — `pnpm-workspace.yaml`,
`packageManager: pnpm@12.4.2`, 660 lockfile entries, a suite that takes five
minutes. Every previous verifier assumption was tuned on pnpm 11 fixtures. The
drill found four false-positive classes, one parser bug, and one dishonest
stamp, in that order of discovery.

### What held up

- **report-not-judge itself.** The verifier never once said `no` falsely. Every
  wrong count came out as `not a verdict` with the evidence spelled out, which
  is why the tree stayed untrusted-but-unpunished while the bugs were found.
- **The blocked doctrine.** A probe killed at the 120s cap, an install whose
  registry flaked, a check that could not finish — all came out `blocked: the
  claim is untested, not false`, never `broken`.
- **The pnpm-11 measurements were real.** "A satisfied install re-imports only
  when the lockfile changes" reproduced exactly; the copy check just needed to
  understand what pnpm 12 writes into that copy.

### What broke, and the rule each fix teaches

1. **Peer suffixes defeat exact matching.** pnpm 11 named dirs
   `name@version`; pnpm 12 names them after the *snapshot* key —
   `vite@8.3.0_@types+node@24.1_7c905f…` — and truncates past 60 chars to
   `first27 + '_' + sha256(key)[:32]`. Proven before use: the recipe matched
   19/19 hash dirs and left zero store dirs uncovered on the real tree. The
   matching is exact again, derived from the lockfile's own spelling.
2. **A nested YAML key can hijack the parser.** `snapshots:` blocks indent
   `dependencies:` maps inside each entry; the key regex let four-space lines
   match, so `last` flipped to junk and the *next* flag line — the
   `optional: true` — landed on a key no package owned. `@emnapi/*` then looked
   missing on a freshly synced tree. Regexes that count spaces need to count
   them exactly.
3. **The package manager records itself.** `packageManager: pnpm@12.4.2`
   produces a lockfile entry for pnpm that never materializes in the project's
   store — it lives in pnpm's own home. Same family as platform binaries: a
   package that is not supposed to be here is not missing.
4. **pnpm 12 filters the recorded copy.** 645 of 660 entries — exactly the
   other-OS binaries dropped. Equality held on pnpm 11 (byte-for-byte) and
   fails on pnpm 12; the honest check is subset in both directions: every
   copied package must exist in the lockfile, and every package this machine
   must have must exist in the copy.

### The stamp bug that survived until the end

The suite claim stamped `broken exit ?` after a timeout. `exit null` was
already made legible by an earlier pass, but the *state* still judged: broken
means the check ran and said no. A check stopped by its bound never ran to a
verdict — it is `blocked`, with a note that names the bound and suggests
raising it. After the fix the wild repo's whole story reads honestly:

```
🚫 tests.suite   blocked  no exit within 120s — untested, not false;
                          raise max_ms if this check needs longer
```

and the built-in pnpm verdict went from `ok: null, 36/518 missing` on a freshly
synced tree to `ok: true, 489 present, 17ms`, with damage detection re-proven
after the fix (deleted `vite@8.3.0` → flagged; `pnpm install --frozen-lockfile`
→ restored, 16ms, `ok: true`).

## Ninth pass: three ecosystems, three false-positive classes, and a bound
## that measures itself

The pnpm drill earned a rule: every fixture is tuned on the repo it grew up
with, so only a wild repo can find a verifier's noise rate. This pass ran the
remaining Node builtins against wild repos the same way — install, probe,
damage, repair — and then the question vuejs/core's timeout had been asking
for three passes: who chose 120000?

### npm on npm/cli: presence is not completeness

npm/cli ships 1367 files of `node_modules` committed to git — no `.bin`, no
dev deps — so discovery's presence gate saw a tree, wired no prerequisite,
and the suite claim ran against an install that was never made (`tap` absent,
122 of 1181 packages on disk). Two fixes came out of it. The builtin gets the
last word when a tree exists — a definitive `ok: false` wires `requires`,
`ok: null` leaves discovery alone (only definitive evidence moves a claim).
And the npm verifier learned the platform rule pnpm and bun already had: its
20 "missing" packages were all `@typescript/typescript-<aix|darwin|freebsd|…>`
— entries every lockfile carries and no Windows machine ever materializes.
After: `ok: true, 1161 present, 20 platform skipped`; deleting
`node_modules/tap` named the package and its subtree; `npm ci` (305s, 761
packages) restored `ok: true`. The partial tree was never the tool's fault —
it was the repo's shape, which is exactly the kind of thing a presence gate
cannot see.

### yarn 1 held up; bun did not

yarn-wild: healthy tree zero false positives; `rm -rf node_modules/react`
reported `6/103 missing` rather than judging (transitive integrity gaps like
`invariant` stay disk-damage's documented job); `--check-files` (123s)
restored `ok: true`.

oven-sh/bun told a different story: with deps installed (6.6s), the isolated
verifier still read `3/23 missing` on a *healthy* store. All three existed —
as `@types+react-dom@18.3.7+52f32cb6c6aeed77`. bun 1.2 appends `+<hex>` to a
store directory when the package resolves peers, and exact `name@version`
matching can never hit a suffixed name. Matching now folds the suffix off —
raw name first, so a version carrying semver build metadata still matches
only itself. The verdict had honestly been `ok: null` the whole time —
report-not-judge contained the damage — but the *evidence* was false, and
false evidence still costs a reader trust. After: `ok: true` in 6ms; deleted
`typescript@6.0.2` → named, never judged; fresh `bun install` → `ok: true`.
False-positive rates across the three drills: npm 20/1181 → 0; yarn 1 0 → 0
(its known gap stayed a documented report, not a false yes); bun 3/23 → 0.

### The bound that measures itself

`blocked — no exit within 120s` had been asking who chose that number. Nobody
measured anything: init hardcoded it, and verify's config default (60s)
silently overrode it anyway — runCheck prefers an explicit timeoutMs, so a
claim's max_ms was decorative at stamp time and five-minute suites could only
ever block. The calibration loop closes both ends. Discovery writes no bound
for a command check; the probe waits up to 600s for an unmeasured one, and a
fresh run writes `max(120000, measured × 3)` rounded to seconds with
`observation.measured_ms` as provenance — fast suites keep the floor that
observe later tightens on evidence, slow suites get a bound that can hold
them. A run that never finishes gets the floor and says so; a run that exits
with failures gets the floor and says that. The probe also stopped
contradicting verify: a check stopped by its bound is `blocked` — untested,
not false — where the probe had been filing `broken`, and the probe's note
printed `120000s`, max_ms read as if it were seconds. verify now waits for
the claim's own bound (`checkTimeoutMs`), config default only when the claim
declares none.

Measured both ways: on vuejs/core the suite exits 1 on this machine (109
failed / 3758 passed — the repo's real Windows story), so the probe ran all
~293s inside the calibration window and correctly kept the floor: a failing
run never measured a healthy duration, and the note says exactly that. On a
passing slow fixture the same probe writes the real number and accept+verify
run inside it. What the window costs: a genuinely hanging check stalls init
600s instead of 120s — one honest cost paid once, against a lifetime of
blocked stamps.
