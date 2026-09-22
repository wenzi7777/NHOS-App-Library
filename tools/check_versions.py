"""Refuse a changed package that reuses its version number.

`<id>-<version>.nha` is treated as immutable: the Desktop client caches by that
filename and verifies the sha256 recorded in index.json. Editing a published
version in place would leave installed devices and cached clients disagreeing
about what that version is, with no way to notice.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout


def version_at(ref: str, path: str) -> str | None:
    blob = _git("show", f"{ref}:{path}")
    if not blob.strip():
        return None
    try:
        return json.loads(blob)["manifest"]["version"]
    except Exception:  # noqa: BLE001 - a malformed base is not this check's problem
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="origin/main")
    args = parser.parse_args(argv)

    changed = [
        line for line in _git("diff", "--name-only", f"{args.base}...HEAD").splitlines()
        if line.startswith("apps/") and line.endswith("/app.nha")
    ]
    failures = []
    for path in changed:
        before = version_at(args.base, path)
        after = json.loads((ROOT / path).read_text())["manifest"]["version"]
        if before is None:
            print(f"  new {path}: v{after}")
            continue
        if before == after:
            failures.append(f"{path}: still v{after}; published versions are immutable")
        else:
            print(f"  bump {path}: v{before} -> v{after}")

    if failures:
        print("\n" + "\n".join(failures), file=sys.stderr)
        return 1
    if not changed:
        print("  no package changes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
