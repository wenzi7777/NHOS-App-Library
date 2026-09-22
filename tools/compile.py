"""Compile a .nhs source file into a .nha package.

Hand-writing the node array means hand-doing three compiler jobs: topological
ordering (a node may only reference earlier ones, so inserting an intermediate
value renumbers every `in`), common-subexpression elimination (12 nodes is a
brutal budget, and a value used twice would otherwise cost two of them), and
cost estimation (otherwise you find out by uploading).

So the device format stays dumb and verifiable, and the ergonomics live here --
the same split as assembly and a compiler.

Grammar
-------
    app <id> { name "..."  version 1.2.0  author me  summary "..." }
    region <name> = rows <a>..<b>, cols <c>..<d>
    signal <name> = <expr>
    event  <name> when <expr> <cmp> <number> [hyst <number>] [for <n>ms]
    emit   <name> value <expr> on rise(<event>)
    led    <colour> when <event>
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from opset import (  # noqa: E402
    CAPABILITIES, FEATURE_FIELDS, MAX_NODES, OPS,
    graph_cost_us, graph_memory_bytes, min_os_for,
)
from validate import DEFAULT_CELL_COUNT, canonical_bytes, validate_package  # noqa: E402


class CompileError(Exception):
    def __init__(self, message: str, line: int | None = None):
        super().__init__(f"line {line}: {message}" if line else message)
        self.line = line


# --- lexer ------------------------------------------------------------------

TOKEN_RE = re.compile(r"""
    (?P<space>\s+)
  | (?P<comment>\#[^\n]*)
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<semver>\d+\.\d+\.\d+)
  | (?P<number>\d+\.\d+|\d+)
  | (?P<range>\.\.)
  | (?P<name>[A-Za-z_][A-Za-z0-9_.\-]*)
  | (?P<op><=|>=|[{}(),=+\-*/<>])
