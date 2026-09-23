// The simulator is the executable specification of the graph's semantics.
//
// How a threshold latches, when a debounce commits, which edge emits -- these
// otherwise exist only in the firmware's C++, where nothing can assert on
// them. Every test here is a statement about behaviour the device must match.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CompileError,
  EVENT_COLUMNS,
  PRESSURE_ACTIVE_THRESHOLD,
  Simulator,
  compareEvents,
  computeFeatures,
  formatEventsCsv,
  parseCsvRows,
  parseEventsCsv,
  parseSamplesCsv,
} from "../lib/index.mjs";
import { build, flatFrames, loadPackage } from "./helpers.mjs";

/** @param {string} body */
const pkgOf = (body) => build(body).package;

/**
 * @param {Record<string, any>} pkg
 * @param {ReturnType<typeof flatFrames>} frames
 */
const run = (pkg, frames) => new Simulator(pkg, { appName: "demo" }).run(frames);

/** @param {Simulator} sim */
const details = (sim) => sim.events.map((e) => e.detail);

describe("threshold", () => {
  test("hysteresis stops an event chattering", () => {
    const sim = run(pkgOf("signal a = total()\nevent hit when a > 10 hyst 4\n"), flatFrames([[10], [9], [7], [10], [5]]));
    // Latches at 10, holds through 9 and 7 (above 10-4=6), releases at 5.
    assert.deepEqual(sim.events.map((e) => [e.event, e.detail]), [["hit", "rise"], ["hit", "fall"]]);
  });

  test("without hysteresis each crossing emits", () => {
    const sim = run(pkgOf("signal a = total()\nevent hit when a > 10\n"), flatFrames([[10], [0], [10], [0]]));
    assert.deepEqual(details(sim), ["rise", "fall", "rise", "fall"]);
  });

  test("the comparison is done in float32, as on the device", () => {
    // In double, 0.7 + 0.1 is 0.7999999999999999 and misses 0.8. In float32
    // -- what the ESP32 computes -- the sum rounds to f32(0.8) and fires.
    const sim = run(pkgOf("signal a = total()\nevent hit when a > 0.8\n"), flatFrames([[0.7, 0.1]]));
    assert.deepEqual(details(sim), ["rise"]);
  });
});

describe("debounce", () => {
  test("a transient shorter than the hold is rejected", () => {
    // 16ms frames: high for two frames (32ms) is not long enough.
    const sim = run(pkgOf("signal a = total()\nevent hit when a > 10 for 50ms\n"), flatFrames([[0], [20], [20], [0], [0], [0]]));
    assert.deepEqual(sim.events, []);
  });

  test("a signal held long enough commits", () => {
    const sim = run(pkgOf("signal a = total()\nevent hit when a > 10 for 50ms\n"), flatFrames([[0], ...Array(6).fill([20])]));
    assert.deepEqual(details(sim), ["rise"]);
  });
});

describe("arithmetic", () => {
  test("a ratio is expressible", () => {
    const pkg = pkgOf("region left = rows 0..0, cols 0..1\nregion right = rows 0..0, cols 2..3\n"
      + "signal l = sum(left)\nsignal r = sum(right)\nsignal bias = (l - r) / (l + r)\nevent lean when bias > 0.3\n");
    // (20-4)/24 = 0.667
    assert.deepEqual(details(run(pkg, flatFrames([[10, 10, 2, 2]], { rows: 1, cols: 4 }))), ["rise"]);
  });

  test("division by zero yields zero, not NaN", () => {
    // A NaN would poison every downstream node for the rest of the session.
    const sim = run(pkgOf("signal a = total()\nsignal b = a / a\nevent hit when b > 0.5\n"), flatFrames([[0], [5]]));
    assert.deepEqual(details(sim), ["rise"]);
  });

  test("peak of an all-negative frame is 0, as on the device", () => {
    const sim = new Simulator(pkgOf("signal p = peak()\nsignal i = arg_max()\nevent hit when p > 1\n"));
    sim.step(flatFrames([[-5, -1, -3]])[0]);
    assert.deepEqual(sim.nodeValues().slice(0, 1).map((v) => v.result), [0]);
    assert.equal(sim.nodeValues().find((v) => v.op === "arg_max")?.result, 0);
  });
});

