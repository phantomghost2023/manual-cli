# Wild-repo drills and canaries

A fixture is tuned to the library version that was current the day it was
written. A wild repo is not tuned to anything. Every verifier bug this project
has fixed was invisible in fixtures and obvious in the wild, so the builtins are
drilled against real repositories, and `.github/workflows/wild.yml` re-runs the
drills as canaries on every release.

The one rule the canaries enforce: **a healthy tree must never be reported as
unsatisfied.** `ok: null` ("cannot tell") is a pass — several lock formats
legitimately cannot answer, and withholding a verdict the evidence cannot back
is the tool working. `ok: false` on a tree the ecosystem's own installer just
produced is the bug class these canaries exist to catch.

## The drills, and what each one found

Each drill: clone a real repo, run the ecosystem's own installer, probe the
builtin, then damage the tree and check the builtin notices, then repair and
check it recovers.

| builtin | wild repo | healthy tree | false "missing" | what the drill changed |
|---|---|---|---|---|
| pnpm | vuejs/core | 489 pkgs, 66 ms | **0** (was **165**, 25%) | peer-suffix dir names, hash-truncated long dirs, nested-YAML parser hijack, pnpm listing itself |
| npm | npm/cli (commits a *partial* node_modules in git) | 1161 pkgs, 368 ms | **0** (was **20**, 1.7%) | other-platform binaries skipped; discovery consults the builtin when node_modules exists |
| yarn 1 | remix-run/react-router | 1750 patterns, 99 ms | **0** | nothing — clean from the start; transitive damage is the witness's job, reported `cannot-tell` |
| bun | oven-sh/bun | 23 pkgs, 1 ms | **0** (was **3**, 13%) | bun 1.2's `+<hex>` peer-variant store-dir suffix |
| venv | encode/httpx (requirements.txt) | 15 dists, 4 ms | **0** | nothing — but see the PATH hole below |
| venv | pallets/flask (uv.lock) | withheld (`ok: null`) | **0** — 38/84 "missing" correctly *not* judged | nothing; uv.lock does not mark group membership, and the verifier says so |
| gomod | spf13/cobra (vendored) | 5 pkg dirs, 2 ms | **0** | the vendor hole below |
| gomod | caddyserver/caddy (vendored, 787 pkg dirs) | 787 dirs, 379 ms | **0** (was: deleted package reported as present) | modules.txt is a manifest, not a tree — the disk is checked now |
| gomod | spf13/cobra (module cache) · caddyserver/caddy | 4 and 169 modules | **0** | nothing; indirect/graph-only requires read `.mod`, direct ones read source |

Damage tests ran in each drill: a deleted vendored package dir, a removed
distribution, a bogus `require` — each flagged by name, each repaired to
`ok: true` by the ecosystem's own installer.

Two failures were found *by* the lifecycle half of the canary rather than by a
verifier probe:

- **Discovery proposed nothing on a repo without package.json.**
  `manual init` on spf13/cobra printed "0 candidate(s)" on a repo with a test
  suite and a vendored tree — the tool shipped verifiers for eight ecosystems
  and proposed no claim about seven of them. `nonNodeSuites()` now reads go.mod,
  vendor/modules.txt, pyproject/requirements/uv.lock, and the test directories
  themselves, and `goInstall()` declares `go mod download` as a repository-level
  prerequisite (the one shared-location write discovery is willing to propose —
  see the comment on it for why a module cache clears that bar).
- **A repo's own virtualenv never reached PATH on Windows.**
  `sandbox.localBins()` listed only `.venv/bin`; Windows venvs keep executables
  in `.venv/Scripts`. On encode/httpx the 64-second install succeeded and the
  check still failed, because `python -m pytest` was answered by the system
  interpreter. Both spellings are on PATH now, and the canary exercises the
  prerequisite path end to end precisely so this class of failure cannot hide
  behind a pre-installed tree.

## The canary workflow

`.github/workflows/wild.yml` runs on release publish, monthly, and on demand:

- **builtin** — eight matrix cells, each cloning a wild repo, installing the
  tree the way the ecosystem does, and asserting `ok: true` (or, for uv.lock,
  that a verdict is correctly withheld). Fail = false "no" on a healthy tree,
  which is always this repo's bug.
- **lifecycle** — three matrix cells (Node, Go, Python) running the full
  `init` → probe → accept → `verify` path, with the install performed by
  verify's prerequisite machinery rather than the workflow. Discovery must
  propose something, nothing it proposes may verify `broken`, and each check
  must carry a measured bound.

Red cells fall into two kinds, and the log tells them apart: a false "no" or a
"0 candidates" is a bug here; a clone or install failure is upstream drift, and
the row needs its ref bumped or the repo replaced.

## Running a drill locally

```bash
git clone --depth 1 https://github.com/encode/httpx /tmp/py-wild
cd /tmp/py-wild && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
node test/wild.mjs builtin   --root /tmp/py-wild --name venv --expect ok
node test/wild.mjs lifecycle --root /tmp/py-wild
```

`--expect none` is the honest answer for a lock the verifier cannot judge
(e.g. flask's uv.lock). Exit code 1 always names what was violated.
