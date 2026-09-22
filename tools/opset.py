"""The op table and cost model -- the single source of truth for this library.

`validate.py`, `build_index.py` and (later) `compile.py` and `simulate.py` all
read from here, and the firmware's `RuleEngineApp::estimateUs()` must agree with
it. That agreement is a compatibility contract: if the two drift, an app passes
locally and is refused by the device, which is the most confusing failure this
system can produce. The golden cases in `tests/` pin both directions.

Costs are deliberate OVER-estimates. The point is a bound, not a prediction --
the same stance the firmware takes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


# --- hard limits, all mirrored in the firmware ------------------------------

MAX_NODES = 12                 # RuleEngineApp::kMaxNodes
MAX_PACKAGE_BYTES = 4096       # the parse buffer the firmware allocates
MAX_EVENT_NAME = 23            # RuleNode::event is char[24]

# "/files/" (7) + "apps/" (5) + id + ".nha" (4) must fit SPIFFS' 31-char path
# limit, which leaves exactly 15 characters for the id.
MAX_APP_ID = 15
APP_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,14}$")
RESERVED_APP_IDS = {"index"}

# Cost constants. Must equal FlowApp::kCellOpNsPerCell / kScalarOpNs /
# kFeaturesNsPerCell.
#
# MEASURED on v1.5.F (ESP32-S3 @ 240MHz, 14x14), not guessed: a flat sweep runs
# about 86ns per cell and a features sweep about 235ns. The original 60/120/400
# under-estimated by 1.4x to 9x, which made the install-time estimate
# optimistic exactly where an author relies on it. These carry roughly 2x
# margin over the measurements.
CELL_OP_NS_PER_CELL = 300
SCALAR_OP_NS = 600
# features does a compare plus two conditional multiply-adds per cell.
FEATURES_NS_PER_CELL = 500


CAPABILITIES = {
    "read_matrix": 1 << 0,
    "read_imu": 1 << 1,
    "emit_event": 1 << 2,
    "drive_led": 1 << 3,
    "write_file": 1 << 4,
}

# Feature fields exposed by the `features` op, in the order the firmware packs them.
FEATURE_FIELDS = (
    "total_force", "peak", "peak01", "peak_index",
    "active_cells", "centroid_row", "centroid_col", "in_contact",
)


@dataclass(frozen=True)
class Op:
    name: str
    #: how many earlier nodes this op consumes
    inputs: int = 0
    #: True when the op sweeps the whole matrix (cost scales with cell count)
    sweep: bool = False
    #: ns per cell for a sweep op
    ns_per_cell: int = CELL_OP_NS_PER_CELL
    #: flat ns for a scalar op
    ns_flat: int = SCALAR_OP_NS
    #: extra required keys on the node
    required: tuple[str, ...] = ()
    #: optional keys the node may carry
    optional: tuple[str, ...] = ()
    #: RAM this op reserves, as floats, given its declared window
    window_key: str | None = None
    #: introduced in this OS version
    since: str = "v1.0.0"
    #: this op produces a boolean, so it may feed threshold/debounce/emit/gate
    boolean: bool = False


def _op(*args, **kwargs) -> Op:
    return Op(*args, **kwargs)


OPS: dict[str, Op] = {op.name: op for op in (
    # --- v1.0.0: shipped, do not change semantics ---------------------------
    _op("total", sweep=True),
    _op("peak", sweep=True),
    _op("region_sum", sweep=True, required=("r0", "c0", "r1", "c1")),
    _op("active_cells", sweep=True, required=("value",)),
    _op("threshold", inputs=1, required=("value",), optional=("hysteresis",), boolean=True),
    _op("debounce", inputs=1, required=("ms",), boolean=True),
    _op("emit", inputs=1, required=("event",)),

    # --- v1.1.0: arithmetic -------------------------------------------------
    _op("const", required=("value",), since="v1.1.0"),
    _op("add", inputs=2, since="v1.1.0"),
    _op("sub", inputs=2, since="v1.1.0"),
    _op("mul", inputs=2, since="v1.1.0"),
    # Division by zero yields 0 rather than NaN, so one bad frame cannot poison
    # every downstream node for the rest of the session.
    _op("div", inputs=2, since="v1.1.0"),
    _op("min", inputs=2, since="v1.1.0"),
    _op("max", inputs=2, since="v1.1.0"),
    _op("abs", inputs=1, since="v1.1.0"),
    _op("clamp", inputs=1, required=("lo", "hi"), since="v1.1.0"),

    # --- v1.1.0: time series (ring buffers sized at load) --------------------
    _op("mean", inputs=1, required=("window",), window_key="window", since="v1.1.0"),
    _op("max_hold", inputs=1, required=("window",), window_key="window", since="v1.1.0"),
    _op("delta", inputs=1, since="v1.1.0"),
    _op("integrate", inputs=1, required=("window",), window_key="window", since="v1.1.0"),
    _op("counter", inputs=1, since="v1.1.0"),

    # --- v1.1.0: richer sweeps ----------------------------------------------
    _op("features", sweep=True, ns_per_cell=FEATURES_NS_PER_CELL, since="v1.1.0"),
    _op("feature_get", inputs=1, required=("field",), since="v1.1.0"),
    _op("arg_max", sweep=True, since="v1.1.0"),
    _op("row_centroid", sweep=True, since="v1.1.0"),
    _op("col_centroid", sweep=True, since="v1.1.0"),

    # --- v1.1.0: output -----------------------------------------------------
    _op("led", inputs=1, required=("rgb",), since="v1.1.0"),
    _op("emit_value", inputs=2, required=("event",), since="v1.1.0"),

    # --- v1.1.0: conditionals for self-degradation --------------------------
    # Branches keep execution bounded (worst case = every node runs); only loops
    # would make it unbounded, and there are none.
    _op("select", inputs=3, since="v1.1.0"),
    _op("gate", inputs=2, since="v1.1.0"),
    _op("budget_load", since="v1.1.0"),
    _op("grace_left", since="v1.1.0"),
)}

V1_0_OPS = frozenset(name for name, op in OPS.items() if op.since == "v1.0.0")


def node_cost_ns(node: dict, cell_count: int) -> int:
    """Worst-case cost of one node. `gate` is charged as if it never skips."""
    op = OPS[str(node.get("op"))]
    if op.sweep:
        return op.ns_per_cell * cell_count
    return op.ns_flat


def graph_cost_us(nodes: list[dict], cell_count: int) -> int:
    total_ns = sum(node_cost_ns(node, cell_count) for node in nodes)
    return (total_ns + 999) // 1000


def graph_memory_bytes(nodes: list[dict]) -> int:
    """Ring-buffer memory a graph reserves. Windows are fixed at load time."""
    total = 0
    for node in nodes:
        op = OPS[str(node.get("op"))]
        if op.window_key:
            total += int(node.get(op.window_key, 0)) * 4
    return total


def min_os_for(nodes: list[dict]) -> str:
    return "v1.1.0" if any(OPS[str(n.get("op"))].since != "v1.0.0" for n in nodes) else "v1.0.0"


def capabilities_mask(names: list[str]) -> int:
    mask = 0
    for name in names:
        mask |= CAPABILITIES[name]
    return mask
