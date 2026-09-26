// The v1.6.0 language and op set: events as values, time without windows,
// regions that fit any matrix, the other sensors, background running and
// persisted counters.
//
// Like simulate.test.mjs, every simulator assertion here is a statement about
// behaviour the device must match; FlowApp::evaluate is written case for case
// against the same rules.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CompileError,
  PackageError,
  Simulator,
  TICK_FALLBACK_MS,
  compileSource,
  minOsFor,
  validatePackage,
} from "../lib/index.mjs";
import { resolveSpan } from "../lib/flowmath.mjs";
import { HEADER, build, clone, flatFrames } from "./helpers.mjs";

/** @param {string} body */
const pkgOf = (body) => build(body).package;

/**
 * @param {string} body
 * @param {RegExp} pattern
 */
function assertCompileError(body, pattern) {
  assert.throws(() => build(body), (error) => error instanceof CompileError && pattern.test(error.reason));
}

/**
 * @param {unknown} doc
 * @param {string} prefix
 */
function assertRejects(doc, prefix) {
  assert.throws(() => validatePackage(doc), (error) => error instanceof PackageError && error.code.startsWith(prefix));
}

/**
 * Frames of a `rows` x `cols` matrix, one value per frame broadcast to every cell.
 * @param {number[]} levels
 * @param {{rows?: number, cols?: number, msStep?: number, extra?: (index: number) => Record<string, unknown>}} [options]
 */
function levelFrames(levels, { rows = 1, cols = 1, msStep = 16, extra = () => ({}) } = {}) {
  return levels.map((level, index) => ({
    seq: 1000 + index,
    timestampMs: index * msStep,
    values: new Float32Array(rows * cols).fill(level),
    rows,
    cols,
    ...extra(index),
  }));
}

/** @param {Simulator} sim */
const trace = (sim) => sim.events.map((e) => `${e.event}:${e.detail}`);