describe("windows", () => {
  test("mean averages only the samples it has seen", () => {
    // First frame's mean must be 10, not 10/4 -- the device has seen one
    // sample, not one sample and three zeros.
    assert.deepEqual(details(run(pkgOf("signal a = total()\nsignal m = mean(a, 4)\nevent hit when m > 9\n"), flatFrames([[10]]))), ["rise"]);
  });

  test("integrate accumulates over the window", () => {
    assert.deepEqual(details(run(pkgOf("signal a = total()\nsignal s = integrate(a, 3)\nevent hit when s > 25\n"), flatFrames([[10], [10], [10]]))), ["rise"]);
  });

  test("max_hold reports the peak in the window", () => {
    // Still latched on the third frame: 20 is inside the 3-frame window.
    assert.deepEqual(details(run(pkgOf("signal a = total()\nsignal p = max_hold(a, 3)\nevent hit when p > 15\n"), flatFrames([[20], [1], [1]]))), ["rise"]);
  });
});

describe("features", () => {
  test("the centroid weights only loaded cells", () => {
    // Centre of FORCE, not centre of the bounding box.
    assert.equal(computeFeatures({ seq: 0, timestampMs: 0, rows: 1, cols: 4, values: [0, 0, 100, 100] }).centroid_col, 2.5);
  });

  test("cells below the contact threshold do not count", () => {
    const below = PRESSURE_ACTIVE_THRESHOLD - 1;
    const features = computeFeatures({ seq: 0, timestampMs: 0, rows: 1, cols: 2, values: [below, below] });
    assert.equal(features.active_cells, 0);
    assert.equal(features.in_contact, 0);
    // Total force still counts everything -- it is a sum, not a count.
    assert.equal(features.total_force, below * 2);
  });

  test("peak01 is clamped", () => {
    assert.equal(computeFeatures({ seq: 0, timestampMs: 0, rows: 1, cols: 1, values: [99999] }).peak01, 1);
  });

  test("one sweep serves every feature read", () => {
    const pkg = pkgOf("signal t = feature(total_force)\nsignal p = feature(peak)\nevent hit when t > 10\n");
    assert.equal(pkg.nodes.filter((n) => n.op === "features").length, 1);
  });
});

describe("gate", () => {
  const SOURCE = "signal load = budget_load()\ngate (load < 0.9) {\n  signal detail = peak()\n  event spike when detail > 10\n}\n";

  test("a gate block compiles to a span", () => {
    assert.ok(pkgOf(SOURCE).nodes.find((n) => n.op === "gate").span > 0);
  });

  test("the gate precedes what it skips", () => {
    const pkg = pkgOf(SOURCE);
    assert.ok(pkg.nodes.findIndex((n) => n.op === "gate") < pkg.nodes.length - 1);
  });

  test("an open gate lets the block run", () => {
    const sim = run(pkgOf(SOURCE), flatFrames([[50]]));
    assert.ok(sim.events.some((e) => e.event === "spike"));
    assert.ok(!sim.events.some((e) => e.event === "degraded"));
  });

  test("budget pressure closes the gate and the degradation is recorded", () => {
    // The Python simulator hard-wired budget_load to 0, so this path could
    // not be exercised offline at all.
    const sim = new Simulator(pkgOf(SOURCE), { appName: "demo" });
    sim.setBudget(1.2, 1);
    sim.step(flatFrames([[50]])[0]);
    assert.deepEqual(sim.events.map((e) => [e.event, e.detail]), [["degraded", "rise"]]);
    assert.ok(sim.nodeValues().some((v) => v.skipped));
    sim.setBudget(0.5, 3);
    sim.step(flatFrames([[50], [50]])[1]);
    assert.deepEqual(sim.events.slice(1).map((e) => [e.event, e.detail]), [["spike", "rise"], ["degraded", "fall"]]);
  });

  test("an empty gate block is refused", () => {
    assert.throws(() => build("signal load = budget_load()\ngate (load < 0.9) {\n}\n"), (error) => error instanceof CompileError && /empty gate/.test(error.message));
  });
});

describe("outputs the device actually produces", () => {
  test("events need the emit_event capability, as on the device", () => {
    const pkg = pkgOf("signal a = total()\nevent hit when a > 5\n");
    pkg.manifest.capabilities = ["read_matrix"];
    assert.deepEqual(run(pkg, flatFrames([[10]])).events, []);
  });

  test("the LED is driven, not logged as an event", () => {
    const sim = run(pkgOf("signal a = total()\nevent hit when a > 5\nled green when hit\n"), flatFrames([[10], [0]]));
    assert.deepEqual(sim.events.map((e) => e.event), ["hit", "hit"]);
    assert.deepEqual(sim.ledChanges.map((c) => c.colour), ["green", "off"]);
    assert.deepEqual(sim.led, [0, 0, 0]);
  });

  test("emit_value carries its value to three places", () => {
    const sim = run(pkgOf("signal a = total()\nevent hit when a > 5\nemit load value a / 3 on rise(hit)\n"), flatFrames([[10]]));
    const load = sim.events.find((e) => e.event === "load");
    assert.equal(load?.detail, "3.333");
  });

  test("step() returns only that frame's events", () => {
    const sim = new Simulator(pkgOf("signal a = total()\nevent hit when a > 5\n"));
    const [on, off] = flatFrames([[10], [0]]);
    assert.equal(sim.step(on).length, 1);
    assert.equal(sim.step(off)[0].detail, "fall");
  });
});

