"""The simulator is the executable specification of the graph's semantics.

How a threshold latches, when a debounce commits, which edge emits -- these
otherwise exist only in the firmware's C++, where nothing can assert on them.
Every test here is a statement about behaviour the device must match.
"""

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from compile import compile_source  # noqa: E402
from simulate import (  # noqa: E402
    PRESSURE_ACTIVE_THRESHOLD,
    Frame,
    Simulator,
    compute_features,
    load_frames,
    write_events,
)


HEADER = '''app demo {
  name    "Demo"
  version 1.0.0
  author  wenzi7777
  summary "test fixture"
}
'''


def build(body: str) -> dict:
    package, _ = compile_source(HEADER + body)
    return package


def flat_frames(values_per_frame, ms_step=16, rows=1, cols=None):
    frames = []
    for index, values in enumerate(values_per_frame):
        frames.append(Frame(seq=1000 + index, timestamp_ms=index * ms_step,
                            values=list(values), rows=rows,
                            cols=cols if cols is not None else len(values)))
    return frames


def run(package: dict, frames) -> Simulator:
    simulator = Simulator(package, app_name="demo")
    simulator.run(frames)
    return simulator


class ThresholdTests(unittest.TestCase):
    def test_hysteresis_stops_an_event_chattering(self):
        package = build("signal a = total()\nevent hit when a > 10 hyst 4\n")
        # Sitting exactly on the threshold, then wobbling within the band.
        sim = run(package, flat_frames([[10.0], [9.0], [7.0], [10.0], [5.0]]))
        # Latches at 10, holds through 9 and 7 (above 10-4=6), releases at 5.
        self.assertEqual([(e.event, e.detail) for e in sim.events],
                         [("hit", "rise"), ("hit", "fall")])

    def test_without_hysteresis_each_crossing_emits(self):
        package = build("signal a = total()\nevent hit when a > 10\n")
        sim = run(package, flat_frames([[10.0], [0.0], [10.0], [0.0]]))
        self.assertEqual([e.detail for e in sim.events], ["rise", "fall", "rise", "fall"])


class DebounceTests(unittest.TestCase):
    def test_a_transient_shorter_than_the_hold_is_rejected(self):
        package = build("signal a = total()\nevent hit when a > 10 for 50ms\n")
        # 16ms frames: high for two frames (32ms) is not long enough.
        sim = run(package, flat_frames([[0.0], [20.0], [20.0], [0.0], [0.0], [0.0]]))
        self.assertEqual(sim.events, [])

    def test_a_signal_held_long_enough_commits(self):
        package = build("signal a = total()\nevent hit when a > 10 for 50ms\n")
        sim = run(package, flat_frames([[0.0]] + [[20.0]] * 6))
        self.assertEqual([e.detail for e in sim.events], ["rise"])


class ArithmeticTests(unittest.TestCase):
    def test_a_ratio_is_expressible(self):
        # The whole reason v1.1.0 added arithmetic: this was impossible before.
        package = build(
            "region left = rows 0..0, cols 0..1\n"
            "region right = rows 0..0, cols 2..3\n"
            "signal l = sum(left)\nsignal r = sum(right)\n"
            "signal bias = (l - r) / (l + r)\n"
            "event lean when bias > 0.3\n")
        sim = run(package, flat_frames([[10.0, 10.0, 2.0, 2.0]], rows=1, cols=4))
        # (20-4)/24 = 0.667
        self.assertEqual([e.detail for e in sim.events], ["rise"])

    def test_division_by_zero_yields_zero_not_nan(self):
        # A NaN would poison every downstream node for the rest of the session.
        package = build("signal a = total()\nsignal b = a / a\nevent hit when b > 0.5\n")
        sim = run(package, flat_frames([[0.0], [5.0]]))
        self.assertEqual([e.detail for e in sim.events], ["rise"])


class WindowTests(unittest.TestCase):
    def test_mean_averages_only_the_samples_it_has_seen(self):
        package = build("signal a = total()\nsignal m = mean(a, 4)\nevent hit when m > 9\n")
        # First frame's mean must be 10, not 10/4 -- the device has not seen
        # three zeros, it has seen one sample.
        sim = run(package, flat_frames([[10.0]]))
        self.assertEqual([e.detail for e in sim.events], ["rise"])

    def test_integrate_accumulates_over_the_window(self):
        package = build("signal a = total()\nsignal s = integrate(a, 3)\nevent hit when s > 25\n")
        sim = run(package, flat_frames([[10.0], [10.0], [10.0]]))
        self.assertEqual([e.detail for e in sim.events], ["rise"])

    def test_max_hold_reports_the_peak_in_the_window(self):
        package = build("signal a = total()\nsignal p = max_hold(a, 3)\nevent hit when p > 15\n")
        sim = run(package, flat_frames([[20.0], [1.0], [1.0]]))
        # Still latched on the third frame: 20 is inside the 3-frame window.
        self.assertEqual([e.detail for e in sim.events], ["rise"])


