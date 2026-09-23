// The OLED and the action button: how an app shows something and hears a press.
//
// The screen is part of the executable specification like everything else --
// which row a gated page leaves blank, which frame sees a press -- and the
// Desktop previews it from these same functions, so they have to be right to
// the character.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CompileError,
  OLED_COLS,
  PackageError,
  Simulator,
  canonicalBytes,
  formatOledTextLine,
  formatOledValue,
  oledBarGeometry,
  validatePackage,
} from "../lib/index.mjs";
import { build, clone, flatFrames } from "./helpers.mjs";

/** @param {string} body */
const pkgOf = (body) => build(body).package;

/**
 * @param {Record<string, any>} pkg
 * @param {string} code
 */
function refuses(pkg, code) {
  assert.throws(() => validatePackage(pkg, canonicalBytes(pkg)), (error) => {
    assert.ok(error instanceof PackageError);
    assert.equal(error.code.split(":")[0], code.split(":")[0]);
    if (code.includes(":")) assert.equal(error.code, code);
    return true;
  });
}

describe("compiling show and bar", () => {
  test("show becomes an oled_text node and declares display", () => {
    const { package: pkg, report } = build(`signal heel = total()\nshow 0 "Heel" heel digits 1\n`);
    const node = pkg.nodes.find((/** @type {any} */ n) => n.op === "oled_text");
    assert.deepEqual(node, { op: "oled_text", in: 0, row: 0, label: "Heel", digits: 1 });
    assert.deepEqual(pkg.manifest.capabilities, ["display", "read_matrix"]);
    assert.equal(pkg.manifest.min_os, "v1.4.0");
    assert.ok(report.notes.some((note) => note.message.includes("'app'")));
  });

  test("digits 0 is the default and is left out", () => {
    const pkg = pkgOf(`show 1 "n" total() digits 0\n`);
    assert.equal("digits" in pkg.nodes[1], false);
  });

  test("bar takes a range, which may be negative", () => {
    const pkg = pkgOf(`show 3 "" delta(total())\nbar 2 "Bias" delta(total()) range -50..50\n`);
    const bar = pkg.nodes.find((/** @type {any} */ n) => n.op === "oled_bar");
    assert.equal(bar.lo, -50);
    assert.equal(bar.hi, 50);
    // One delta, shared: the two rows read the same node.
    assert.equal(pkg.nodes.filter((/** @type {any} */ n) => n.op === "delta").length, 1);
  });

  for (const [source, message] of [
    [`show 4 "x" total()\n`, "rows 0 to 3"],
    [`show 0 "much too long" total()\n`, "at most 10"],
    [`show 0 "café" total()\n`, "printable ASCII"],
    [`show 0 "x" total() digits 4\n`, "at most 3"],
    [`bar 0 "x" total() range 10..10\n`, "low to high"],
    [`bar 0 "x" total() range 0..\n`, "expected number"],
  ]) {
    test(`refuses: ${source.trim()}`, () => {
      assert.throws(() => build(source), (error) => error instanceof CompileError && error.reason.includes(message));
    });
  }

  test("show and bar are allowed inside a gate", () => {
    const pkg = pkgOf(`gate (total() > 1) {\n  show 0 "on" total()\n  bar 1 "b" total() range 0..10\n}\n`);
    const gate = pkg.nodes.find((/** @type {any} */ n) => n.op === "gate");
    assert.equal(gate.span, 2);
  });
});

describe("compiling button() and %", () => {
  test("button() declares button, % compiles to mod", () => {
    const pkg = pkgOf(`signal page = counter(button()) % 2\nshow 0 "page" page\n`);
    assert.deepEqual(pkg.nodes.map((/** @type {any} */ n) => n.op), ["button", "counter", "const", "mod", "oled_text"]);
    assert.deepEqual(pkg.manifest.capabilities, ["button", "display", "read_matrix"]);
  });

  test("a graph that never sweeps still declares read_matrix, its clock", () => {
    // Without it the device never wakes the graph, and a press counter would
    // silently never count.
    const pkg = pkgOf(`show 0 "presses" counter(button())\n`);
    assert.ok(pkg.manifest.capabilities.includes("read_matrix"));
  });

  test("% binds like * and /", () => {
    const pkg = pkgOf(`signal x = 1 + total() % 3\nshow 0 "x" x\n`);
    const ops = pkg.nodes.map((/** @type {any} */ n) => n.op);
    assert.ok(ops.indexOf("mod") < ops.indexOf("add"));
  });
});

