"""Compiler tests.

The three jobs the compiler exists to do -- topological ordering, common
subexpression elimination, and honest cost reporting -- each get a test, because
each one is something an author would otherwise have to do by hand and would
get wrong silently.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import opset  # noqa: E402
from compile import CompileError, compile_source  # noqa: E402
from validate import canonical_bytes, validate_package  # noqa: E402


HEADER = '''app demo {
  name    "Demo"
  version 1.0.0
  author  wenzi7777
  summary "test fixture"
}
'''


def build(body: str):
    return compile_source(HEADER + body)


class SeedAppTests(unittest.TestCase):
    def test_every_source_compiles_and_matches_its_artifact(self):
        for source in sorted((ROOT / "apps").glob("*/app.nhs")):
            with self.subTest(app=source.parent.name):
                from compile import compile_file
                package, _ = compile_file(source)
                artifact = (source.parent / "app.nha").read_bytes()
                self.assertEqual(canonical_bytes(package), artifact,
                                 "app.nha is stale; run tools/build_index.py")


class OrderingTests(unittest.TestCase):
    def test_references_always_point_backwards(self):
        package, _ = build("signal a = total()\nsignal b = a * 2 + peak()\n"
                           "event hot when b > 10\n")
        for index, node in enumerate(package["nodes"]):
            refs = node.get("in", [])
            refs = [refs] if isinstance(refs, int) else refs
            for ref in refs:
                self.assertLess(ref, index, f"node {index} references {ref}")

    def test_inserting_an_intermediate_value_does_not_break_indices(self):
        # The renumbering an author would have to do by hand.
        direct, _ = build("signal a = total() + peak()\nevent e when a > 1\n")
        staged, _ = build("signal t = total()\nsignal p = peak()\n"
                          "signal a = t + p\nevent e when a > 1\n")
        self.assertEqual(direct["nodes"], staged["nodes"])


class SharingTests(unittest.TestCase):
    def test_identical_subexpressions_cost_one_node(self):
        package, report = build(
            "signal x = total() / (total() + peak())\nevent e when x > 1\n")
        sweeps = [n for n in package["nodes"] if n["op"] == "total"]
        self.assertEqual(len(sweeps), 1, "the second total() should have been shared")
        self.assertGreater(report["reused"], 0)

    def test_features_collapses_to_a_single_sweep(self):
        # Eight feature reads, one sweep -- the whole reason feature_get exists.
        body = "".join(f"signal f{i} = feature({name})\n"
                       for i, name in enumerate(opset.FEATURE_FIELDS))
        package, _ = build(body + "event e when f0 > 1\n")
        self.assertEqual(sum(1 for n in package["nodes"] if n["op"] == "features"), 1)


class CostReportTests(unittest.TestCase):
    def test_over_budget_names_the_biggest_contributors(self):
        with self.assertRaises(CompileError) as ctx:
            build("".join(f"signal s{i} = total() + {i}\n" for i in range(14))
                  + "event e when s0 > 1\n")
        message = str(ctx.exception)
        self.assertIn("exceeds the 12-node limit", message)
        self.assertIn("Largest contributors", message)

    def test_a_literal_argument_does_not_become_a_node(self):
        # It used to, which wasted a slot and dragged min_os up to v1.1.0 for a
        # graph that only used v1.0.0 operators.
        package, _ = build("signal c = active(3.0)\nevent e when c > 1\n")
        self.assertNotIn("const", [n["op"] for n in package["nodes"]])
        self.assertEqual(package["manifest"]["min_os"], "v1.0.0")

    def test_min_os_is_derived_from_the_ops_used(self):
        v10, _ = build("signal a = total()\nevent e when a > 1\n")
        v11, _ = build("signal a = total()\nsignal b = mean(a, 10)\nevent e when b > 1\n")
        self.assertEqual(v10["manifest"]["min_os"], "v1.0.0")
        self.assertEqual(v11["manifest"]["min_os"], "v1.1.0")

    def test_capabilities_are_derived_not_declared(self):
        package, _ = build("signal a = total()\nevent e when a > 1\n")
        self.assertEqual(package["manifest"]["capabilities"], ["emit_event", "read_matrix"])


class DiagnosticTests(unittest.TestCase):
    def assertFails(self, body, fragment):
        with self.assertRaises(CompileError) as ctx:
            build(body)
        self.assertIn(fragment, str(ctx.exception))

    def test_unknown_value(self):
        self.assertFails("event e when nope > 1\n", "unknown value")

    def test_unknown_function(self):
        self.assertFails("signal a = teleport()\nevent e when a > 1\n", "unknown function")

    def test_unknown_region(self):
        self.assertFails("signal a = sum(nowhere)\nevent e when a > 1\n", "sum() takes a region")

    def test_inverted_region(self):
        self.assertFails("region r = rows 9..2, cols 0..3\n"
                         "signal a = sum(r)\nevent e when a > 1\n", "inverted range")

    def test_led_needs_a_known_event(self):
        self.assertFails("signal a = total()\nled green when nothing\n", "unknown event")

    def test_event_name_length_is_checked_against_the_firmware_buffer(self):
        self.assertFails(f"signal a = total()\nevent {'e' * 24} when a > 1\n",
                         "exceeds 23 characters")

    def test_errors_carry_a_line_number(self):
        with self.assertRaises(CompileError) as ctx:
            build("signal a = total()\nevent e when a > 1\nsignal b = nope\n")
        self.assertEqual(ctx.exception.line, 9)


class ComparisonTests(unittest.TestCase):
    def test_less_than_is_compiled_and_the_cost_is_disclosed(self):
        package, report = build("signal load = budget_load()\n"
                                "event easy when load < 0.9\n")
        self.assertTrue(any("compiled as a subtraction" in note for note in report["notes"]))
        self.assertIn("sub", [n["op"] for n in package["nodes"]])

    def test_hysteresis_and_debounce_reach_the_nodes(self):
        package, _ = build("signal a = total()\nevent e when a > 40 hyst 6 for 30ms\n")
        threshold = next(n for n in package["nodes"] if n["op"] == "threshold")
        debounce = next(n for n in package["nodes"] if n["op"] == "debounce")
        self.assertEqual(threshold["hysteresis"], 6.0)
        self.assertEqual(debounce["ms"], 30)


class OutputTests(unittest.TestCase):
    def test_compiled_packages_validate(self):
        package, _ = build("region r = rows 0..3, cols 0..3\n"
                           "signal a = sum(r)\nevent e when a > 1\nled green when e\n")
        report = validate_package(package, canonical_bytes(package))
        self.assertEqual(report["id"], "demo")

    def test_led_declares_its_capability(self):
        package, _ = build("signal a = total()\nevent e when a > 1\nled green when e\n")
        self.assertIn("drive_led", package["manifest"]["capabilities"])


if __name__ == "__main__":
    unittest.main()
