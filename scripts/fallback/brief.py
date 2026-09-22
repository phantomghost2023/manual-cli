#!/usr/bin/env python3
"""Node-free brief: the session-brief half of the python fallback.

`verify.py --brief` prints the same thing; this wrapper exists so the two
halves are discoverable as a pair on hosts that have neither Node nor any
reason to run a verify — reading a manual must not require the tool that
wrote it.

Usage:
  python3 scripts/fallback/brief.py [--root DIR] [--budget CHARS] [FILE ...]
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify as fallback_verify  # noqa: E402


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass
    ap = argparse.ArgumentParser(description="Node-free brief from a manual-cli manual")
    ap.add_argument("--root", default=".")
    ap.add_argument("--budget", type=int, default=2000, help="max characters of brief to print")
    ap.add_argument("files", nargs="*", help="files in play; claims whose applies_to matches are shown")
    args = ap.parse_args(argv)
    root = os.path.abspath(args.root)

    if not os.path.isdir(os.path.join(root, fallback_verify.MANUAL_DIR, "claims")):
        print(f"no manual at {root}/.manual — nothing to brief", file=sys.stderr)
        return 2

    print(fallback_verify.brief(root, args.files, budget=args.budget))
    return 0


if __name__ == "__main__":
    sys.exit(main())