describe("validating OLED and button nodes", () => {
  const base = () => clone(pkgOf(`signal page = counter(button())\nshow 0 "n" page\nbar 1 "b" page range 0..5\n`));

  test("the compiled package is accepted", () => {
    const report = validatePackage(base());
    assert.equal(report.minOs, "v1.4.0");
  });

  test("each capability must be declared", () => {
    const noDisplay = base();
    noDisplay.manifest.capabilities = ["button", "read_matrix"];
    refuses(noDisplay, "capability_not_declared:display");
    const noButton = base();
    noButton.manifest.capabilities = ["display", "read_matrix"];
    refuses(noButton, "capability_not_declared:button");
  });

  test("a declared list without read_matrix never runs", () => {
    const pkg = base();
    pkg.manifest.capabilities = ["button", "display"];
    refuses(pkg, "never_evaluated:read_matrix_not_declared");
  });

  test("the device's own refusals", () => {
    const row = base();
    row.nodes[2].row = 4;
    refuses(row, "invalid_oled_row:4");
    const label = base();
    label.nodes[2].label = "tab\there";
    refuses(label, "invalid_oled_label");
    const digits = base();
    digits.nodes[2].digits = 7;
    refuses(digits, "invalid_oled_digits:7");
    const range = base();
    range.nodes[3].hi = range.nodes[3].lo;
    refuses(range, "invalid_bar_range");
  });

  test("an older min_os is too low", () => {
    const pkg = base();
    pkg.manifest.min_os = "v1.3.0";
    refuses(pkg, "min_os_too_low:declares_v1.3.0_needs_v1.4.0");
  });
});

describe("formatting, as the device draws it", () => {
  test("rounds half away from zero, from the float's true value", () => {
    assert.equal(formatOledValue(0.5, 0), "1");
    assert.equal(formatOledValue(-0.5, 0), "-1");
    assert.equal(formatOledValue(2.5, 0), "3");
    assert.equal(formatOledValue(0.125, 2), "0.13");
    // 0.1 is 0.100000001490116... in float32, so 1.05 is slightly under and
    // rounds down: the float's value, not the decimal the author typed.
    assert.equal(formatOledValue(1.05, 1), "1.0");
    assert.equal(formatOledValue(12.345, 1), "12.3");
    assert.equal(formatOledValue(7, 3), "7.000");
  });

  test("a negative value that rounds to zero loses its sign", () => {
    assert.equal(formatOledValue(-0.04, 1), "0.0");
    assert.equal(formatOledValue(-0, 0), "0");
  });

  test("what does not fit is #", () => {
    assert.equal(formatOledValue(1e9, 0), "#");
    assert.equal(formatOledValue(1e6, 3), "#");
    assert.equal(formatOledValue(999999.9, 3), "999999.875");
    assert.equal(formatOledValue(Number.NaN, 0), "#");
    assert.equal(formatOledValue(Number.POSITIVE_INFINITY, 0), "#");
  });

  test("a text row is the label, then the value right-aligned", () => {
    const line = formatOledTextLine("Heel", 12.34, 1);
    assert.equal(line.length, OLED_COLS);
    assert.equal(line, "Heel             12.3");
    assert.equal(formatOledTextLine("", 5, 0), `${" ".repeat(20)}5`);
    // Ten label characters leave ten columns for the number.
    assert.equal(formatOledTextLine("abcdefghij", 123456789, 2), "abcdefghij          #");
  });

  test("a bar starts after its label and fills in proportion", () => {
    assert.deepEqual(oledBarGeometry(4, 50, 0, 100), { x0: 30, width: 98, fillPx: 48 });
    assert.deepEqual(oledBarGeometry(0, 150, 0, 100), { x0: 0, width: 128, fillPx: 126 });
    assert.deepEqual(oledBarGeometry(0, -5, 0, 100), { x0: 0, width: 128, fillPx: 0 });
    assert.equal(oledBarGeometry(0, Number.NaN, 0, 100).fillPx, 0);
  });
});

