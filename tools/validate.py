"""Validate a .nha package against everything the device will check, and more.

Run in CI on every PR. The rule is simple: if this passes, the device must
accept the package. Anything the firmware refuses has to be refused here too,
with a message that says why -- the device's own errors arrive far too late and
say far too little.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from opset import (  # noqa: E402
    APP_ID_RE,
    CAPABILITIES,
    FEATURE_FIELDS,
    MAX_EVENT_NAME,
    MAX_NODES,
    MAX_PACKAGE_BYTES,
    OPS,
    RESERVED_APP_IDS,
    graph_cost_us,
    graph_memory_bytes,
    min_os_for,
)


SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
MIN_OS_RE = re.compile(r"^v?\d+\.\d+\.\d+$")
MANIFEST_REQUIRED = ("id", "name", "version", "author", "summary")
# A package's flow graph is read with the same flat key scan the firmware uses,
# so a manifest field named like a top-level key would shadow it.
MANIFEST_FORBIDDEN_KEYS = {"nodes", "kind", "nhapp"}

# The cell count a package is judged against. 15x15 is the largest board.
DEFAULT_CELL_COUNT = 225


class PackageError(Exception):
    pass


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise PackageError(code)


def validate_manifest(manifest: dict) -> None:
    for key in MANIFEST_REQUIRED:
        _require(bool(str(manifest.get(key) or "").strip()), f"missing_manifest_field:{key}")

    app_id = str(manifest["id"])
    _require(bool(APP_ID_RE.match(app_id)), f"invalid_id:{app_id}")
    _require(app_id not in RESERVED_APP_IDS, f"reserved_id:{app_id}")

    _require(bool(SEMVER_RE.match(str(manifest["version"]))), f"invalid_version:{manifest['version']}")
    if "min_os" in manifest:
        _require(bool(MIN_OS_RE.match(str(manifest["min_os"]))), f"invalid_min_os:{manifest['min_os']}")

    for key in MANIFEST_FORBIDDEN_KEYS:
        _require(key not in manifest, f"manifest_key_shadows_package_key:{key}")

    caps = manifest.get("capabilities", [])
    _require(isinstance(caps, list), "capabilities_must_be_a_list")
    for cap in caps:
        _require(cap in CAPABILITIES, f"unknown_capability:{cap}")


def validate_graph(nodes: list, manifest: dict) -> dict:
    _require(isinstance(nodes, list), "missing_nodes")
    _require(len(nodes) > 0, "empty_graph")
    _require(len(nodes) <= MAX_NODES, f"too_many_nodes:{len(nodes)}>{MAX_NODES}")

    caps = set(manifest.get("capabilities", []))
    for index, node in enumerate(nodes):
        _require(isinstance(node, dict), f"node_not_an_object:{index}")
        name = str(node.get("op") or "")
        _require(name in OPS, f"unknown_op:{name}")
        op = OPS[name]

        # Inputs may only reference EARLIER nodes -- that is what makes a cycle
        # unrepresentable and the array order a valid evaluation order.
        refs = [node.get("in")] if op.inputs == 1 else node.get("in", [])
        if op.inputs == 0:
            _require("in" not in node, f"unexpected_input:{name}")
        else:
            if op.inputs > 1:
                _require(isinstance(refs, list) and len(refs) == op.inputs,
                         f"expected_{op.inputs}_inputs:{name}")
            for ref in refs:
                _require(isinstance(ref, int), f"missing_input:{name}")
                _require(0 <= ref < index, f"input_out_of_order:{name}@{index}")

        for key in op.required:
            _require(key in node, f"missing_field:{name}.{key}")

        if name in ("emit", "emit_value"):
            event = str(node.get("event") or "")
            _require(bool(event), "missing_event_name")
            _require(len(event) <= MAX_EVENT_NAME, f"event_name_too_long:{event}")
            _require("emit_event" in caps, "capability_not_declared:emit_event")
        if name == "led":
            _require("drive_led" in caps, "capability_not_declared:drive_led")
        if name == "feature_get":
            field = str(node.get("field") or "")
            _require(field in FEATURE_FIELDS, f"unknown_feature_field:{field}")
            _require(str(nodes[node["in"]].get("op")) == "features",
                     "feature_get_input_must_be_features")
        if op.sweep:
            _require("read_matrix" in caps, "capability_not_declared:read_matrix")
        if op.window_key:
            window = node.get(op.window_key)
            _require(isinstance(window, int) and 1 <= window <= 128,
                     f"invalid_window:{window}")

    declared_min_os = str(manifest.get("min_os") or "v1.0.0").lstrip("v")
    needed_min_os = min_os_for(nodes).lstrip("v")
    _require(declared_min_os >= needed_min_os,
             f"min_os_too_low:declares_v{declared_min_os}_needs_v{needed_min_os}")

    return {
        "nodes": len(nodes),
        "estimated_us": graph_cost_us(nodes, DEFAULT_CELL_COUNT),
        "memory_bytes": graph_memory_bytes(nodes),
        "min_os": min_os_for(nodes),
    }


def validate_package(doc: dict, raw: bytes | None = None) -> dict:
    _require(isinstance(doc, dict), "not_a_package")
    _require(doc.get("nhapp") == 1, f"unsupported_package_version:{doc.get('nhapp')}")
    _require(str(doc.get("kind") or "flow") == "flow", f"unsupported_kind:{doc.get('kind')}")

    manifest = doc.get("manifest")
    _require(isinstance(manifest, dict), "missing_manifest")
    validate_manifest(manifest)
    report = validate_graph(doc.get("nodes"), manifest)

    if raw is None:
        raw = canonical_bytes(doc)
    _require(len(raw) <= MAX_PACKAGE_BYTES, f"package_too_large:{len(raw)}>{MAX_PACKAGE_BYTES}")

    report.update({"id": manifest["id"], "version": manifest["version"], "size": len(raw)})
    return report


def canonical_bytes(doc: dict) -> bytes:
    """Byte-exact serialisation, so a rebuild of an unchanged app is a no-op."""
    return (json.dumps(doc, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate .nha packages")
    parser.add_argument("paths", nargs="*", type=Path)
    args = parser.parse_args(argv)

    paths = args.paths or sorted(Path("apps").glob("*/app.nha"))
    if not paths:
        print("no packages found", file=sys.stderr)
        return 1

    failed = 0
    for path in paths:
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            report = validate_package(doc, canonical_bytes(json.loads(path.read_text())))
        except PackageError as exc:
            print(f"FAIL {path}: {exc}")
            failed += 1
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL {path}: unreadable: {exc}")
            failed += 1
        else:
            print(f"  ok {path}: {report['id']} v{report['version']} "
                  f"{report['nodes']} nodes, ~{report['estimated_us']}us, "
                  f"{report['size']}B, needs {report['min_os']}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
