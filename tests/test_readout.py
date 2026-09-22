"""Readout packages.

A readout renders in the operator's browser, so the property that matters most
is that it carries no code and can only READ. Everything else is presentation.
"""

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import readoutset  # noqa: E402
from validate import PackageError, canonical_bytes, validate_package  # noqa: E402


GOOD = json.loads((ROOT / "apps" / "sysmon" / "readout.json").read_text())


def mutate(**readout_changes):
    doc = copy.deepcopy(GOOD)
    doc["readout"].update(readout_changes)
    return doc


class SysmonTests(unittest.TestCase):
    def test_the_shipped_readout_validates(self):
        report = validate_package(copy.deepcopy(GOOD), canonical_bytes(GOOD))
        self.assertEqual(report["kind"], "readout")
        self.assertEqual(report["nodes"], 0)
        self.assertEqual(report["estimated_us"], 0)

    def test_it_fits_the_device_package_limit(self):
        # It is stored on the device like any other package, so it is bound by
        # the same 4096-byte parse buffer.
        self.assertLessEqual(len(canonical_bytes(GOOD)), 4096)

    def test_it_only_reports_what_the_device_measures(self):
        # The device has no per-task RAM accounting and no current sensor, so a
        # column for either would be invented. Guard against one creeping in.
        text = json.dumps(GOOD).lower()
        for invented in ('"field": "ram"', '"field": "power"', '"field": "energy"',
                         '"field": "watts"', '"field": "current_ma"'):
            self.assertNotIn(invented, text)


class ReadOnlyTests(unittest.TestCase):
    def assertRejects(self, doc, code_prefix):
        with self.assertRaises(PackageError) as ctx:
            validate_package(doc)
        self.assertTrue(str(ctx.exception).startswith(code_prefix),
                        f"expected {code_prefix}, got {ctx.exception}")

    def test_a_write_command_is_refused(self):
        # The point of the allowlist: a readout renders in a browser and must
        # not be a way to reconfigure someone's device.
        for command in ("file_write_begin", "app_uninstall", "reboot", "set_scan_timing",
                        "config_set", "app_install", "enter_maintenance"):
            with self.subTest(command=command):
                self.assertRejects(
                    mutate(sources=[{"id": "x", "command": command}]),
                    "readout_source_not_allowed",
                )

    def test_every_allowed_source_is_read_only(self):
        # Belt and braces: nothing in the allowlist should be a mutation.
        for command in readoutset.ALLOWED_SOURCES:
            with self.subTest(command=command):
                self.assertFalse(
                    command.startswith(("set_", "file_write", "file_delete")),
                    f"{command} mutates and must not be pollable",
                )
                self.assertNotIn(command, {"reboot", "enter_maintenance", "exit_maintenance",
                                           "app_install", "app_uninstall", "app_activate"})

    def test_a_readout_may_not_carry_a_graph(self):
        doc = copy.deepcopy(GOOD)
        doc["nodes"] = [{"op": "total"}]
        self.assertRejects(doc, "readout_must_not_declare_nodes")

    def test_a_flow_may_not_carry_a_readout(self):
        doc = json.loads((ROOT / "apps" / "heel_strike" / "app.nha").read_text())
        doc["readout"] = GOOD["readout"]
        self.assertRejects(doc, "flow_must_not_declare_a_readout")


class ShapeTests(unittest.TestCase):
    def assertRejects(self, doc, code_prefix):
        with self.assertRaises(PackageError) as ctx:
            validate_package(doc)
        self.assertTrue(str(ctx.exception).startswith(code_prefix),
                        f"expected {code_prefix}, got {ctx.exception}")

    def test_a_section_must_reference_a_declared_source(self):
        doc = mutate(sections=[{"kind": "table", "title": "X", "source": "nope",
                                "columns": [{"label": "A", "field": "a"}]}])
        self.assertRejects(doc, "unknown_source")

    def test_unknown_section_kinds_are_refused(self):
        self.assertRejects(mutate(sections=[{"kind": "iframe", "title": "X"}]),
                           "unknown_section_kind")

    def test_unknown_formats_are_refused(self):
        doc = mutate(sections=[{"kind": "table", "title": "X", "source": "tasks",
                                "columns": [{"label": "A", "field": "a", "format": "eval"}]}])
        self.assertRejects(doc, "unknown_format")

    def test_the_refresh_interval_is_bounded(self):
        # A readout polls a device over one TCP connection per command; letting
        # a package ask for 1ms would be a denial of service on the device.
        self.assertRejects(mutate(refresh_ms=10), "invalid_refresh_ms")
        self.assertRejects(mutate(refresh_ms=10 ** 7), "invalid_refresh_ms")

    def test_duplicate_source_ids_are_refused(self):
        self.assertRejects(
            mutate(sources=[{"id": "a", "command": "task_list"},
                            {"id": "a", "command": "scan_health"}]),
            "duplicate_source_id",
        )


class CatalogTests(unittest.TestCase):
    def test_the_index_records_the_kind(self):
        index = json.loads((ROOT / "index.json").read_text())
        kinds = {entry["id"]: entry.get("kind") for entry in index["apps"]}
        self.assertEqual(kinds["sysmon"], "readout")
        self.assertEqual(kinds["heel_strike"], "flow")


if __name__ == "__main__":
    unittest.main()