describe("sidecar", () => {
  test("the output matches the desktop sidecar columns", () => {
    // A simulated run and a real recording have to be comparable row by row.
    const sim = run(pkgOf("signal a = total()\nevent hit when a > 5\n"), flatFrames([[10], [0]]));
    const rows = parseCsvRows(formatEventsCsv(sim.events));
    assert.deepEqual(rows[0], [...EVENT_COLUMNS]);
    assert.equal(rows[1][1], "1000");
    assert.deepEqual(parseEventsCsv(formatEventsCsv(sim.events)), sim.events);
  });

  test("frames are read back with their sequence", () => {
    const [frame] = parseSamplesCsv("timestamp_ms,P1,P2,P3,P4,frame_seq\n0,1,2,3,4,77\n");
    assert.equal(frame.seq, 77);
    assert.deepEqual([...frame.values], [1, 2, 3, 4]);
    // Four cells with no shape given is read as 2x2.
    assert.deepEqual([frame.rows, frame.cols], [2, 2]);
  });

  test("an older recording's Timestamp column is read as milliseconds", () => {
    const frames = parseSamplesCsv("Timestamp,P1,P2\n1716026911000,1,2\n1716026911016,3,4\n", { rows: 1, cols: 2 });
    assert.deepEqual(frames.map((f) => [f.seq, f.timestampMs]), [[0, 1716026911000], [1, 1716026911016]]);
  });

  test("debounce holds across the uint32 wrap of an epoch timestamp", () => {
    // The device's clock is millis(); an epoch-ms recording wraps it, and the
    // hold must still be measured as a difference.
    const pkg = pkgOf("signal a = total()\nevent hit when a > 10 for 50ms\n");
    const start = 2 ** 32 - 20;
    const frames = [0, 20, 20, 20, 20, 20].map((v, i) => ({ seq: i, timestampMs: start + i * 16, values: [v], rows: 1, cols: 1 }));
    assert.deepEqual(details(new Simulator(pkg).run(frames)), ["rise"]);
  });

  test("pressure columns are ordered numerically, not lexically", () => {
    const [frame] = parseSamplesCsv("timestamp_ms,P10,P2,P1\n0,10,2,1\n", { rows: 1, cols: 3 });
    assert.deepEqual([...frame.values], [1, 2, 10]);
  });

  test("simulated events line up with recorded ones on frame_seq", () => {
    const sim = run(pkgOf("signal a = total()\nevent hit when a > 5\n"), flatFrames([[10], [0], [10]]));
    const recorded = [
      { seq: 1, frameSeq: 1000, timestampMs: 0, app: "flow1", event: "hit", detail: "rise", value: null },
      { seq: 2, frameSeq: 1001, timestampMs: 16, app: "flow1", event: "hit", detail: "fall", value: null },
      { seq: 3, frameSeq: 1005, timestampMs: 80, app: "flow1", event: "hit", detail: "rise", value: null },
    ];
    const diff = compareEvents(sim.events, recorded);
    assert.equal(diff.matched.length, 2);
    assert.deepEqual(diff.onlySimulated.map((e) => e.frameSeq), [1002]);
    assert.deepEqual(diff.onlyRecorded.map((e) => e.frameSeq), [1005]);
  });
});

describe("the shipped features app", () => {
  // Seen on hardware: one cell resting near the active threshold made 1.0.0
  // emit a contact fall and a rise 17 ms apart (one frame at 57 fps), over and
  // over, on a mat nobody was touching.
  /** @param {boolean[]} loaded */
  function runApp(loaded) {
    const on = PRESSURE_ACTIVE_THRESHOLD + 5;
    const frames = flatFrames(loaded.map((flag) => [flag ? on : 0, 0]), { msStep: 17 });
    return details(new Simulator(loadPackage("features")).run(frames));
  }

  test("a one-frame dropout is not an event", () => {
    assert.deepEqual(runApp([...Array(10).fill(true), false, ...Array(10).fill(true)]), ["rise"]);
  });

  test("a real release still is", () => {
    assert.deepEqual(runApp([...Array(10).fill(true), ...Array(10).fill(false)]), ["rise", "fall"]);
  });
});
