"""The constants this library shares with the firmware.

If these drift, an app passes here and is refused by the device -- the most
confusing failure this system can produce, because the author has no way to see
the other side. The test reads the firmware's own headers rather than a copy,
so it fails the moment either side moves.

Skipped when the firmware is not checked out beside this repository.
"""

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import opset  # noqa: E402

FIRMWARE = ROOT.parent / "NewHorizonsOS-OTA" / "firmware" / "newhorizons_os"


def constant(source: str, name: str) -> int:
    match = re.search(rf"{name}\s*=\s*(\d+)", source)
    if match is None:
        raise AssertionError(f"{name} not found in the firmware")
    return int(match.group(1))


@unittest.skipUnless(FIRMWARE.is_dir(), "NewHorizonsOS-OTA is not checked out beside this repo")
class CostModelContractTests(unittest.TestCase):
    def setUp(self):
        self.flow_h = (FIRMWARE / "FlowApp.h").read_text(encoding="utf-8")
        self.flow_cpp = (FIRMWARE / "FlowApp.cpp").read_text(encoding="utf-8")
        # Scoped to opFromName: featureFieldFromName uses the same shape and
        # would otherwise be read as a list of operators.
        table = self.flow_cpp[self.flow_cpp.index("FlowOp FlowApp::opFromName"):]
        self.firmware_ops = set(re.findall(r'name == "([a-z_0-9]+)"',
                                           table[:table.index("\n}")]))

    def test_the_cost_constants_match(self):
        self.assertEqual(constant(self.flow_h, "kCellOpNsPerCell"), opset.CELL_OP_NS_PER_CELL)
        self.assertEqual(constant(self.flow_h, "kScalarOpNs"), opset.SCALAR_OP_NS)
        self.assertEqual(constant(self.flow_h, "kFeaturesNsPerCell"), opset.FEATURES_NS_PER_CELL)

    def test_the_hard_limits_match(self):
        self.assertEqual(constant(self.flow_h, "kMaxNodes"), opset.MAX_NODES)
        self.assertEqual(constant(self.flow_h, "kMaxPackageBytes"), opset.MAX_PACKAGE_BYTES)
        # A window the library accepts but the device cannot allocate would be
        # rejected only after upload, as invalid_window.
        self.assertEqual(constant(self.flow_h, "kMaxWindow"), 128)

    def test_the_app_id_cap_matches(self):
        package_h = (FIRMWARE / "AppPackage.h").read_text(encoding="utf-8")
        # kIdLen counts the NUL, so the usable length is one less.
        self.assertEqual(constant(package_h, "kIdLen") - 1, opset.MAX_APP_ID)

    def test_every_op_the_library_knows_exists_in_the_firmware(self):
        # opFromName is the device's own table; anything missing from it would
        # be refused as unknown_op after a successful local build.
        missing = sorted(set(opset.OPS) - self.firmware_ops)
        self.assertEqual(missing, [], f"the firmware has no case for {missing}")

    def test_every_op_the_firmware_knows_is_in_the_library(self):
        extra = sorted(self.firmware_ops - set(opset.OPS))
        self.assertEqual(extra, [], f"the library cannot emit {extra}")

    def test_the_feature_fields_agree(self):
        firmware_fields = set(re.findall(r'name == "([a-z_0-9]+)"\) return static_cast<uint8_t>\(FeatureField',
                                         self.flow_cpp))
        self.assertEqual(firmware_fields, set(opset.FEATURE_FIELDS))

    def test_the_capability_names_agree(self):
        package_cpp = (FIRMWARE / "AppPackage.cpp").read_text(encoding="utf-8")
        block = package_cpp[package_cpp.index("uint16_t AppPackage::capabilityFromName"):]
        block = block[:block.index("\n}")]
        firmware_caps = set(re.findall(r'name == "([a-z_]+)"', block))
        # The library only lets an author declare the five data capabilities;
        # the event-source bits are set by the device, not by a package.
        self.assertTrue(set(opset.CAPABILITIES).issubset(firmware_caps),
                        sorted(set(opset.CAPABILITIES) - firmware_caps))


@unittest.skipUnless(FIRMWARE.is_dir(), "NewHorizonsOS-OTA is not checked out beside this repo")
class PackageContractTests(unittest.TestCase):
    def test_the_firmware_accepts_every_kind_this_library_emits(self):
        import json
        package_cpp = (FIRMWARE / "AppPackage.cpp").read_text(encoding="utf-8")
        published = {json.loads(path.read_text())["kind"]
                     for path in (ROOT / "apps").glob("*/app.nha")}
        for kind in published:
            with self.subTest(kind=kind):
                # A kind the device does not know is refused as unsupported_kind
                # AFTER upload, which is a confusing place to find out.
                self.assertIn(f'"{kind}"', package_cpp)

    def test_published_packages_declare_a_known_kind(self):
        import json
        for path in sorted((ROOT / "apps").glob("*/app.nha")):
            with self.subTest(app=path.parent.name):
                self.assertIn(json.loads(path.read_text())["kind"], ("flow", "readout"))

    def test_the_firmware_never_dispatches_a_readout(self):
        registry = (FIRMWARE / "AppRegistry.cpp").read_text(encoding="utf-8")
        # A readout holds a registry entry so that what a device has travels
        # with the device -- but it has nothing to run.
        self.assertIn("not_activatable:readout", registry)
        self.assertIn("kAppPackageReadout", registry)


if __name__ == "__main__":
    unittest.main()
