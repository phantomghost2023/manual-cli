# Contributing to manual-cli

## Principles

1. **Evidence over opinion.** A claim without an executable check is a candidate, not a claim. The same standard applies to this repo: behavior changes need a test that fails first.
2. **Kinds change semantics.** Adding a new claim `kind` changes what `broken` means — it must be added to `KINDS` in `src/claims.js`, the interpretation matrix in `src/runner.js`, and the icon maps. Unknown kinds are rejected loudly by design.
3. **Zero dependencies.** Node stdlib only, Node >= 20. If you need a library, you need a reason.
4. **Stamps are machine state, not truth.** `state.json` is gitignored; never commit it; never let verify output become an API.

## Setup

```bash
git clone <repo> && cd manual-cli
npm test          # 51+ tests, no install step
```

## Layout

```
src/
  yaml.js       minimal YAML subset parser (double-quote = escapes, single = literal)
  claims.js     loader + validation (filename MUST equal <id>.md)
  hash.js       evidence digests (file globs, salted env, runtime versions)
  sandbox.js    git worktree + dirty/untracked overlay; strips NODE_TEST_CONTEXT
  runner.js     check execution, kind-aware interpretation, tier promotion
  verify.js     orchestration: topo order, dep gating, digest/TTL skipping
  diff.js       CI diff selection + dependency closure
  brief.js      token-budgeted briefing
  enforce.js    policy gates
  observe.js    flywheel proposals
  doctor.js     manual health
  init.js       discovery + scaffolding
  eject.js      vendoring for self-contained CI
  hooks.js      pre-commit installer
  history.js    manual-at-ref (bitemporal)
  mcp.js        MCP server (stdio JSON-RPC)
  watch.js      file-change re-verification
```

## Adding a command

1. Implement the core in `src/<cmd>.js` with the side-effect-free part exported for tests.
2. Wire CLI dispatch in `src/cli.js` (usage text + exit codes: 0 ok, 1 broken/suspect, 2 usage).
3. Tests in `test/` — temp-dir fixtures via `fs.cpSync('demo', ...)`, cleanup with `rmSync`.
4. Update `README.md` command table and `docs/manual.1.md`.
5. Add a `## [Unreleased]` entry in `CHANGELOG.md`.

## Claim-file changes

The manual/v1 schema is load-bearing for every repo using it. New fields must be additive (verifier warns on unknown fields, never errors) and need: parser support if nested, a `test/` case, and a CHANGELOG entry. Unknown `kind` values error loudly; unknown anything else warns.

## Testing notes

- The fuzz suite is seeded (mulberry32) — failures reproduce deterministically; include the failing input (first 80 chars) in your issue.
- Sandbox tests create real git repos in temp dirs; they skip nothing and clean up after themselves.
- Windows is a first-class platform (the project was built on it); use `path.join` and forward-slash normalization in glob land.

## Wild-repo canaries

Fixtures are tuned to the version that was current when they were written; wild repos are tuned to nothing. Every false-positive class the verifiers have fixed was invisible in fixtures and obvious in the wild, so changes to `src/verifiers.js`, `src/init.js` or `src/sandbox.js` deserve a drill: clone a real repo (see `docs/WILD-REPOS.md` for the matrix), install with the ecosystem's own tooling, then:

```bash
node test/wild.mjs builtin   --root <clone> --name <builtin> --expect ok|none
node test/wild.mjs lifecycle --root <clone>
```

`--expect none` pins a *correctly withheld* verdict (uv.lock, Cargo.lock); anything else must be `ok` on a healthy tree. The same matrix runs in CI (`.github/workflows/wild.yml`) on release and monthly — a red cell there means a false "no" landed, or upstream moved and the row needs its ref bumped.

## Brand images (hero + social preview)

Both cards derive from one design and must stay in sync with each other:

- `docs/hero.svg` — the README banner (1200×600, rounded corners allowed)
- `docs/social-preview.svg` → `docs/social-preview.png` — the GitHub social card (**exactly 1200×630**; GitHub crops anything else)

To regenerate after editing either SVG:

```bash
rsvg-convert -w 1200 -h 630 docs/social-preview.svg -o docs/social-preview.png
```

(Any renderer works — Inkscape, ImageMagick, a headless browser screenshot. `rsvg-convert` is what was used originally.) Then eyeball the PNG at card size before committing: zoom the browser out to ~40% and check the wordmark, the claim → check → verdict pipeline, and the verifier chips all stay legible. If you edit the hero, mirror any *content* changes (new commands, new ecosystems, new tiers) in the social SVG and re-render; the social card is the version other sites show, so a stale one mislabels the project everywhere links unfurl.

Uploading the social card is UI-only: open the repo's **Settings → General → Social preview** and drag in `docs/social-preview.png`. GitHub offers no API for this (deliberately requested many times; still true), so it cannot be automated — and the card is committed here precisely so the canonical bytes survive independent of that setting.

## Releasing

1. Bump version in `package.json`, move `[Unreleased]` → `## [x.y.z] - date` in CHANGELOG.
2. `npm test` green; `node bin/manual.js verify --force` green; `doctor` clean.
3. Tag `vx.y.z`. Publishing the release also fires the wild-repo canaries — watch the `wild` workflow run before trusting the release. (`npm publish` requires setting the `repository` field and npm auth — see issue tracker.)