describe("simulating the screen and the button", () => {
  test("rows are drawn from the last frame", () => {
    const sim = new Simulator(pkgOf(`show 0 "Load" total() digits 1\nbar 1 "L" total() range 0..100\n`));
    sim.run(flatFrames([[10, 15.25]]));
    const [text, bar, empty, empty2] = sim.oledRows();
    assert.equal(text?.text, "Load             25.3");
    assert.equal(bar?.kind, "bar");
    assert.equal(bar?.bar?.fillPx, Math.floor(Math.fround(0.25) * (128 - 12 - 2)));
    assert.equal(empty, null);
    assert.equal(empty2, null);
  });

  test("every press is its own rising edge, even back to back", () => {
    const sim = new Simulator(pkgOf(`signal pressed = button()\nshow 0 "n" counter(pressed)\n`));
    const frames = flatFrames([[0], [0], [0], [0], [0]]);
    // Two presses inside one slow frame: true, false, true, false.
    sim.pressButton();
    sim.pressButton();
    const seen = frames.map((frame) => {
      sim.step(frame);
      return sim.nodeValues()[0].bool;
    });
    assert.deepEqual(seen, [true, false, true, false, false]);
    assert.equal(sim.oledRows()[0]?.value, 2);
  });

  test("presses made while no frames arrive do not pile up", () => {
    const sim = new Simulator(pkgOf(`show 0 "n" counter(button())\n`));
    for (let i = 0; i < 10; i += 1) sim.pressButton();
    sim.run(flatFrames(new Array(30).fill([0])));
    assert.equal(sim.oledRows()[0]?.value, 3);
  });

  test("the button pages between two screens, and a closed page is blank", () => {
    const pkg = pkgOf([
      `signal page = counter(button()) % 2`,
      `gate (page < 0.5) {`,
      `  show 0 "total" total()`,
      `  show 1 "first" 1`,
      `}`,
      `gate (page > 0.5) {`,
      `  show 0 "peak" peak()`,
      `}`,
      ``,
    ].join("\n"));
    const sim = new Simulator(pkg);
    const frames = flatFrames([[3, 4], [3, 4], [3, 4], [3, 4]]);
    sim.step(frames[0]);
    assert.equal(sim.oledRows()[0]?.label, "total");
    assert.equal(sim.oledRows()[1]?.label, "first");
    sim.pressButton();
    sim.step(frames[1]);
    assert.equal(sim.oledRows()[0]?.label, "peak");
    assert.equal(sim.oledRows()[0]?.value, 4);
    // Row 1 belonged to the first page only; it must not freeze on its value.
    assert.equal(sim.oledRows()[1], null);
    sim.step(frames[2]);
    sim.pressButton();
    sim.step(frames[3]);
    assert.equal(sim.oledRows()[0]?.label, "total");
  });

  test("mod follows C fmodf, and is 0 for a zero divisor", () => {
    const sim = new Simulator(pkgOf(`show 0 "a" (0 - total()) % 3\nshow 1 "b" total() % 0\n`));
    sim.run(flatFrames([[7]]));
    assert.equal(sim.oledRows()[0]?.value, -1);
    assert.equal(sim.oledRows()[1]?.value, 0);
  });

  test("without button, presses never arrive; without display, nothing shows", () => {
    const pkg = clone(pkgOf(`show 0 "n" counter(button())\n`));
    pkg.manifest.capabilities = ["display", "read_matrix"];
    const deaf = new Simulator(pkg);
    deaf.pressButton();
    deaf.run(flatFrames([[0]]));
    assert.equal(deaf.oledRows()[0]?.value, 0);

    pkg.manifest.capabilities = ["button", "read_matrix"];
    const blind = new Simulator(pkg);
    blind.run(flatFrames([[0]]));
    assert.deepEqual(blind.oledRows(), [null, null, null, null]);
  });

  test("reset forgets pending presses and the screen", () => {
    const sim = new Simulator(pkgOf(`show 0 "n" counter(button())\n`));
    sim.run(flatFrames([[0]]));
    sim.pressButton();
    sim.reset();
    assert.deepEqual(sim.oledRows(), [null, null, null, null]);
    sim.run(flatFrames([[0]]));
    assert.equal(sim.oledRows()[0]?.value, 0);
  });
});
