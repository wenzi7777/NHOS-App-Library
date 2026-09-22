"""Negative cases for the package validator.

A validator that never rejects is worse than none: it teaches authors to trust
it and then hands them an opaque device error instead.
"""

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import opset  # noqa: E402
from validate import PackageError, canonical_bytes, validate_package  # noqa: E402


GOOD = json.loads((ROOT / "apps" / "heel_strike" / "app.nha").read_text())


def mutate(**manifest_changes):
    doc = copy.deepcopy(GOOD)
    doc["manifest"].update(manifest_changes)
    return doc


class ValidPackageTests(unittest.TestCase):
    def test_seed_apps_all_validate(self):
        for path in sorted((ROOT / "apps").glob("*/app.nha")):
            with self.subTest(app=path.parent.name):
                report = validate_package(json.loads(path.read_text()))
                self.assertEqual(report["id"], path.parent.name)

    def test_features_is_expressible_as_a_rule_graph(self):
        # The acceptance criterion for the op set: if the native FeatureExtractor
        # cannot be written as a graph, the op set is not complete enough to
        # replace it.
        doc = json.loads((ROOT / "apps" / "features" / "app.nha").read_text())
        report = validate_package(doc)
        fields = {n["field"] for n in doc["nodes"] if n["op"] == "feature_get"}
        self.assertEqual(fields, set(opset.FEATURE_FIELDS))
        self.assertLessEqual(report["nodes"], opset.MAX_NODES)


class ManifestRejectionTests(unittest.TestCase):
    def assertRejects(self, doc, code_prefix):
        with self.assertRaises(PackageError) as ctx:
            validate_package(doc)
        self.assertTrue(str(ctx.exception).startswith(code_prefix),
                        f"expected {code_prefix}, got {ctx.exception}")

    def test_id_must_match_the_device_path_rules(self):
        self.assertRejects(mutate(id="Heel-Strike"), "invalid_id")
        self.assertRejects(mutate(id="9lives"), "invalid_id")

    def test_id_is_capped_at_fifteen_characters(self):
        # "/files/apps/" + id + ".nha" must fit SPIFFS' 31-char path limit.
        self.assertRejects(mutate(id="a" * 16), "invalid_id")
        validate_package(mutate(id="a" * 15))

    def test_reserved_ids_are_refused(self):
        self.assertRejects(mutate(id="index"), "reserved_id")

    def test_version_must_be_semver(self):
        self.assertRejects(mutate(version="1.0"), "invalid_version")

    def test_required_fields_are_required(self):
        doc = copy.deepcopy(GOOD)
        del doc["manifest"]["author"]
        self.assertRejects(doc, "missing_manifest_field:author")

    def test_unknown_capabilities_are_refused(self):
        self.assertRejects(mutate(capabilities=["read_matrix", "launch_missiles"]),
                           "unknown_capability")

    def test_a_manifest_key_may_not_shadow_a_package_key(self):
        # The firmware reads "nodes" with a flat key scan, so a manifest field of
        # the same name could be found first.
        self.assertRejects(mutate(nodes=3), "manifest_key_shadows_package_key")


class GraphRejectionTests(unittest.TestCase):
    def assertRejects(self, nodes, code_prefix, manifest=None):
        doc = copy.deepcopy(GOOD)
        doc["nodes"] = nodes
        if manifest:
            doc["manifest"].update(manifest)
        with self.assertRaises(PackageError) as ctx:
            validate_package(doc)
        self.assertTrue(str(ctx.exception).startswith(code_prefix),
                        f"expected {code_prefix}, got {ctx.exception}")

    def test_empty_graph(self):
        self.assertRejects([], "empty_graph")

    def test_too_many_nodes(self):
        self.assertRejects([{"op": "total"}] * 13, "too_many_nodes")

    def test_unknown_op(self):
        self.assertRejects([{"op": "teleport"}], "unknown_op")

    def test_forward_references_are_impossible(self):
        self.assertRejects(
            [{"op": "threshold", "in": 1, "value": 1.0}, {"op": "total"}],
            "input_out_of_order",
        )

    def test_self_reference_is_impossible(self):
        self.assertRejects([{"op": "total"}, {"op": "threshold", "in": 1, "value": 1.0}],
                           "input_out_of_order")

    def test_emit_needs_a_name_within_the_firmware_buffer(self):
        self.assertRejects(
            [{"op": "total"}, {"op": "threshold", "in": 0, "value": 1.0},
             {"op": "emit", "in": 1, "event": "e" * 24}],
            "event_name_too_long",
        )

    def test_capabilities_must_cover_what_the_graph_does(self):
        self.assertRejects(
            [{"op": "total"}, {"op": "threshold", "in": 0, "value": 1.0},
             {"op": "emit", "in": 1, "event": "x"}],
            "capability_not_declared:emit_event",
            manifest={"capabilities": ["read_matrix"]},
        )

    def test_feature_get_must_read_a_features_node(self):
        self.assertRejects(
            [{"op": "total"}, {"op": "feature_get", "in": 0, "field": "peak"}],
            "feature_get_input_must_be_features",
        )

    def test_unknown_feature_field(self):
        self.assertRejects(
            [{"op": "features"}, {"op": "feature_get", "in": 0, "field": "vibes"}],
            "unknown_feature_field",
        )

    def test_min_os_must_admit_the_ops_used(self):
        # A v1.1.0 op in a package that claims to run on v1.0.0 would be accepted
        # by the library and then rejected by the device as unknown_op.
        self.assertRejects(
            [{"op": "features"}],
            "min_os_too_low",
            manifest={"min_os": "v1.0.0"},
        )

    def test_windows_are_bounded(self):
        self.assertRejects(
            [{"op": "total"}, {"op": "mean", "in": 0, "window": 5000}],
            "invalid_window",
            manifest={"min_os": "v1.1.0"},
        )


class SizeTests(unittest.TestCase):
    def test_oversized_packages_are_refused(self):
        doc = copy.deepcopy(GOOD)
        doc["manifest"]["summary"] = "x" * 5000
        with self.assertRaises(PackageError) as ctx:
            validate_package(doc, canonical_bytes(doc))
        self.assertTrue(str(ctx.exception).startswith("package_too_large"))


class CostModelTests(unittest.TestCase):
    def test_sweep_cost_scales_with_cells_and_scalars_do_not(self):
        sweep = [{"op": "total"}]
        scalar = [{"op": "budget_load"}]
        self.assertGreater(opset.graph_cost_us(sweep, 225), opset.graph_cost_us(sweep, 16))
        self.assertEqual(opset.graph_cost_us(scalar, 225), opset.graph_cost_us(scalar, 16))

    def test_gate_is_costed_at_its_worst_case(self):
        # Charging the average would understate the bound and make the install
        # estimate a lie on the frames that matter.
        gated = [{"op": "budget_load"}, {"op": "total"}, {"op": "gate", "in": [0, 1]}]
        self.assertEqual(
            opset.graph_cost_us(gated, 225),
            opset.graph_cost_us([{"op": "budget_load"}, {"op": "total"}], 225)
            + (opset.SCALAR_OP_NS + 999) // 1000,
        )

    def test_window_memory_is_reserved_up_front(self):
        self.assertEqual(
            opset.graph_memory_bytes([{"op": "total"}, {"op": "mean", "in": 0, "window": 30}]),
            120,
        )


if __name__ == "__main__":
    unittest.main()