describe("events as values", () => {
  test("an event name reads as its boolean", () => {
    const { package: pkg } = build("signal a = total()\nevent hit when a > 10\nsignal hits = counter(hit)\nshow 0 \"Hits\" hits\n");
    const sim = new Simulator(pkg).run(flatFrames([[20], [0], [20], [20], [0], [20]]));
    assert.equal(sim.nodeValues().find((v) => v.op === "counter")?.result, 3);
  });

  test("counter() refuses a number, which would count nothing forever", () => {
    assertCompileError("signal a = total()\nsignal n = counter(a)\n", /counter\(\) takes an event or a boolean/);
  });

  test("select() takes an event as its condition", () => {
    const { package: pkg } = build("signal a = total()\nevent hit when a > 10\nsignal s = select(hit, 7, 3)\nshow 0 \"S\" s\n");
    const sim = new Simulator(pkg);
    sim.step(flatFrames([[20]])[0]);
    assert.equal(sim.nodeValues().find((v) => v.op === "select")?.result, 7);
    sim.step(flatFrames([[0]])[0]);
    assert.equal(sim.nodeValues().find((v) => v.op === "select")?.result, 3);
    assertCompileError("signal a = total()\nsignal s = select(a, 1, 0)\n", /select\(\)'s condition/);
  });

  test("a condition may be a boolean without a comparison", () => {
    const { package: pkg } = build("signal a = total()\nevent hit when a > 10\nevent quiet when not(hit) for 32ms\n");
    const sim = new Simulator(pkg, { appName: "demo" }).run(flatFrames([[20], [20], [0], [0], [0], [0]]));
    // hit rises on the first frame, so quiet rises only once hit has been
    // false for 32 ms -- two 16 ms frames after it falls.
    assert.deepEqual(trace(sim), ["hit:rise", "hit:fall", "quiet:rise"]);
  });

  test("gate accepts an event directly", () => {
    const { package: pkg } = build("signal a = total()\nevent on when a > 10\ngate (on) {\n  show 0 \"A\" a\n}\n");
    const sim = new Simulator(pkg);
    sim.step(flatFrames([[0]])[0]);
    assert.equal(sim.oledRows()[0], null);
    sim.step(flatFrames([[20]])[0]);
    assert.equal(sim.oledRows()[0]?.value, 20);
  });
});

describe("emit on fall", () => {
  test("reports once the event ends, never at start-up", () => {
    const { package: pkg } = build("signal a = total()\nevent step when a > 10\nsignal p = peak_since(a, step)\nemit step_peak value p on fall(step)\n");
    assert.equal(pkg.nodes.find((n) => n.op === "emit_value").fall, 1);
    const sim = new Simulator(pkg, { appName: "demo" }).run(flatFrames([[0], [0], [15], [40], [25], [0], [0], [12], [18], [0]]));
    assert.deepEqual(trace(sim), ["step:rise", "step:fall", "step_peak:40.000", "step:rise", "step:fall", "step_peak:18.000"]);
  });
});

describe("time without windows", () => {
  test("duration() times how long an event has held", () => {
    const { package: pkg } = build("signal a = total()\nevent on when a > 10\nsignal d = duration(on)\nshow 0 \"D\" d\n");
    const sim = new Simulator(pkg);
    const values = [];
    for (const frame of flatFrames([[0], [20], [20], [20], [0], [20]], { msStep: 100 })) {
      sim.step(frame);
      values.push(sim.nodeValues().find((v) => v.op === "duration")?.result);
    }
    assert.deepEqual(values, [0, 0, 100, 200, 0, 0]);
  });

  test("duration() is not limited to 128 frames", () => {
    const { package: pkg } = build("signal a = total()\nevent on when a > 10\nsignal d = duration(on)\nshow 0 \"D\" d\n");
    const sim = new Simulator(pkg).run(flatFrames(Array.from({ length: 2000 }, () => [20]), { msStep: 1000 }));
    assert.equal(sim.nodeValues().find((v) => v.op === "duration")?.result, 1999000);
  });

  test("interval() measures rise to rise, and is 0 until the second rise", () => {
    const { package: pkg } = build("signal a = total()\nevent on when a > 10\nsignal i = interval(on)\nshow 0 \"I\" i\n");
    const sim = new Simulator(pkg);
    const values = [];
    for (const frame of flatFrames([[20], [0], [0], [20], [0], [20]], { msStep: 50 })) {
      sim.step(frame);
      values.push(sim.nodeValues().find((v) => v.op === "interval")?.result);
    }
    assert.deepEqual(values, [0, 0, 0, 150, 150, 100]);
  });

  test("counter(x, reset) zeroes on the reset's rise", () => {
    const { package: pkg } = build("signal a = total()\nevent on when a > 10\nsignal n = counter(on, button())\nshow 0 \"N\" n\n");
    const sim = new Simulator(pkg);
    for (const frame of flatFrames([[20], [0], [20], [0]])) sim.step(frame);
    assert.equal(sim.nodeValues().find((v) => v.op === "counter_reset")?.result, 2);
    sim.pressButton();
    sim.step(flatFrames([[0]])[0]);
    assert.equal(sim.nodeValues().find((v) => v.op === "counter_reset")?.result, 0);
  });
});

describe("relative regions", () => {
  test("percent bounds resolve against the frame's own shape", () => {
    assert.deepEqual(resolveSpan(0, 50, true, 15), { lo: 0, hi: 7 });
    assert.deepEqual(resolveSpan(50, 100, true, 15), { lo: 7, hi: 14 });
    assert.deepEqual(resolveSpan(0, 50, true, 4), { lo: 0, hi: 1 });
    assert.deepEqual(resolveSpan(50, 100, true, 4), { lo: 2, hi: 3 });
    // Never empty on a non-empty matrix.
    assert.deepEqual(resolveSpan(40, 41, true, 2), { lo: 0, hi: 0 });
    assert.deepEqual(resolveSpan(100, 100, true, 5), { lo: 4, hi: 4 });
    assert.deepEqual(resolveSpan(3, 9, false, 5), { lo: 3, hi: 9 });
  });

  test("one package sums the same half of a 5x7 and a 15x15 matrix", () => {
    const pkg = pkgOf("region left = rows 0%..100%, cols 0%..50%\nsignal l = sum(left)\nshow 0 \"L\" l\n");
    const node = pkg.nodes.find((n) => n.op === "region_sum");
    assert.equal(node.rel, 3);
    for (const [rows, cols, expected] of [[5, 7, 5 * 4], [15, 15, 15 * 8]]) {
      const sim = new Simulator(pkg).run(levelFrames([1], { rows, cols }));
      assert.equal(sim.nodeValues()[0].result, expected, `${rows}x${cols}`);
    }
  });

  test("an absolute region compiles exactly as before", () => {
    const pkg = pkgOf("region heel = rows 8..14, cols 0..14\nsignal h = sum(heel)\nevent hit when h > 40\n");
    assert.deepEqual(pkg.nodes[0], { op: "region_sum", r0: 8, c0: 0, r1: 14, c1: 14 });
    assert.equal(pkg.manifest.min_os, "v1.0.0");
  });

  test("rows and columns may use different units, one span may not", () => {
    const pkg = pkgOf("region top = rows 0..2, cols 0%..100%\nsignal t = sum(top)\nshow 0 \"T\" t\n");
    assert.equal(pkg.nodes[0].rel, 2);
    assertCompileError("region bad = rows 0..50%, cols 0..3\n", /mixes an index and a percent/);
    assertCompileError("region bad = rows 0%..120%, cols 0..3\n", /exceeds 100%/);
  });

  test("peak, active and the centroids work over a region", () => {
    const pkg = pkgOf([
      "region right = rows 0%..100%, cols 50%..100%",
      "signal p = peak(right)",
      "signal n = active(right, 5)",
      "signal r = row_centroid(right)",
      "signal c = col_centroid(right)",
      "show 0 \"P\" p",
      "show 1 \"N\" n",
      "show 2 \"R\" r",
      "show 3 \"C\" c",
      "",
    ].join("\n"));
    assert.deepEqual(pkg.nodes.slice(0, 4).map((n) => n.op), ["region_peak", "region_active", "region_row_centroid", "region_col_centroid"]);
    // 2x4: only the right half's bottom-right cell is loaded.
    const values = new Float32Array([100, 0, 0, 0, 0, 0, 3, 200]);
    const sim = new Simulator(pkg).run([{ seq: 1, timestampMs: 0, values, rows: 2, cols: 4 }]);
    const out = sim.nodeValues().map((v) => v.result);
    // Peak 200 (the left half's 100 is outside), one cell >= 5, centroid at
    // whole-matrix row 1, column 3 (the 3 is under the contact threshold).
    assert.deepEqual(out.slice(0, 4), [200, 1, 1, 3]);
  });
});

describe("the other sensors", () => {
  test("imu() needs read_imu, and holds without a sample", () => {
    const { package: pkg } = build("signal x = imu(ax)\nsignal t = imu(pitch)\nshow 0 \"X\" x\n");
    assert.ok(pkg.manifest.capabilities.includes("read_imu"));
    assert.equal(pkg.manifest.min_os, "v1.6.0");
    const sim = new Simulator(pkg);
    sim.step({ ...levelFrames([0])[0], imu: [0.5, 0, 0.8660254, 0, 0, 0] });
    assert.equal(sim.nodeValues()[0].result, Math.fround(0.5));
    assert.ok(Math.abs(sim.nodeValues()[1].result - -30) < 0.01);
    sim.step(levelFrames([0])[0]);
    assert.equal(sim.nodeValues()[0].result, Math.fround(0.5), "held");

    const stripped = clone(pkg);
    stripped.manifest.capabilities = stripped.manifest.capabilities.filter((c) => c !== "read_imu");
    const blind = new Simulator(stripped);
    blind.step({ ...levelFrames([0])[0], imu: [0.5, 0, 0.8660254, 0, 0, 0] });
    assert.equal(blind.nodeValues()[0].result, 0, "the device strips the sample");
    assertRejects(stripped, "capability_not_declared:read_imu");
  });

  test("mag() reads microtesla and a 0-360 heading", () => {
    const { package: pkg } = build("signal h = mag(heading)\nsignal s = mag(strength)\nshow 0 \"H\" h\n");
    assert.ok(pkg.manifest.capabilities.includes("read_mag"));
    const sim = new Simulator(pkg);
    sim.step({ ...levelFrames([0])[0], mag: [0, -30, 40] });
    const [heading, strength] = sim.nodeValues().map((v) => v.result);
    assert.ok(Math.abs(heading - 270) < 0.01);
    assert.ok(Math.abs(strength - 50) < 0.001);
    assertCompileError("signal h = mag(north)\n", /mag\(\) takes one of/);
  });

  test("battery() is -1 without a reading, linked() false without a link", () => {
    const { package: pkg } = build("signal b = battery()\nevent up when linked()\nshow 0 \"B\" b\n");
    assert.ok(pkg.manifest.capabilities.includes("power"));
    assert.ok(pkg.manifest.capabilities.includes("link"));
    const sim = new Simulator(pkg, { appName: "demo" });
    sim.step(levelFrames([0])[0]);
    assert.equal(sim.nodeValues()[0].result, -1);
    sim.setBattery(62.5);
    sim.setLinked(true);
    sim.step(levelFrames([0])[0]);
    assert.equal(sim.nodeValues()[0].result, 62.5);
    assert.deepEqual(trace(sim), ["up:rise"]);
  });

  test("sqrt() and atan2() compute in degrees", () => {
    const { package: pkg } = build("signal r = sqrt(16)\nsignal n = sqrt(0 - 4)\nsignal a = atan2(1, 0)\nshow 0 \"R\" r\n");
    const sim = new Simulator(pkg).run(levelFrames([0]));
    const byOp = Object.fromEntries(sim.nodeValues().map((v) => [v.op, v.result]));
    assert.equal(byOp.atan2, Math.fround(Math.fround(Math.PI / 2) * Math.fround(57.29578)));
    const sqrts = sim.nodeValues().filter((v) => v.op === "sqrt").map((v) => v.result);
    assert.deepEqual(sqrts, [4, 0]);
  });
});

describe("background running", () => {
  test("`background yes` declares tick and pulls min_os to v1.6.0", () => {
    const source = HEADER.replace("}\n", "  background yes\n}\n") + "signal u = uptime()\nshow 0 \"Up\" u\n";
    const { package: pkg } = compileSource(source);
    assert.ok(pkg.manifest.capabilities.includes("tick"));
    assert.equal(pkg.manifest.min_os, "v1.6.0");
  });

  test("ticks evaluate only while frames are absent, and matrix reads hold", () => {
    const source = HEADER.replace("}\n", "  background yes\n}\n") + "signal a = total()\nsignal u = uptime()\nshow 0 \"A\" a\n";
    const { package: pkg } = compileSource(source);
    const sim = new Simulator(pkg);
    sim.step({ seq: 1, timestampMs: 1000, values: [42], rows: 1, cols: 1 });
    assert.deepEqual(sim.tick(1000 + TICK_FALLBACK_MS - 1), []);
    assert.equal(sim.ticks, 0, "a frame arrived too recently");
    sim.tick(1000 + TICK_FALLBACK_MS);
    assert.equal(sim.ticks, 1);
    const [total, uptime] = sim.nodeValues().map((v) => v.result);
    assert.equal(total, 42, "held from the last frame");
    assert.equal(uptime, Math.fround((1000 + TICK_FALLBACK_MS) / 1000));
  });

  test("a graph without tick never runs on one", () => {
    const sim = new Simulator(pkgOf("signal a = total()\nshow 0 \"A\" a\n"));
    sim.tick(10_000);
    assert.equal(sim.ticks, 0);
  });
});

describe("persisted counters", () => {
  test("`persist` marks the counter and declares the capability", () => {
    const { package: pkg } = build("signal a = total()\nevent on when a > 10\nsignal n = counter(on) persist\nshow 0 \"N\" n\n");
    const counter = pkg.nodes.find((n) => n.op === "counter");
    assert.equal(counter.persist, 1);
    assert.ok(pkg.manifest.capabilities.includes("persist"));
    // counter is a v1.1.0 op, but a v1.5 device would drop the flag silently.
    assert.equal(pkg.manifest.min_os, "v1.6.0");
  });

  test("only a counter can persist", () => {
    assertCompileError("signal a = total() persist\n", /only a counter\(\) can persist/);
  });

  test("a restored count carries on", () => {
    const { package: pkg } = build("signal a = total()\nevent on when a > 10\nsignal n = counter(on) persist\nshow 0 \"N\" n\n");
    const first = new Simulator(pkg).run(flatFrames([[20], [0], [20], [0]]));
    const saved = first.persisted();
    assert.deepEqual(Object.values(saved), [2]);
    const rebooted = new Simulator(pkg, { restore: saved }).run(flatFrames([[20]]));
    assert.equal(rebooted.nodeValues().find((v) => v.op === "counter")?.result, 3);
  });
});

describe("validation of the v1.6.0 fields", () => {
  const base = () => pkgOf("region r = rows 0%..50%, cols 0..3\nsignal a = sum(r)\nevent on when a > 1\nsignal n = counter(on) persist\nemit e value n on fall(on)\n");

  test("the compiled package validates", () => {
    assert.equal(validatePackage(base()).minOs, "v1.6.0");
  });

  test("a percentage over 100 is refused", () => {
    const doc = base();
    doc.nodes[0].r1 = 150;
    assertRejects(doc, "invalid_region_percent");
  });

  test("rel outside 1..3, or on a non-region op, is refused", () => {
    const doc = base();
    doc.nodes[0].rel = 4;
    assertRejects(doc, "invalid_region_rel");
    const other = base();
    other.nodes[1].rel = 1;
    assertRejects(other, "unexpected_field:threshold.rel");
  });

  test("persist without the capability, or on another op, is refused", () => {
    const doc = base();
    doc.manifest.capabilities = doc.manifest.capabilities.filter((c) => c !== "persist");
    assertRejects(doc, "capability_not_declared:persist");
    const other = base();
    other.nodes[1].persist = 1;
    assertRejects(other, "unexpected_field:threshold.persist");
  });

  test("a hand-lowered min_os is refused", () => {
    const doc = base();
    doc.manifest.min_os = "v1.5.0";
    assertRejects(doc, "min_os_too_low");
  });

  test("min_os is derived from fields and capabilities too", () => {
    assert.equal(minOsFor([{ op: "region_sum", r0: 0, c0: 0, r1: 1, c1: 1, rel: 1 }]), "v1.6.0");
    assert.equal(minOsFor([{ op: "total" }], ["tick"]), "v1.6.0");
    assert.equal(minOsFor([{ op: "total" }], ["read_matrix"]), "v1.0.0");
  });
});

describe("boolean signals as triggers", () => {
  test("emit, led and pixel accept a boolean signal, and log nothing extra", () => {
    const { package: pkg } = build("signal press = button()\nsignal n = counter(press)\nemit mark value n on rise(press)\nled white when press\n");
    assert.deepEqual(pkg.nodes.map((node) => node.op), ["button", "counter", "emit_value", "led"]);
    const sim = new Simulator(pkg, { appName: "demo" });
    sim.pressButton();
    sim.run(flatFrames([[0], [0], [0]]));
    assert.deepEqual(trace(sim), ["mark:1.000"]);
  });

  test("a numeric signal is refused as a trigger", () => {
    assertCompileError("signal a = total()\nled red when a\n", /is a number, not an event or a boolean/);
  });
});

describe("signed limits", () => {
  test("a condition may compare against a negative number", () => {
    const { package: pkg } = build("signal a = total() - 10\nevent low when a < -5\n");
    const sim = new Simulator(pkg, { appName: "demo" }).run(flatFrames([[8], [4], [8]]));
    assert.deepEqual(trace(sim), ["low:rise", "low:fall"]);
  });
});

describe("negative literals", () => {
  test("fold into one constant", () => {
    const { package: pkg } = build("signal a = total() * -2\nshow 0 \"A\" a\n");
    assert.deepEqual(pkg.nodes.map((node) => node.op), ["total", "const", "mul", "oled_text"]);
    assert.equal(pkg.nodes[1].value, -2);
  });

  test("negating anything else still subtracts from zero", () => {
    const { package: pkg } = build("signal a = -total()\nshow 0 \"A\" a\n");
    assert.deepEqual(pkg.nodes.map((node) => node.op), ["const", "total", "sub", "oled_text"]);
  });
});

describe("recordings feed the sensors", () => {
  test("the Acc_*, Gyro_* and Mag_* columns become imu and mag samples", async () => {
    const { parseSamplesCsv } = await import("../lib/index.mjs");
    const csv = [
      "timestamp_ms,P1,P2,P3,P4,Mag_x,Mag_y,Mag_z,Gyro_x,Gyro_y,Gyro_z,Acc_x,Acc_y,Acc_z,frame_seq",
      "1000,1,2,3,4,30,-5,12,1.5,2.5,3.5,0.1,0.2,0.97,7",
    ].join("\n");
    const [frame] = parseSamplesCsv(csv);
    assert.deepEqual([...(frame.imu ?? [])], [0.1, 0.2, 0.97, 1.5, 2.5, 3.5].map(Math.fround));
    assert.deepEqual([...(frame.mag ?? [])], [30, -5, 12]);
    const { package: pkg } = build("signal z = imu(az)\nsignal h = mag(mx)\nshow 0 \"Z\" z\n");
    const sim = new Simulator(pkg).run([frame]);
    assert.deepEqual(sim.nodeValues().slice(0, 2).map((v) => v.result), [Math.fround(0.97), 30]);
  });

  test("an old recording without them has no samples", async () => {
    const { parseSamplesCsv } = await import("../lib/index.mjs");
    const [frame] = parseSamplesCsv("timestamp_ms,P1,frame_seq\n5,1,1\n");
    assert.equal(frame.imu, undefined);
    assert.equal(frame.mag, undefined);
  });
});
