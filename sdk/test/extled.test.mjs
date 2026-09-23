// The external LED strip: single pixels and a meter along it.
//
// Part of the executable specification like the OLED: which pixel a closed
// gate leaves dark, how many a meter lights for a value -- and the Desktop
// previews the strip from these same functions, so they have to be right to
// the pixel.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CompileError,
  MAX_EXT_LEDS,
  PackageError,
  Simulator,
  canonicalBytes,
  extMeterColour,
  extMeterLit,
  renderExtLeds,
  validatePackage,
} from "../lib/index.mjs";
import { build, flatFrames } from "./helpers.mjs";

/** @param {string} body */
const pkgOf = (body) => build(body).package;

/**
 * @param {Record<string, any>} pkg
 * @param {string} code
 */
function refuses(pkg, code) {
  assert.throws(() => validatePackage(pkg, canonicalBytes(pkg)), (error) => {
    assert.ok(error instanceof PackageError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("compiling pixel and meter", () => {
  test("pixel becomes an ext_pixel node and declares drive_ext_led", () => {
    const { package: pkg, report } = build(`event hit when total() > 10\npixel 4 red when hit\n`);
    const node = pkg.nodes.find((/** @type {any} */ n) => n.op === "ext_pixel");
    assert.deepEqual(node, { op: "ext_pixel", in: 1, index: 4, rgb: "red" });
    assert.deepEqual(pkg.manifest.capabilities, ["drive_ext_led", "emit_event", "read_matrix"]);
    assert.equal(pkg.manifest.min_os, "v1.5.0");
    assert.ok(report.notes.some((note) => note.message.includes("external LED strip")));
  });

  test("meter takes a range, which may be negative", () => {
    const pkg = pkgOf(`meter delta(total()) range -50..50\n`);
    const node = pkg.nodes.find((/** @type {any} */ n) => n.op === "ext_meter");
    assert.deepEqual(node, { op: "ext_meter", in: 1, lo: -50, hi: 50 });
    assert.deepEqual(pkg.manifest.capabilities, ["drive_ext_led", "read_matrix"]);
  });

  test("both work inside a gate", () => {
    const pkg = pkgOf(`event hit when total() > 10\ngate (total() > 5) {\n  pixel 0 green when hit\n  meter total() range 0..100\n}\n`);
    const gate = pkg.nodes.find((/** @type {any} */ n) => n.op === "gate");
    assert.equal(gate.span, 2);
  });

  test("the compiler refuses what the device would", () => {
    const refusal = (/** @type {string} */ body, /** @type {RegExp} */ message) =>
      assert.throws(() => build(body), (error) => error instanceof CompileError && message.test(error.message));
    refusal(`event hit when total() > 1\npixel ${MAX_EXT_LEDS} red when hit\n`, /pixels 0 to 8/);
    refusal(`event hit when total() > 1\npixel 0 purple when hit\n`, /unknown colour 'purple'/);
    refusal(`pixel 0 red when nothing\n`, /unknown event 'nothing'/);
    refusal(`meter total() range 5..5\n`, /from low to high/);
  });
});

describe("validating ext_pixel and ext_meter", () => {
  const base = () => pkgOf(`event hit when total() > 10\npixel 2 blue when hit\nmeter total() range 0..100\n`);

  test("a valid package passes", () => {
    const pkg = base();
    validatePackage(pkg, canonicalBytes(pkg));
  });

  test("the capability must be declared", () => {
    const pkg = base();
    pkg.manifest.capabilities = pkg.manifest.capabilities.filter((/** @type {string} */ c) => c !== "drive_ext_led");
    refuses(pkg, "capability_not_declared:drive_ext_led");
  });

  test("the index, colour and range are checked", () => {
    const pixelAt = (/** @type {Record<string, any>} */ pkg) => pkg.nodes.find((/** @type {any} */ n) => n.op === "ext_pixel");
    let pkg = base();
    pixelAt(pkg).index = 9;
    refuses(pkg, "invalid_ext_led_index:9");
    pkg = base();
    pixelAt(pkg).rgb = "amber";
    refuses(pkg, "unknown_colour:amber");
    pkg = base();
    const meter = pkg.nodes.find((/** @type {any} */ n) => n.op === "ext_meter");
    meter.hi = 0;
    refuses(pkg, "invalid_meter_range:0..0");
  });

  test("older firmware is refused through min_os", () => {
    const pkg = base();
    pkg.manifest.min_os = "v1.4.0";
    refuses(pkg, "min_os_too_low:declares_v1.4.0_needs_v1.5.0");
  });
});

describe("the strip as a board shows it", () => {
  test("a meter lights the fraction rounded up, none at lo, all at hi", () => {
    assert.equal(extMeterLit(0, 0, 100, 9), 0);
    assert.equal(extMeterLit(-5, 0, 100, 9), 0);
    assert.equal(extMeterLit(0.001, 0, 100, 9), 1);
    assert.equal(extMeterLit(50, 0, 100, 9), 5);
    assert.equal(extMeterLit(99.9, 0, 100, 9), 9);
    assert.equal(extMeterLit(100, 0, 100, 3), 3);
    assert.equal(extMeterLit(1e9, 0, 100, 3), 3);
    assert.equal(extMeterLit(Number.NaN, 0, 100, 9), 0);
  });

  test("the meter runs green to red along the strip", () => {
    assert.deepEqual(extMeterColour(0, 9), [0, 255, 0]);
    assert.deepEqual(extMeterColour(8, 9), [255, 0, 0]);
    assert.deepEqual(extMeterColour(1, 3), [127, 127, 0]);
    assert.deepEqual(extMeterColour(0, 1), [0, 255, 0]);
  });

  test("pixels draw over the meter, and past the board's count are not shown", () => {
    const pixels = new Array(MAX_EXT_LEDS).fill(null);
    pixels[0] = [0, 0, 255];
    pixels[5] = [255, 255, 255];
    const strip = renderExtLeds({ meter: { value: 100, lo: 0, hi: 100 }, pixels }, 3);
    assert.deepEqual(strip, [[0, 0, 255], [127, 127, 0], [255, 0, 0]]);
    // "off" is a colour: a pixel can cut a hole in the meter.
    pixels[1] = [0, 0, 0];
    assert.deepEqual(renderExtLeds({ meter: { value: 100, lo: 0, hi: 100 }, pixels }, 3)[1], [0, 0, 0]);
  });
});

describe("simulating the strip", () => {
  test("a pixel is lit only on frames its input is true", () => {
    const sim = new Simulator(pkgOf(`event hit when total() > 10\npixel 1 green when hit\n`));
    const [low, high] = flatFrames([[1, 2], [20, 20]]);
    sim.step(low);
    assert.deepEqual(sim.extLeds(3), [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    sim.step(high);
    assert.deepEqual(sim.extLeds(3), [[0, 0, 0], [0, 255, 0], [0, 0, 0]]);
    sim.step(low);
    assert.deepEqual(sim.extLeds(3)?.[1], [0, 0, 0]);
  });

  test("a pixel inside a closed gate goes dark instead of freezing", () => {
    const sim = new Simulator(pkgOf(`event hit when total() > 10\ngate (peak() > 15) {\n  pixel 0 red when hit\n}\n`));
    const [both, onlyHit] = flatFrames([[20, 1], [6, 6]]);
    sim.step(both);
    assert.deepEqual(sim.extLedFrame()?.pixels[0], [255, 0, 0]);
    sim.step(onlyHit);
    assert.equal(sim.extLedFrame()?.pixels[0], null);
  });

  test("the meter follows its value", () => {
    const sim = new Simulator(pkgOf(`meter total() range 0..90\n`));
    sim.step(flatFrames([[30, 15]])[0]);
    assert.deepEqual(sim.extLedFrame()?.meter, { value: 45, lo: 0, hi: 90 });
    assert.equal(sim.extLeds(9)?.filter((rgb) => rgb.some(Boolean)).length, 5);
  });

  test("a package without drive_ext_led holds nothing", () => {
    const sim = new Simulator(pkgOf(`event hit when total() > 10\nled red when hit\n`));
    sim.step(flatFrames([[20]])[0]);
    assert.equal(sim.canDriveExtLed, false);
    assert.equal(sim.extLedFrame(), null);
    assert.equal(sim.extLeds(9), null);
  });
});