class FeatureTests(unittest.TestCase):
    def test_the_centroid_weights_only_loaded_cells(self):
        # Centre of FORCE, not centre of the bounding box. Including quiet
        # cells would drag the result toward the middle of the mat.
        frame = Frame(seq=0, timestamp_ms=0, rows=1, cols=4,
                      values=[0.0, 0.0, 100.0, 100.0])
        features = compute_features(frame)
        self.assertEqual(features["centroid_col"], 2.5)

    def test_cells_below_the_contact_threshold_do_not_count(self):
        below = PRESSURE_ACTIVE_THRESHOLD - 1
        frame = Frame(seq=0, timestamp_ms=0, rows=1, cols=2, values=[below, below])
        features = compute_features(frame)
        self.assertEqual(features["active_cells"], 0)
        self.assertEqual(features["in_contact"], 0)
        # Total force still counts everything -- it is a sum, not a count.
        self.assertEqual(features["total_force"], below * 2)

    def test_peak01_is_clamped(self):
        frame = Frame(seq=0, timestamp_ms=0, rows=1, cols=1, values=[99999.0])
        self.assertEqual(compute_features(frame)["peak01"], 1.0)

    def test_one_sweep_serves_every_feature_read(self):
        package = build(
            "signal t = feature(total_force)\nsignal p = feature(peak)\n"
            "event hit when t > 10\n")
        self.assertEqual(sum(1 for n in package["nodes"] if n["op"] == "features"), 1)


class GateTests(unittest.TestCase):
    SOURCE = (
        "signal load = budget_load()\n"
        "gate (load < 0.9) {\n"
        "  signal detail = peak()\n"
        "  event spike when detail > 10\n"
        "}\n"
    )

    def test_a_gate_block_compiles_to_a_span(self):
        package = build(self.SOURCE)
        gate = next(n for n in package["nodes"] if n["op"] == "gate")
        self.assertGreater(gate["span"], 0)

    def test_the_gate_precedes_what_it_skips(self):
        # Data references point backwards, so a gate can only skip what follows.
        package = build(self.SOURCE)
        index = next(i for i, n in enumerate(package["nodes"]) if n["op"] == "gate")
        self.assertLess(index, len(package["nodes"]) - 1)

    def test_an_open_gate_lets_the_block_run(self):
        # budget_load() is 0 offline, so `load < 0.9` holds and nothing skips.
        package = build(self.SOURCE)
        sim = run(package, flat_frames([[50.0]]))
        self.assertIn("spike", [e.event for e in sim.events])
        self.assertNotIn("degraded", [e.event for e in sim.events])

    def test_an_empty_gate_block_is_refused(self):
        from compile import CompileError
        with self.assertRaises(CompileError) as ctx:
            build("signal load = budget_load()\ngate (load < 0.9) {\n}\n")
        self.assertIn("empty gate", str(ctx.exception))


class SidecarTests(unittest.TestCase):
    def test_the_output_matches_the_desktop_sidecar_columns(self):
        # A simulated run and a real recording have to be comparable row by row.
        package = build("signal a = total()\nevent hit when a > 5\n")
        sim = run(package, flat_frames([[10.0], [0.0]]))
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "out.events.csv"
            write_events(target, sim.events)
            with target.open(encoding="utf-8") as handle:
                rows = list(csv.reader(handle))
        self.assertEqual(rows[0],
                         ["seq", "frame_seq", "timestamp_ms", "app", "event", "edge", "value"])
        self.assertEqual(rows[1][1], "1000")

    def test_frames_are_read_back_with_their_sequence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "samples.csv"
            path.write_text("timestamp_ms,P1,P2,P3,P4,frame_seq\n0,1,2,3,4,77\n",
                            encoding="utf-8")
            frames = load_frames(path, None, None)
        self.assertEqual(frames[0].seq, 77)
        self.assertEqual(frames[0].values, [1.0, 2.0, 3.0, 4.0])
        # Four cells with no shape given is read as 2x2.
        self.assertEqual((frames[0].rows, frames[0].cols), (2, 2))


if __name__ == "__main__":
    unittest.main()
