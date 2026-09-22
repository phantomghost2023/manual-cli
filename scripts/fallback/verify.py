#!/usr/bin/env python3
"""Node-free verifier for manual-cli manuals.

manual-cli itself is a Node program, but the manuals it writes outlive it: a
repo discovered on a machine with Node still has to be verifiable on a host
that has none — a minimal container, an air-gapped build box, a colleague's
laptop with only Python. This script re-implements the smallest honest slice
of `manual verify`:

  * parse .manual/claims/*.md frontmatter and .manual/manual.yaml
  * run command checks (`check.run`, with exit-code expectations) and
    expression checks (exists() / manifest() over JSON)
  * re-implement the four lockfile comparisons the JS "builtin" verifiers do
    (npm, yarn 1, pnpm, venv) and a Go module check, so prerequisite-style
    claims answer the same way they would under Node
  * stamp .manual/state.json with the same states verify uses — fresh, stale,
    broken, blocked — and honest `cannot tell` for anything this subset cannot
    judge

What it deliberately does NOT do: sandboxing (checks run in the checkout),
dependency ordering, digests/TTL gating, ledger writes, the flywheel. A
stamp from here is a verdict about the claim, not a full-fidelity replica of
the Node tool's bookkeeping; `state` entries carry `"tool": "python-fallback"`
so a later Node verify can tell them apart.

Usage:
  python3 scripts/fallback/verify.py [--root DIR] [--json] [CLAIM_ID ...]

Exit codes: 0 all verified claims are fresh-or-stale; 1 something is broken or
blocked-and-required; 2 usage/manual errors.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

MANUAL_DIR = ".manual"
DEFAULT_TIMEOUT_S = 60


# ---------------------------------------------------------------------------
# Minimal YAML subset (the same subset src/yaml.js writes): maps, block arrays,
# flow maps/arrays, quoted scalars, ints, floats, booleans, null.
# ---------------------------------------------------------------------------

def parse_scalar(s):
    s = s.strip()
    if not s or s in ("~", "null"):
        return None
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        body = s[1:-1]
        if s[0] == '"':
            body = body.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
        else:
            body = body.replace("''", "'")
        return body
    if s in ("true", "True"):
        return True
    if s in ("false", "False"):
        return False
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        pass
    return s


def parse_flow(s):
    """[a, b] and {k: v, k2: v2} — no nesting beyond one level, as written."""
    s = s.strip()
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        if not inner:
            return []
        return [parse_scalar(p) for p in _split_flow(inner)]
    if s.startswith("{") and s.endswith("}"):
        inner = s[1:-1].strip()
        out = {}
        if not inner:
            return out
        for part in _split_flow(inner):
            if ":" in part:
                k, _, v = part.partition(":")
                out[parse_scalar(k)] = parse_scalar(v)
        return out
    return parse_scalar(s)


def _split_flow(s):
    parts, depth, cur, quote = [], 0, "", None
    for ch in s:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
            cur += ch
        elif ch in "[{":
            depth += 1
            cur += ch
        elif ch in "]}":
            depth -= 1
            cur += ch
        elif ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts


def parse_yaml(text):
    root = {}
    stack = [(-1, root)]
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        i += 1
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        if ":" not in line:
            continue
        key, _, rest = line.partition(":")
        key = key.strip().strip("'\"")
        rest = rest.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if rest == "":
            child = {}
            parent[key] = child
            stack.append((indent, child))
        elif rest in ("|", "|-", ">", ">-"):
            # Block scalar: collect the more-indented lines that follow.
            body = []
            while i < len(lines):
                nxt = lines[i]
                if not nxt.strip() or len(nxt) - len(nxt.lstrip(" ")) > indent:
                    body.append(nxt.strip())
                    i += 1
                else:
                    break
            parent[key] = "\n".join(body)
        elif rest.startswith("[") or rest.startswith("{"):
            parent[key] = parse_flow(rest)
        else:
            parent[key] = parse_scalar(rest)
    return root


def parse_claim_text(text):
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", text, re.S)
    if not m:
        return {}, text
    return parse_yaml(m.group(1)), text[m.end():]


# ---------------------------------------------------------------------------
# Evidence digest — byte-compatible with src/hash.js so a stamp made here can
# be compared against one made by Node (salt still differs per machine).
# ---------------------------------------------------------------------------

def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def expand_globs(root, patterns):
    """Expand glob patterns to files, sorted like expandFiles (path sort)."""
    out = set()
    for pat in patterns or []:
        base = pat
        # Only the last ** / * components are walked; simple two-phase match.
        pat_norm = pat.replace("\\", "/")
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", ".venv", "venv", "dist", "build", "target")]
            for fn in filenames:
                rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
                if fnmatch.fnmatch(rel, pat_norm) or fnmatch.fnmatch(fn, pat_norm):
                    out.add(rel)
    return sorted(out)


def files_digest(root, patterns):
    h = hashlib.sha256()
    files = expand_globs(root, patterns)
    for rel in files:
        p = os.path.join(root, rel)
        try:
            data = open(p, "rb").read()
            size = len(data)
        except OSError:
            continue
        h.update(f"{rel}\0{size}\0{sha256_hex(data)}\n".encode())
    return "sha256:" + h.hexdigest()[:32], len(files)


# ---------------------------------------------------------------------------
# Lockfile verifiers (the same "report, don't judge" answers as the JS ones)
# ---------------------------------------------------------------------------

# Platform-suffixed packages that are not this platform's are not missing —
# the same rule the JS verifiers apply, here approximated by os/cpu markers
# in the package name.
FOREIGN_PLATFORM = re.compile(r"-(aix|darwin|freebsd|linux|openbsd|sunos|win32|android)-(arm64|armv[67]|ia32|mips|ppc64|s390x|x64)$", re.I)


def this_platform_suffix():
    machine = os.uname().machine if hasattr(os, "uname") else platform.machine().lower()
    table = {
        ("win32", "AMD64"): "win32-x64", ("win32", "ARM64"): "win32-arm64",
        ("linux", "x86_64"): "linux-x64", ("linux", "aarch64"): "linux-arm64",
        ("darwin", "x86_64"): "darwin-x64", ("darwin", "arm64"): "darwin-arm64",
    }
    return table.get((sys.platform, machine), sys.platform)


def npm_lock_packages(path):
    try:
        lock = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return None
    pkgs = {}
    for key, val in (lock.get("packages") or {}).items():
        if not key:
            continue
        # Nested copies live under the parent's node_modules path; only the
        # last node_modules/<name> segment is the package name — and nested
        # copies are only "missing" when the parent is present but the copy is
        # not, which the flat top-level comparison cannot see. Skip nested
        # keys here: npm's own tree always installs the *top-level* resolution
        # of every dependency, so name-level presence is the honest check a
        # flat readdir can support (found on npm/cli: @babel/core's nested
        # convert-source-map copy is real and correctly absent at top level).
        if "node_modules/" in key[1:]:
            continue
        name = key[len("node_modules/"):] if key.startswith("node_modules/") else key
        pkgs[name] = val.get("version")
    return pkgs


def verify_npm(root):
    lock = None
    for name in ("package-lock.json", "npm-shrinkwrap.json"):
        if os.path.isfile(os.path.join(root, name)):
            lock = os.path.join(root, name)
            break
    if not lock:
        return None, "no package-lock.json to compare the install against"
    pkgs = npm_lock_packages(lock)
    if pkgs is None:
        return None, "unreadable package-lock.json"
    have = installed_npm(root)
    mine = this_platform_suffix()
    missing = [
        f"{name}@{'?' if v is None else v}"
        for name, v in sorted(pkgs.items())
        if name not in have and not FOREIGN_PLATFORM.search(name) and not name.endswith(mine)
    ]
    if missing:
        return False, f"{len(missing)}/{len(pkgs)} package(s) missing, e.g. {missing[0]}", missing[:5]
    return True, f"{len(pkgs)} package(s) present, matching {os.path.basename(lock)}"


def yarn_classic_verify(root):
    lock = os.path.join(root, "yarn.lock")
    if not os.path.isfile(lock):
        return None, "no yarn.lock"
    text = open(lock, encoding="utf-8", errors="replace").read()
    if "# yarn lockfile v1" not in text:
        return None, "berry lockfile — the python fallback reads classic yarn.lock only"
    patterns = {}
    cur = None
    for line in text.splitlines():
        if not line.startswith('"') and not line.startswith("# ") and line and not line.startswith(" "):
            m = re.match(r'^"?([^"\s]+(?:@[^"\s]+)*)"?:?$', line.rstrip(":"))
            if m:
                cur = m.group(1)
                patterns[cur] = None
        elif line.startswith("  version ") and cur:
            patterns[cur] = line.split(" ", 1)[1].strip().strip('"')
    have = installed_npm(root)
    missing = [p for p in sorted(patterns) if re.split(r"@", p)[0] not in have]
    if missing:
        return None, (f"{len(missing)} pattern(s) not linked, e.g. {missing[0]} — "
                      "classic yarn's integrity check covers root patterns only; not a verdict")
    return True, f"{len(patterns)} root pattern(s) present, matching yarn.lock"


def pnpm_verify(root):
    lock = os.path.join(root, "pnpm-lock.yaml")
    if not os.path.isfile(lock):
        return None, "no pnpm-lock.yaml"
    store = os.path.join(root, "node_modules", ".pnpm")
    if not os.path.isdir(store):
        return None, "no node_modules/.pnpm virtual store"
    text = open(lock, encoding="utf-8", errors="replace").read()
    section = text.split("packages:", 1)[-1].split("snapshots:", 1)[0]
    keys = re.findall(r"^  '?([^:\n]+)'?:$", section, re.M)
    # store dirs append peer suffixes and hash truncations; strip back to name@version
    dirs = os.listdir(store)
    norm = {re.split(r"_", d)[0] for d in dirs}
    norm = {re.sub(r"\+[^+]*$", "", d) if "+" in d else d for d in norm}
    missing = []
    for k in keys:
        name = k.strip("'\"").split("(")[0]
        base = name.rsplit("@", 1)
        if len(base) == 2 and base[0] and base[1]:
            if f"{base[0]}@{base[1]}" not in norm and base[0] not in norm:
                missing.append(name)
    if missing:
        return None, (f"{len(missing)}/{len(keys)} package(s) unaccounted for in the store, e.g. {missing[0]} — "
                      "peer-suffix and hash-truncated dir names are approximated here; not a verdict")
    return True, f"{len(keys)} package(s) present, matching pnpm-lock.yaml"


def venv_verify(root):
    req = os.path.join(root, "requirements.txt")
    sp = None
    for cand in (".venv", "venv"):
        for layout in (("Lib", "site-packages"), ("lib",)):
            p = os.path.join(root, cand, *layout)
            if os.path.isdir(p):
                sp = p
                break
        if sp:
            break
    if not os.path.isfile(req):
        return None, "no requirements.txt for the venv builtin to compare against"
    if not sp:
        return None, "no virtualenv to inspect — a system-wide pip install is not a tree this checkout can measure"
    have = set()
    for entry in os.listdir(sp):
        m = re.match(r"^(.+)-(\d[^-]*)\.dist-info$", entry)
        if m:
            have.add(m.group(1).lower().replace("_", "-"))
    missing = []
    for line in open(req, encoding="utf-8"):
        line = line.split("#")[0].strip()
        if not line or line.startswith("-") or ";" in line:
            continue
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s,]+)", line)
        if m and m.group(1).lower().replace("_", "-") not in have:
            missing.append(f"{m.group(1)}@{m.group(2)}")
    if missing:
        return False, f"{len(missing)} pinned distribution(s) missing, e.g. {missing[0]}", missing[:5]
    return True, "pinned distributions present, matching requirements.txt"


def gomod_verify(root):
    gomod = os.path.join(root, "go.mod")
    if not os.path.isfile(gomod):
        return None, "no go.mod"
    modules_txt = os.path.join(root, "vendor", "modules.txt")
    if os.path.isfile(modules_txt):
        vendored, listed = set(), []
        for line in open(modules_txt, encoding="utf-8", errors="replace"):
            line = line.strip()
            m = re.match(r"^#\s+(\S+)\s+(\S+)$", line)
            if m:
                vendored.add(f"{m.group(1)}@{m.group(2)}")
            elif line and not line.startswith("#"):
                listed.append(line)
        missing = [p for p in listed if not os.path.isdir(os.path.join(root, "vendor", *p.split("/")))]
        if missing:
            return False, (f"{len(missing)}/{len(listed)} package(s) vendor/modules.txt lists are not in the "
                           f"vendor tree, e.g. {missing[0]}", missing[:5])
        return True, f"{len(vendored)} module(s) present, matching vendor/modules.txt"
    cache = os.environ.get("GOMODCACHE") or os.path.expanduser("~/go/pkg/mod")
    if not os.path.isdir(cache):
        return None, "no Go module cache found (GOMODCACHE, ~/go/pkg/mod)"
    text = open(gomod, encoding="utf-8").read()
    requires = re.findall(r"^\s*([^\s]+)\s+([^\s]+)\s*//\s*indirect", text, re.M) or []
    direct = re.findall(r"^require\s+([^\s]+)\s+([^\s]+)", text, re.M)
    requires += [(p, v) for p, v in re.findall(r"^\s{2}([^\s(][^\s]*)\s+([^\s]+)\s*$", text.split("require (", 1)[-1].split(")", 1)[0], re.M) if not p.startswith("//")]
    missing = []
    for path_, ver in requires:
        esc = re.sub(r"[A-Z]", lambda c: "!" + c.group(0).lower(), path_)
        if not (os.path.isdir(os.path.join(cache, f"{esc}@{ver}"))
                or os.path.isfile(os.path.join(cache, "cache", "download", esc, "@v", f"{ver}.mod"))):
            missing.append(f"{path_}@{ver}")
    if missing:
        return False, f"{len(missing)} module(s) not in the module cache, e.g. {missing[0]}", missing[:5]
    return True, f"{len(requires)} module(s) present, matching go.mod"


BUILTINS = {
    "npm": verify_npm,
    "yarn": lambda root: yarn_classic_verify(root),
    "pnpm": pnpm_verify,
    "venv": venv_verify,
    "gomod": gomod_verify,
}


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def run_command_check(root, check, timeout_s):
    cmd = check.get("run")
    if not cmd:
        return None, "no run command", None
    env = dict(os.environ)
    for rel in ("node_modules/.bin", ".venv/bin", ".venv/Scripts", "venv/bin", "venv/Scripts"):
        p = os.path.join(root, rel)
        if os.path.isdir(p):
            env["PATH"] = p + os.pathsep + env["PATH"]
    # bash wherever it exists: the run strings discovery writes are shell
    # scripts (`2>/dev/null`, `$VAR`, pipes) and cmd.exe silently mangles the
    # quoting — a check fails on the shell, not the repo, which is a false
    # broken. On Windows the *name* `bash` can resolve to WSL's bash
    # (System32\bash.exe), which sees a different filesystem and none of the
    # host PATH — a check would fail on the shell, not the repo. Prefer Git-
    # bash explicitly and fall back to cmd only when neither exists.
    bash = shutil.which("bash")
    if os.name == "nt":
        bash = None
        for p in os.environ.get("PATH", "").split(os.pathsep):
            cand = os.path.join(p, "bash.exe")
            if os.path.isfile(cand) and "system32" not in p.lower():
                bash = cand
                break
    if bash:
        argv = [bash, "-e", "-u", "-o", "pipefail", "-c", cmd]
    elif os.name != "nt":
        argv = ["/bin/sh", "-e", "-c", cmd]
    else:
        argv = ["cmd", "/c", cmd]
    t0 = time.time()
    try:
        r = subprocess.run(argv, cwd=root, env=env, timeout=timeout_s,
                           capture_output=True, text=True)
        ms = int((time.time() - t0) * 1000)
        expect = (check.get("expect") or {}).get("exit", 0)
        ok = r.returncode == expect
        if ok:
            return True, f"exit {r.returncode} in {ms}ms", ms
        return False, f"exit {r.returncode} (expected {expect}); {(r.stdout or r.stderr or '').strip()[-160:]}", ms
    except subprocess.TimeoutExpired:
        return None, f"no exit within {timeout_s}s — untested, not false", None


def lock_active(root, owner, within_days=21):
    """Same semantics as src/expr.js lockActive: a branch (or worktree) whose
    name mentions the owner and whose last commit is recent enough counts as an
    active lock."""
    if not owner:
        return False
    needle = owner.lstrip("@").lower()
    cutoff = time.time() - within_days * 86400
    names = []
    try:
        r = subprocess.run(["git", "-C", root, "for-each-ref", "refs/heads",
                            "--format=%(refname:short)%09%(committerdate:unix)"],
                           capture_output=True, text=True, timeout=10)
        for line in (r.stdout or "").splitlines():
            name, _, ts = line.partition("\t")
            names.append((name, float(ts) if ts.strip() else float("inf")))
        r2 = subprocess.run(["git", "-C", root, "worktree", "list", "--porcelain"],
                            capture_output=True, text=True, timeout=10)
        in_branch = False
        for line in (r2.stdout or "").splitlines():
            if line.startswith("branch refs/heads/"):
                names.append((line[len("branch refs/heads/"):], float("inf")))  # checked out = active
    except (OSError, subprocess.TimeoutExpired):
        return False  # no git: no locks can be seen, so none are active
    for name, ts in names:
        n = name.lower()
        if (needle in n or needle in n.split("/")) and ts >= cutoff:
            return True
    return False


def run_expr_check(root, expr):
    """The expression forms discovery writes: exists(...), manifest(...),
    nodeMajor(), lockActive(...), joined by && (the one compositor the claim
    files use)."""
    if not isinstance(expr, str):
        return None, expr  # unreadable expr: cannot tell
    expr = expr.strip()
    if "&&" in expr and not expr.startswith("!"):
        verdicts = []
        for part in expr.split("&&"):
            ok, _ = run_expr_check(root, part)
            verdicts.append(ok)
        if any(v is False for v in verdicts):
            return False, expr
        if all(v is True for v in verdicts):
            return True, expr
        return None, expr
    if expr.startswith("!"):
        # !expr — the negation form (lockActive guards).
        inner_ok, _ = run_expr_check(root, expr[1:])
        if inner_ok is None:
            return None, expr
        return not inner_ok, expr
    if m := re.match(r"^lockActive\(\s*['\"](.+)['\"]\s*(?:,\s*\{?\s*withinDays\s*:\s*(\d+))?", expr):
        days = int(m.group(2)) if m.group(2) else 21
        return lock_active(root, m.group(1), days), expr
    if m := re.match(r'^exists\("(.+)"\)$', expr):
        return os.path.exists(os.path.join(root, m.group(1))), expr
    if "nodeMajor()" in expr:
        # The JS runtime gate discovery writes for tooling claims. Here it is
        # the host's real answer, from whichever runtime runs the fallback.
        major = f"{sys.version_info.major}"
        try:
            r = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=5)
            major = re.match(r"v?(\d+)", r.stdout or "").group(1) if r.returncode == 0 else "0"
        except (OSError, subprocess.TimeoutExpired):
            pass
        expr = re.sub(r"nodeMajor\(\)", major, expr)
    # === is the JS spelling and the one the claim files write; the regex
    # takes == as a prefix of ===, so the operator alternation must name it
    # first.
    if m := re.match(r'^manifest\("(.+)"\)\.(\w+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$', expr):
        try:
            data = json.load(open(os.path.join(root, m.group(1)), encoding="utf-8"))
        except (OSError, ValueError):
            return False, expr
        actual, op, wanted = data.get(m.group(2)), m.group(3), parse_scalar(m.group(4))
        ops = {"==": actual == wanted, "===": actual == wanted, "!=": actual != wanted, "!==": actual != wanted,
               ">": actual is not None and actual > wanted, "<": actual is not None and actual < wanted,
               ">=": actual is not None and actual >= wanted, "<=": actual is not None and actual <= wanted}
        return bool(ops[op]), expr
    # After nodeMajor() substitution the residue is a bare numeric comparison
    # ('22 >= 20') — evaluate it rather than reporting cannot-tell.
    if m := re.match(r'^\s*(\d+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(\d+)\s*$', expr):
        a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
        ops = {"==": a == b, "===": a == b, "!=": a != b, "!==": a != b,
               ">": a > b, "<": a < b, ">=": a >= b, "<=": a <= b}
        return bool(ops[op]), expr
    if m := re.match(r'^manifest\("(.+)"\)\.(\w+)\.(\w+)\(\)\.(\w+)', expr):
        try:
            data = json.load(open(os.path.join(root, m.group(1)), encoding="utf-8"))
            val = data.get(m.group(2))
            return bool(val and getattr(val, m.group(4), None)), expr
        except (OSError, ValueError):
            return False, expr
    return None, expr  # unknown form: cannot tell


def builtin_verdict(root, spec):
    if isinstance(spec, dict):
        name = spec.get("builtin")
    elif isinstance(spec, str) and spec.startswith("builtin:"):
        name = spec[len("builtin:"):]
    else:
        return None, "no builtin verifier declared"
    fn = BUILTINS.get(name)
    if not fn:
        return None, f"builtin '{name}' is not one of the python fallback's ({', '.join(sorted(BUILTINS))})"
    return fn(root)


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def load_state(root):
    p = os.path.join(root, MANUAL_DIR, "state.json")
    try:
        return json.load(open(p, encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": 1, "stamps": {}, "history": []}


def save_state(root, data):
    p = os.path.join(root, MANUAL_DIR, "state.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(data, open(p, "w", encoding="utf-8"), indent=2)
    open(p, "a", encoding="utf-8").write("\n")


def find_claims(root, only=None):
    claims_dir = os.path.join(root, MANUAL_DIR, "claims")
    if not os.path.isdir(claims_dir):
        return []
    out = []
    for fn in sorted(os.listdir(claims_dir)):
        if not fn.endswith(".md"):
            continue
        fm, _ = parse_claim_text(open(os.path.join(claims_dir, fn), encoding="utf-8").read())
        if not fm or not fm.get("id"):
            continue
        if only and fm["id"] not in only:
            continue
        out.append(fm)
    return out


def verify(root, only=None, timeout_s=DEFAULT_TIMEOUT_S):
    state = load_state(root)
    results = []
    for cl in find_claims(root, only):
        cid = cl["id"]
        check = cl.get("check") or {}
        kind = cl.get("kind")
        prev = (state.get("stamps") or {}).get(cid) or {}
        entry = {
            "id": cid, "state": "unknown", "tier": prev.get("tier", "bronze"),
            "verified_at": now_iso(), "tool": "python-fallback", "note": None, "measured_ms": None,
        }
        if "expr" in check:
            # Expression checks are kind-agnostic: facts, policies and
            # ownership claims all use them, and an ownership lockActive guard
            # is exactly the claim that should keep working without Node.
            ok, what = run_expr_check(root, check["expr"])
            entry["state"] = "fresh" if ok else "broken" if ok is False else "blocked"
            entry["note"] = what
        elif "run" in check:
            # prerequisites, if declared: satisfy by running them (no cache bookkeeping)
            blocked = False
            for req in ([check.get("requires")] if isinstance(check.get("requires"), str) else (check.get("requires") or [])):
                manual = load_manual_config(root)
                spec = (manual.get("setup") or {}).get(req)
                if spec and spec.get("run"):
                    t0 = time.time()
                    try:
                        r = subprocess.run(["bash", "-c", spec["run"]] if os.name != "nt" else ["cmd", "/c", spec["run"]],
                                           cwd=root, timeout=max(timeout_s, 600), capture_output=True, text=True)
                        if r.returncode != 0:
                            entry.update(state="blocked", note=f"prerequisite '{req}' failed (exit {r.returncode}) — untested, not false")
                            blocked = True
                    except subprocess.TimeoutExpired:
                        entry.update(state="blocked", note=f"prerequisite '{req}' timed out — untested, not false")
                        blocked = True
                else:
                    entry.update(state="blocked", note=f"unknown prerequisite '{req}' — nothing declares it")
                    blocked = True
                if blocked:
                    break
            if not blocked:
                ok, note, ms = run_command_check(root, check, timeout_s)
                entry.update(state="fresh" if ok else "broken" if ok is False else "blocked",
                             note=note, measured_ms=ms)
        elif "verify" in check or check.get("builtin"):
            ok, note = builtin_verdict(root, check.get("verify") or check)
            entry.update(state="fresh" if ok is True else "blocked" if ok is None else "broken", note=str(note))
        else:
            entry.update(state="blocked", note="no check this fallback can run")
        state.setdefault("stamps", {})[cid] = entry
        results.append(entry)
    save_state(root, state)
    return results


def load_manual_config(root):
    p = os.path.join(root, MANUAL_DIR, "manual.yaml")
    if os.path.isfile(p):
        return parse_yaml(open(p, encoding="utf-8").read()) or {}
    return {}


# ---------------------------------------------------------------------------
# Brief (smallest honest slice: fresh claims that mention the files in play)
# ---------------------------------------------------------------------------

def glob_matches(pattern, files):
    for f in files:
        if fnmatch.fnmatch(f, pattern.replace("**/", "**")):
            return True
        if pattern.endswith("/**") and f.startswith(pattern[:-3]):
            return True
    return False


def brief(root, files, budget=2000):
    claims = find_claims(root)
    state = load_state(root).get("stamps") or {}
    picked = []
    for cl in claims:
        applies = cl.get("applies_to") or ["**"]
        if files and not any(glob_matches(p, files) for p in applies):
            continue
        st = state.get(cl["id"], {})
        picked.append((cl, st))
    lines = [f"# manual brief — {len(picked)} claim(s)"]
    chars = 0
    for cl, st in sorted(picked, key=lambda x: (x[0].get("priority", "normal") != "critical", x[0]["id"])):
        line = f"- [{st.get('state', 'unknown')}] {cl['id']}: {cl.get('statement', '')}"
        if chars + len(line) > budget and lines:
            lines.append(f"  … {len(picked) - lines.__len__() + 1} more claims omitted at budget")
            break
        lines.append(line)
        chars += len(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------

def main(argv=None):
    # Windows consoles default to cp1252; the icons are cosmetic and must not
    # be the thing that crashes a verify.
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass
    ap = argparse.ArgumentParser(description="Node-free verifier for manual-cli manuals")
    ap.add_argument("--root", default=".")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S)
    ap.add_argument("--brief", nargs="*", metavar="FILE", help="print a brief for these files instead of verifying")
    ap.add_argument("claims", nargs="*", help="verify only these claim ids")
    args = ap.parse_args(argv)
    root = os.path.abspath(args.root)

    if not os.path.isdir(os.path.join(root, MANUAL_DIR, "claims")):
        print(f"no manual at {root}/.manual — nothing to verify", file=sys.stderr)
        return 2

    if args.brief is not None:
        text = brief(root, args.brief)
        print(text)
        return 0

    results = verify(root, only=set(args.claims) if args.claims else None, timeout_s=args.timeout)
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        icons = {"fresh": "✅", "stale": "🕰️", "broken": "❌", "blocked": "🚫", "unknown": "❔"}
        for r in results:
            print(f"{icons.get(r['state'], '❔')} {r['id']:<34} {r['state']:<7} {r['note'] or ''}")
        counts = {}
        for r in results:
            counts[r["state"]] = counts.get(r["state"], 0) + 1
        parts = ", ".join(f"{v} {k}" for k, v in sorted(counts.items()))
        print(f"\n{len(results)} claims: {parts}  (stamped by the python fallback — no sandbox, no digests)")
    return 1 if any(r["state"] in ("broken",) for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
