"""Regenerate dist/ and index.json from apps/.

Both outputs are checked in, so the raw GitHub URLs work with no build step and
a package diff is reviewable in the PR that introduces it. CI runs this with
--check and fails if the tree comes out dirty.

On download URLs: they point at `main`, not at a pinned commit sha, because the
sha that will contain an artifact does not exist at the time this script writes
the URL. Immutability is instead enforced where it can actually be checked --
`<id>-<version>.nha` is never rewritten (CI requires a version bump), and the
Desktop client verifies the sha256 recorded here before a package is allowed
anywhere near a device. A silently edited artifact fails that check.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compile import compile_file  # noqa: E402
from validate import DEFAULT_CELL_COUNT, canonical_bytes, validate_package  # noqa: E402
from opset import graph_cost_us  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]
RAW_BASE = "https://raw.githubusercontent.com/wenzi7777/NHOS-App-Library/main"
LOCALES = ("en", "ja", "zh-CN")


def _localised(value, fallback: str) -> dict[str, str]:
    """Accept a plain string or a per-locale map; always emit a full map."""
    if isinstance(value, dict):
        base = str(value.get("en") or fallback)
        return {locale: str(value.get(locale) or base) for locale in LOCALES}
    text = str(value or fallback)
    return {locale: text for locale in LOCALES}


def build_entry(app_dir: Path) -> dict:
    # The .nhs source is the artifact under review; app.nha is derived from it
    # and never hand-edited.
    doc, _ = compile_file(app_dir / "app.nhs")
    raw = canonical_bytes(doc)
    report = validate_package(doc, raw)
    (app_dir / "app.nha").write_bytes(raw)

    manifest = doc["manifest"]
    app_id = manifest["id"]
    version = manifest["version"]
    if app_id != app_dir.name:
        raise SystemExit(f"{app_dir}: manifest id {app_id!r} does not match the directory name")

    meta_path = app_dir / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}

    dist_dir = ROOT / "dist" / app_id
    dist_dir.mkdir(parents=True, exist_ok=True)
    artifact = dist_dir / f"{app_id}-{version}.nha"
    artifact.write_bytes(raw)
    (dist_dir / f"{app_id}-latest.nha").write_bytes(raw)

    readme_urls = {}
    for locale in LOCALES:
        name = "README.md" if locale == "en" else f"README.{locale}.md"
        if (app_dir / name).exists():
            readme_urls[locale] = f"{RAW_BASE}/apps/{app_id}/{name}"

    entry = {
        "id": app_id,
        "name": _localised(meta.get("name"), manifest["name"]),
        "summary": _localised(meta.get("summary"), manifest["summary"]),
        "version": version,
        "author": manifest["author"],
        "license": meta.get("license", "MPL-2.0"),
        "category": manifest.get("category", "other"),
        "capabilities": manifest.get("capabilities", []),
        "min_os": report["min_os"],
        "nodes": report["nodes"],
        "estimated_us": report["estimated_us"],
        "memory_bytes": report["memory_bytes"],
        "device_path": f"apps/{app_id}.nha",
        "package": {
            "url": f"{RAW_BASE}/dist/{app_id}/{app_id}-{version}.nha",
            "sha256": hashlib.sha256(raw).hexdigest(),
            "size": len(raw),
        },
    }
    if (app_dir / "icon.svg").exists():
        entry["icon_url"] = f"{RAW_BASE}/apps/{app_id}/icon.svg"
    if readme_urls:
        entry["readme_url"] = readme_urls
    if meta.get("homepage"):
        entry["homepage"] = meta["homepage"]
    return entry


def build_index() -> dict:
    app_dirs = sorted(d for d in (ROOT / "apps").iterdir() if (d / "app.nhs").exists())
    entries = [build_entry(d) for d in app_dirs]
    ids = [e["id"] for e in entries]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        raise SystemExit(f"duplicate app ids: {sorted(duplicates)}")
    return {
        "schema": 1,
        "product": "NHOS App Library",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cell_count": DEFAULT_CELL_COUNT,
        "apps": entries,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rebuild dist/ and index.json")
    parser.add_argument("--check", action="store_true",
                        help="fail if the working tree changes (CI)")
    args = parser.parse_args(argv)

    index = build_index()
    target = ROOT / "index.json"
    previous = json.loads(target.read_text()) if target.exists() else {}
    # generated_at changes on every run; comparing without it is what makes
    # --check mean "the content drifted", not "time passed".
    if {k: v for k, v in previous.items() if k != "generated_at"} == \
       {k: v for k, v in index.items() if k != "generated_at"}:
        index["generated_at"] = previous.get("generated_at", index["generated_at"])
    target.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"indexed {len(index['apps'])} app(s)")
    for entry in index["apps"]:
        print(f"  {entry['id']:<12} v{entry['version']:<8} {entry['nodes']:>2} nodes  "
              f"~{entry['estimated_us']:>4}us  {entry['package']['size']:>5}B  {entry['min_os']}")

    if args.check:
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "index.json", "dist"],
            cwd=ROOT, capture_output=True, text=True,
        ).stdout.strip()
        if dirty:
            print("\nindex.json / dist are out of date; run tools/build_index.py and commit:")
            print(dirty)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
