"""Run a flow graph against recorded frames, without a device.

This is more than a convenience. The graph's semantics -- how a threshold
latches, when a debounce commits, which edge emits -- currently exist only in
the firmware's C++. This file is the executable specification of the same
rules, and the golden cases in tests/ pin the two together.

Input is the sample CSV the Desktop app exports. Output is the same
`.events.csv` shape the Desktop writes beside a recording, so a simulated run
and a real one can be compared row by row.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from opset import FEATURE_FIELDS, OPS, graph_cost_us  # noqa: E402


# Must equal MatrixScanner.h. The centroid weights only cells at or above the
# contact threshold, so it is the centre of FORCE, not of the bounding box.
PRESSURE_ACTIVE_THRESHOLD = 50.0
PRESSURE_FULL_SCALE = 2000.0

PRESSURE_COLUMN = re.compile(r"^P(\d+)$", re.IGNORECASE)


@dataclass
class Frame:
    seq: int
    timestamp_ms: int
    values: list[float]
    rows: int
    cols: int


@dataclass
class NodeState:
    result: float = 0.0
    bool_result: bool = False
    last_bool: bool = False
    since_ms: int = 0
    prev: float = 0.0
    ring: list[float] = field(default_factory=list)
    cursor: int = 0
    filled: int = 0
    skipped: bool = False


@dataclass
class SimEvent:
    seq: int
    frame_seq: int
    ms: int
    app: str
    event: str
    detail: str
    value: float | None = None


def load_frames(path: Path, rows: int | None, cols: int | None) -> list[Frame]:
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit(f"{path}: no header row")
        pressure_columns = sorted(
            (name for name in reader.fieldnames if PRESSURE_COLUMN.match(name or "")),
            key=lambda name: int(PRESSURE_COLUMN.match(name).group(1)),
        )
        if not pressure_columns:
            raise SystemExit(f"{path}: no P1..Pn columns found")
        has_seq = "frame_seq" in reader.fieldnames

        frames: list[Frame] = []
        for index, row in enumerate(reader):
            values = [_float(row.get(name)) for name in pressure_columns]
            shape_rows, shape_cols = _shape(len(values), rows, cols)
            frames.append(Frame(
                seq=int(_float(row.get("frame_seq"))) if has_seq else index,
                timestamp_ms=int(_float(row.get("timestamp_ms"))),
                values=values,
                rows=shape_rows,
                cols=shape_cols,
            ))
    return frames


def _float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _shape(count: int, rows: int | None, cols: int | None) -> tuple[int, int]:
    if rows and cols:
        return rows, cols
    side = int(math.isqrt(count))
    if side * side == count:
        return side, side
    # Not square and not told: treat it as a single row rather than guessing a
    # layout, since a wrong guess silently moves every region.
    return 1, count


def compute_features(frame: Frame) -> dict[str, float]:
    total = 0.0
    peak = 0.0
    peak_index = 0
    active = 0
    weighted_row = 0.0
    weighted_col = 0.0
    cols = frame.cols or 1
    for index, value in enumerate(frame.values):
        total += value
        if value > peak:
            peak = value
            peak_index = index
        if value >= PRESSURE_ACTIVE_THRESHOLD:
            active += 1
            weighted_row += value * (index // cols)
            weighted_col += value * (index % cols)
    return {
        "total_force": total,
        "peak": peak,
        "peak01": min(peak / PRESSURE_FULL_SCALE, 1.0),
        "peak_index": float(peak_index),
        "active_cells": float(active),
        "centroid_row": weighted_row / total if total > 0 else 0.0,
        "centroid_col": weighted_col / total if total > 0 else 0.0,
        "in_contact": 1.0 if active > 0 else 0.0,
    }


def _inputs(node: dict) -> list[int]:
    raw = node.get("in")
    if raw is None:
        return []
    return [raw] if isinstance(raw, int) else list(raw)


class Simulator:
    def __init__(self, package: dict, app_name: str = "flow"):
        self.nodes: list[dict] = list(package.get("nodes") or [])
        self.states = [NodeState() for _ in self.nodes]
        for state, node in zip(self.states, self.nodes):
            window = int(node.get("window") or 0)
            if window:
                state.ring = [0.0] * window
        self.app_name = app_name
        self.features: dict[str, float] = {name: 0.0 for name in FEATURE_FIELDS}
        self.events: list[SimEvent] = []
        self.seq = 0
        self.degraded = False

    def emit(self, frame: Frame, event: str, detail: str, value: float | None = None) -> None:
        self.seq += 1
        self.events.append(SimEvent(self.seq, frame.seq, frame.timestamp_ms,
                                    self.app_name, event, detail, value))

    def run(self, frames: list[Frame]) -> None:
        for frame in frames:
            self.step(frame)

    def step(self, frame: Frame) -> None:
        skip_until = 0
        skipped_any = False
        cols = frame.cols or 1

        for index, node in enumerate(self.nodes):
            state = self.states[index]
            if index < skip_until:
                # Held at its previous value rather than zeroed, so a gated
                # branch resumes where it was instead of glitching through zero.
                state.skipped = True
                skipped_any = True
                continue
            state.skipped = False

            op = str(node.get("op"))
            refs = _inputs(node)

            def src(position: int = 0) -> NodeState:
                return self.states[refs[position]]

            if op == "total":
                state.result = sum(frame.values)
            elif op == "peak":
                state.result = max(frame.values, default=0.0)
            elif op == "region_sum":
                total = 0.0
                for r in range(int(node.get("r0", 0)), min(int(node.get("r1", 0)), frame.rows - 1) + 1):
                    for c in range(int(node.get("c0", 0)), min(int(node.get("c1", 0)), cols - 1) + 1):
                        cell = r * cols + c
                        if cell < len(frame.values):
                            total += frame.values[cell]
                state.result = total
            elif op == "active_cells":
                limit = float(node.get("value", 0))
                state.result = float(sum(1 for value in frame.values if value >= limit))
            elif op == "arg_max":
                state.result = float(max(range(len(frame.values)),
                                         key=lambda i: frame.values[i], default=0))
            elif op in ("row_centroid", "col_centroid"):
                total = 0.0
                weighted = 0.0
                for i, value in enumerate(frame.values):
                    if value < PRESSURE_ACTIVE_THRESHOLD:
                        continue
                    total += value
                    weighted += value * (i // cols if op == "row_centroid" else i % cols)
                state.result = weighted / total if total > 0 else 0.0
            elif op == "features":
                self.features = compute_features(frame)
                state.result = self.features["total_force"]
            elif op == "feature_get":
                state.result = self.features.get(str(node.get("field")), 0.0)
                state.bool_result = state.result != 0
            elif op == "const":
                state.result = float(node.get("value", 0))
            elif op == "add":
                state.result = src(0).result + src(1).result
            elif op == "sub":
                state.result = src(0).result - src(1).result
            elif op == "mul":
                state.result = src(0).result * src(1).result
            elif op == "div":
                divisor = src(1).result
                # Zero rather than NaN: one bad frame must not poison every
                # downstream node for the rest of the session.
                state.result = src(0).result / divisor if divisor != 0 else 0.0
            elif op == "min":
                state.result = min(src(0).result, src(1).result)
            elif op == "max":
                state.result = max(src(0).result, src(1).result)
            elif op == "abs":
                state.result = abs(src(0).result)
            elif op == "clamp":
                state.result = max(float(node.get("lo", 0)),
                                   min(float(node.get("hi", 0)), src(0).result))
            elif op in ("mean", "max_hold", "integrate"):
                state.result = self._push_window(state, node, src(0).result, op)
            elif op == "delta":
                current = src(0).result
                state.result = current - state.prev
                state.prev = current
            elif op == "counter":
                current = src(0).bool_result
                if current and not state.last_bool:
                    state.result += 1.0
                state.last_bool = current
            elif op == "threshold":
                value = float(node.get("value", 0))
                hysteresis = float(node.get("hysteresis", 0))
                # Once latched, hold until the input falls below value -
                # hysteresis; without it a signal resting on the threshold
                # emits on every single frame.
                release_at = value - hysteresis
                state.bool_result = (src(0).result > release_at) if state.bool_result \
                    else (src(0).result >= value)
                state.result = 1.0 if state.bool_result else 0.0
            elif op == "debounce":
                raw = src(0).bool_result
                ms = int(node.get("ms", 0))
                if raw != state.last_bool:
                    state.last_bool = raw
                    state.since_ms = frame.timestamp_ms
                elif raw != state.bool_result and frame.timestamp_ms - state.since_ms >= ms:
                    state.bool_result = raw
                state.result = 1.0 if state.bool_result else 0.0
            elif op == "emit":
                current = src(0).bool_result
                if current != state.last_bool:
                    state.last_bool = current
                    state.bool_result = current
                    self.emit(frame, str(node.get("event")), "rise" if current else "fall")
            elif op == "emit_value":
                current = src(0).bool_result
                if current and not state.last_bool:
                    value = src(1).result
                    self.emit(frame, str(node.get("event")), f"{value:.3f}", value)
                state.last_bool = current
            elif op == "led":
                current = src(0).bool_result
                if current != state.last_bool:
                    state.last_bool = current
                    self.emit(frame, "led", str(node.get("rgb", "")) if current else "off")
            elif op == "select":
                state.result = src(1).result if src(0).bool_result else src(2).result
            elif op == "gate":
                state.bool_result = src(0).bool_result
                state.result = 1.0 if state.bool_result else 0.0
                span = int(node.get("span", 0))
                if not state.bool_result and span > 0:
                    skip_until = min(index + 1 + span, len(self.nodes))
            elif op in ("budget_load", "grace_left"):
                # No budget pressure offline; a simulation is not competing
                # with a scanner for time.
                state.result = 0.0

        if skipped_any != self.degraded:
            self.degraded = skipped_any
            self.emit(frame, "degraded", "rise" if skipped_any else "fall")

    @staticmethod
    def _push_window(state: NodeState, node: dict, sample: float, op: str) -> float:
        """Mirrors FlowApp::pushWindow, including its warm-up behaviour.

        Only the samples actually written are considered, so a mean over the
        first few frames is the mean of those frames -- not of them plus a
        tail of zeros the device has never seen.
        """
        window = int(node.get("window") or 1)
        state.ring[state.cursor] = sample
        state.cursor = (state.cursor + 1) % window
        if state.filled < window:
            state.filled += 1
        values = state.ring[:state.filled]
        if op == "max_hold":
            return max(values)
        total = sum(values)
        return total if op == "integrate" else total / len(values)


def write_events(path: Path, events: list[SimEvent]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["seq", "frame_seq", "timestamp_ms", "app", "event", "edge", "value"])
        for event in events:
            writer.writerow([event.seq, event.frame_seq, event.ms, event.app, event.event,
                             event.detail, "" if event.value is None else round(event.value, 3)])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a flow graph over recorded frames")
    parser.add_argument("package", type=Path, help="a .nha package")
    parser.add_argument("samples", type=Path, help="a sample CSV exported by the Desktop app")
    parser.add_argument("--rows", type=int, help="matrix rows, if the CSV does not imply them")
    parser.add_argument("--cols", type=int)
    parser.add_argument("--events", type=Path, help="write an .events.csv here")
    parser.add_argument("--budget", action="store_true", help="print the cost breakdown")
    args = parser.parse_args(argv)

    package = json.loads(args.package.read_text(encoding="utf-8"))
    frames = load_frames(args.samples, args.rows, args.cols)
    if not frames:
        print("no frames in the sample file", file=sys.stderr)
        return 1

    simulator = Simulator(package, app_name=str(package.get("name") or "flow"))
    simulator.run(frames)

    if args.budget:
        cells = len(frames[0].values)
        print(f"cells: {cells}   estimated: {graph_cost_us(package['nodes'], cells)}us")
        for index, node in enumerate(package["nodes"]):
            op = OPS[str(node["op"])]
            cost = op.ns_per_cell * cells if op.sweep else op.ns_flat
            print(f"  [{index:>2}] {node['op']:<14} ~{cost / 1000:6.1f}us")

    print(f"frames: {len(frames)}   events: {len(simulator.events)}")
    for event in simulator.events:
        value = "" if event.value is None else f" value={event.value:.3f}"
        print(f"  #{event.seq:<4} f{event.frame_seq:<8} {event.app}.{event.event} "
              f"{event.detail}{value}")

    if args.events:
        write_events(args.events, simulator.events)
        print(f"wrote {args.events}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