""", re.VERBOSE)


@dataclass
class Token:
    kind: str
    text: str
    line: int


def tokenize(source: str) -> list[Token]:
    tokens: list[Token] = []
    line = 1
    pos = 0
    while pos < len(source):
        match = TOKEN_RE.match(source, pos)
        if not match:
            raise CompileError(f"unexpected character {source[pos]!r}", line)
        kind = match.lastgroup
        text = match.group()
        line += text.count("\n")
        pos = match.end()
        if kind in ("space", "comment"):
            continue
        tokens.append(Token(kind, text, line))
    tokens.append(Token("eof", "", line))
    return tokens


# --- node builder -----------------------------------------------------------

@dataclass
class Builder:
    """Emits nodes, interning identical ones so a shared value costs one slot."""

    nodes: list[dict] = field(default_factory=list)
    _intern: dict[str, int] = field(default_factory=dict)
    reused: int = 0

    def emit_unique(self, op: str, *, inputs: list[int] | None = None, **params) -> int:
        """Emit without interning, for a node whose fields are patched later."""
        node: dict = {"op": op}
        inputs = inputs or []
        if len(inputs) == 1:
            node["in"] = inputs[0]
        elif inputs:
            node["in"] = list(inputs)
        node.update(params)
        self.nodes.append(node)
        return len(self.nodes) - 1

    def emit(self, op: str, *, inputs: list[int] | None = None, **params) -> int:
        node: dict = {"op": op}
        inputs = inputs or []
        if len(inputs) == 1:
            node["in"] = inputs[0]
        elif inputs:
            node["in"] = list(inputs)
        node.update(params)

        key = json.dumps(node, sort_keys=True)
        if key in self._intern:
            self.reused += 1
            return self._intern[key]
        # Inputs were emitted first, so appending here always keeps every
        # reference pointing backwards.
        self.nodes.append(node)
        index = len(self.nodes) - 1
        self._intern[key] = index
        return index


# --- parser -----------------------------------------------------------------

SWEEP_FUNCS = {"total": "total", "peak": "peak", "arg_max": "arg_max",
               "row_centroid": "row_centroid", "col_centroid": "col_centroid"}
WINDOW_FUNCS = {"mean": "mean", "max_hold": "max_hold", "integrate": "integrate"}
UNARY_FUNCS = {"abs": "abs", "delta": "delta", "counter": "counter"}
BINARY_FUNCS = {"min": "min", "max": "max"}
NULLARY_FUNCS = {"budget_load": "budget_load", "grace_left": "grace_left"}
ARITH_OPS = {"+": "add", "-": "sub", "*": "mul", "/": "div"}

HEADER_STRING_FIELDS = {"name", "summary"}
HEADER_WORD_FIELDS = {"version", "author", "category", "icon"}


class Parser:
    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.pos = 0
        self.builder = Builder()
        self.regions: dict[str, dict] = {}
        self.signals: dict[str, int] = {}
        self.events: dict[str, int] = {}   # event name -> boolean node index
        self.manifest: dict = {}
        self.app_id = ""
        self.graph_name = ""
        self.capabilities: set[str] = set()
        self.notes: list[str] = []

    # -- token helpers --
    @property
    def tok(self) -> Token:
        return self.tokens[self.pos]

    def take(self) -> Token:
        token = self.tok
        self.pos += 1
        return token

    def expect(self, text: str) -> Token:
        if self.tok.text != text:
            raise CompileError(f"expected {text!r}, found {self.tok.text!r}", self.tok.line)
        return self.take()

    def expect_kind(self, kind: str) -> Token:
        if self.tok.kind != kind:
            raise CompileError(f"expected {kind}, found {self.tok.text!r}", self.tok.line)
        return self.take()

    def accept(self, text: str) -> bool:
        if self.tok.text == text:
            self.take()
            return True
        return False

    # -- grammar --
    def parse(self) -> dict:
        self.parse_header()
        while self.tok.kind != "eof":
            keyword = self.tok.text
            if keyword == "region":
                self.parse_region()
            elif keyword == "signal":
                self.parse_signal()
            elif keyword == "event":
                self.parse_event()
            elif keyword == "emit":
                self.parse_emit()
            elif keyword == "led":
                self.parse_led()
            elif keyword == "gate":
                self.parse_gate()
            else:
                raise CompileError(f"unknown statement {keyword!r}", self.tok.line)
        return self.finish()

    def parse_header(self) -> None:
        self.expect("app")
        self.app_id = self.expect_kind("name").text
        self.graph_name = self.app_id
        self.expect("{")
        while not self.accept("}"):
            key = self.expect_kind("name").text
            if key in HEADER_STRING_FIELDS:
                raw = self.expect_kind("string").text
                self.manifest[key] = json.loads(raw)
            elif key in HEADER_WORD_FIELDS:
                token = self.take()
                self.manifest[key] = token.text.strip('"')
            else:
                raise CompileError(f"unknown app field {key!r}", self.tok.line)
        self.manifest["id"] = self.app_id

    def parse_region(self) -> None:
        line = self.tok.line
        self.expect("region")
        name = self.expect_kind("name").text
        self.expect("=")
        self.expect("rows")
        r0 = int(self.expect_kind("number").text)
        self.expect("..")
        r1 = int(self.expect_kind("number").text)
        self.expect(",")
        self.expect("cols")
        c0 = int(self.expect_kind("number").text)
        self.expect("..")
        c1 = int(self.expect_kind("number").text)
        if r0 > r1 or c0 > c1:
            raise CompileError(f"region {name!r} has an inverted range", line)
        self.regions[name] = {"r0": r0, "c0": c0, "r1": r1, "c1": c1}

    def parse_signal(self) -> None:
        self.expect("signal")
        name = self.expect_kind("name").text
        self.expect("=")
        self.signals[name] = self.parse_expr()

    def parse_condition(self) -> int:
        """`<expr> <cmp> <number> [hyst <n>] [for <n>ms]` -> boolean node index."""
        line = self.tok.line
        value_node = self.parse_expr()
        comparison = self.take()
        if comparison.text not in (">", ">=", "<", "<="):
            raise CompileError(f"expected a comparison, found {comparison.text!r}", line)
        limit = float(self.expect_kind("number").text)

        hysteresis = 0.0
        if self.accept("hyst"):
            hysteresis = float(self.expect_kind("number").text)

        if comparison.text in ("<", "<="):
            # threshold is `input >= value`, so flip the expression instead:
            # limit - expr >= 0  <=>  expr <= limit. Costs two extra nodes and
            # pulls the graph up to v1.1.0, which the report states.
            limit_node = self.builder.emit("const", value=limit)
            value_node = self.builder.emit("sub", inputs=[limit_node, value_node])
            self.notes.append(
                f"line {line}: '{comparison.text}' compiled as a subtraction (2 extra nodes)")
            limit = 0.0

        params = {"value": limit}
        if hysteresis:
            params["hysteresis"] = hysteresis
        node = self.builder.emit("threshold", inputs=[value_node], **params)

        if self.accept("for"):
            ms_token = self.expect_kind("number")
            unit = self.expect_kind("name").text
            if unit != "ms":
                raise CompileError(f"expected 'ms', found {unit!r}", ms_token.line)
            node = self.builder.emit("debounce", inputs=[node], ms=int(ms_token.text))
        return node

    def parse_gate(self) -> None:
        """`gate (<condition>) { ... }` -- skip the block when the condition is false.

        The gate node is emitted BEFORE the block, and skips the nodes that
        follow it, because data references only ever point backwards: by the
        time evaluation reaches a gate, anything it referenced has already run.
        The only work a gate can actually avoid is what comes after it.
        """
        self.expect("gate")
        self.expect("(")
        condition = self.parse_condition()
        self.expect(")")
        gate_index = self.builder.emit_unique("gate", inputs=[condition, condition], span=0)
        self.expect("{")
        while not self.accept("}"):
            keyword = self.tok.text
            if keyword == "signal":
                self.parse_signal()
            elif keyword == "event":
                self.parse_event()
            elif keyword == "emit":
                self.parse_emit()
            elif keyword == "led":
                self.parse_led()
            else:
                raise CompileError(f"{keyword!r} is not allowed inside a gate", self.tok.line)
        span = len(self.builder.nodes) - gate_index - 1
        if span == 0:
            raise CompileError("empty gate block", self.tok.line)
        self.builder.nodes[gate_index]["span"] = span

    def parse_event(self) -> None:
        line = self.tok.line
        self.expect("event")
        name = self.expect_kind("name").text
        if len(name) > 23:
            raise CompileError(f"event name {name!r} exceeds 23 characters", line)
        self.expect("when")
        condition = self.parse_condition()
        self.events[name] = condition
        self.builder.emit("emit", inputs=[condition], event=name)
        self.capabilities.add("emit_event")

    def parse_emit(self) -> None:
        line = self.tok.line
        self.expect("emit")
        name = self.expect_kind("name").text
        self.expect("value")
        value = self.parse_expr()
        self.expect("on")
        self.expect("rise")
        self.expect("(")
        event = self.expect_kind("name").text
        self.expect(")")
        if event not in self.events:
            raise CompileError(f"unknown event {event!r}", line)
        self.builder.emit("emit_value", inputs=[self.events[event], value], event=name)
        self.capabilities.add("emit_event")

    def parse_led(self) -> None:
        line = self.tok.line
        self.expect("led")
        colour = self.take().text.strip('"')
        self.expect("when")
        event = self.expect_kind("name").text
        if event not in self.events:
            raise CompileError(f"unknown event {event!r}", line)
        self.builder.emit("led", inputs=[self.events[event]], rgb=colour)
        self.capabilities.add("drive_led")

    # -- expressions --
    def parse_expr(self) -> int:
        node = self.parse_term()
        while self.tok.text in ("+", "-"):
            op = ARITH_OPS[self.take().text]
            node = self.builder.emit(op, inputs=[node, self.parse_term()])
        return node

    def parse_term(self) -> int:
        node = self.parse_factor()
        while self.tok.text in ("*", "/"):
            op = ARITH_OPS[self.take().text]
            node = self.builder.emit(op, inputs=[node, self.parse_factor()])
        return node

    def parse_factor(self) -> int:
        token = self.tok
        if token.text == "(":
            self.take()
            node = self.parse_expr()
            self.expect(")")
            return node
        if token.text == "-":
            self.take()
            zero = self.builder.emit("const", value=0.0)
            return self.builder.emit("sub", inputs=[zero, self.parse_factor()])
        if token.kind == "number":
            self.take()
            return self.builder.emit("const", value=float(token.text))
        if token.kind == "name":
            self.take()
            if self.tok.text == "(":
                return self.parse_call(token)
            if token.text in self.signals:
                return self.signals[token.text]
            raise CompileError(f"unknown value {token.text!r}", token.line)
        raise CompileError(f"unexpected {token.text!r}", token.line)

    #: functions whose arguments are bare names, not expressions
    NAME_ARG_FUNCS = {"sum", "feature"}

    def parse_args(self, callee: str = "") -> list[Token | int]:
        self.expect("(")
        args: list[Token | int] = []
        if self.accept(")"):
            return args
        while True:
            # A bare region or feature-field name is a literal argument, not an
            # expression; anything else is parsed as one.
            if self.tok.kind == "name" and (
                callee in self.NAME_ARG_FUNCS
                or self.tok.text in self.regions
                or self.tok.text in FEATURE_FIELDS
            ):
                args.append(self.take())
            elif self.tok.kind == "number" and self.tokens[self.pos + 1].text in (",", ")"):
                args.append(self.take())
            else:
                args.append(self.parse_expr())
            if not self.accept(","):
                break
        self.expect(")")
        return args

    def parse_call(self, name_token: Token) -> int:
        name = name_token.text
        line = name_token.line
        args = self.parse_args(name)

        def arity(expected: int) -> None:
            if len(args) != expected:
                raise CompileError(f"{name}() takes {expected} argument(s)", line)

        if name == "sum":
            arity(1)
            region = args[0]
            if not isinstance(region, Token) or region.text not in self.regions:
                raise CompileError("sum() takes a region name", line)
            self.capabilities.add("read_matrix")
            return self.builder.emit("region_sum", **self.regions[region.text])

        if name in SWEEP_FUNCS:
            arity(0)
            self.capabilities.add("read_matrix")
            return self.builder.emit(SWEEP_FUNCS[name])

        if name == "active":
            arity(1)
            self.capabilities.add("read_matrix")
            return self.builder.emit("active_cells", value=self._literal(args[0], line))

        if name == "feature":
            arity(1)
            token = args[0]
            if not isinstance(token, Token) or token.text not in FEATURE_FIELDS:
                raise CompileError(
                    f"feature() takes one of {', '.join(FEATURE_FIELDS)}", line)
            self.capabilities.add("read_matrix")
            features = self.builder.emit("features")
            return self.builder.emit("feature_get", inputs=[features], field=token.text)

        if name in WINDOW_FUNCS:
            arity(2)
            window = int(self._literal(args[1], line))
            return self.builder.emit(WINDOW_FUNCS[name], inputs=[self._node(args[0], line)],
                                     window=window)

        if name in UNARY_FUNCS:
            arity(1)
            return self.builder.emit(UNARY_FUNCS[name], inputs=[self._node(args[0], line)])

        if name in BINARY_FUNCS:
            arity(2)
            return self.builder.emit(BINARY_FUNCS[name],
                                     inputs=[self._node(args[0], line), self._node(args[1], line)])

        if name == "clamp":
            arity(3)
            return self.builder.emit("clamp", inputs=[self._node(args[0], line)],
                                     lo=self._literal(args[1], line),
                                     hi=self._literal(args[2], line))

        if name in NULLARY_FUNCS:
            arity(0)
            return self.builder.emit(NULLARY_FUNCS[name])

        raise CompileError(f"unknown function {name!r}", line)

    def _node(self, arg, line: int) -> int:
        """Coerce an argument to a node index, materialising a literal if needed."""
        if isinstance(arg, Token):
            if arg.kind == "number":
                return self.builder.emit("const", value=float(arg.text))
            raise CompileError(f"{arg.text!r} is not a value here", line)
        return arg

    def _literal(self, arg, line: int) -> float:
        """A parameter that the device stores on the node itself, not a wire."""
        if isinstance(arg, Token) and arg.kind == "number":
            return float(arg.text)
        raise CompileError("expected a literal number", line)

    def finish(self) -> dict:
        if not self.builder.nodes:
            raise CompileError("empty program: no signals or events")
        if any(op in ("region_sum", "total", "peak", "features", "active_cells",
                      "arg_max", "row_centroid", "col_centroid")
               for op in (n["op"] for n in self.builder.nodes)):
            self.capabilities.add("read_matrix")

        manifest = dict(self.manifest)
        manifest["capabilities"] = sorted(self.capabilities)
        manifest.setdefault("name", self.app_id)
        manifest["min_os"] = min_os_for(self.builder.nodes)
        return {
            "nhapp": 1,
            "kind": "flow",
            "name": self.graph_name,
            "manifest": manifest,
            "nodes": self.builder.nodes,
        }


# --- driver -----------------------------------------------------------------

def compile_source(source: str) -> tuple[dict, dict]:
    parser = Parser(tokenize(source))
    package = parser.parse()
    nodes = package["nodes"]
    report = {
        "nodes": len(nodes),
        "reused": parser.builder.reused,
        "estimated_us": graph_cost_us(nodes, DEFAULT_CELL_COUNT),
        "memory_bytes": graph_memory_bytes(nodes),
        "min_os": package["manifest"]["min_os"],
        "notes": parser.notes,
        "breakdown": sorted(
            ((n["op"], graph_cost_us([n], DEFAULT_CELL_COUNT)) for n in nodes),
            key=lambda item: -item[1],
        ),
    }
    if len(nodes) > MAX_NODES:
        raise CompileError(
            f"{len(nodes)} nodes exceeds the {MAX_NODES}-node limit. "
            f"Largest contributors: "
            + ", ".join(f"{op} (~{us}us)" for op, us in report["breakdown"][:3])
        )
    return package, report


def compile_file(path: Path) -> tuple[dict, dict]:
    package, report = compile_source(path.read_text(encoding="utf-8"))
    validate_package(package, canonical_bytes(package))
    return package, report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compile .nhs sources to .nha packages")
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--write", action="store_true", help="write app.nha beside the source")
    args = parser.parse_args(argv)

    paths = args.paths or sorted(Path("apps").glob("*/app.nhs"))
    failed = 0
    for path in paths:
        try:
            package, report = compile_file(path)
        except Exception as exc:  # noqa: BLE001 - the message is the report
            print(f"FAIL {path}: {exc}")
            failed += 1
            continue
        if args.write:
            (path.parent / "app.nha").write_bytes(canonical_bytes(package))
        print(f"  ok {path}: {report['nodes']} nodes "
              f"({report['reused']} shared), ~{report['estimated_us']}us, "
              f"{report['memory_bytes']}B ring, needs {report['min_os']}")
        for note in report["notes"]:
            print(f"     note: {note}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
