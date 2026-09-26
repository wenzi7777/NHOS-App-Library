# NHOS App SDK

The compiler, validator and simulator for New Horizons OS apps, in plain
JavaScript with no dependencies. The same files run under Node (the `nhos`
command below) and in the browser (the Desktop app's SDK page vendors
`lib/` and `index.d.ts`).

It replaced the library's original Python tools (`tools/*.py`), after a
parity test showed both produced the same packages and the same events.

## Command line

Node 18 or newer, nothing to install:

```
node sdk/bin/nhos.mjs compile  [app.nhs ...] [--write] [--cells N]
node sdk/bin/nhos.mjs validate [app.nha ...] [--cells N]
node sdk/bin/nhos.mjs simulate <app.nha|app.nhs> <samples.csv> [--rows R --cols C]
                               [--events out.events.csv] [--compare recorded.events.csv] [--budget]
node sdk/bin/nhos.mjs build-index [--check]
node sdk/bin/nhos.mjs check-versions [--base origin/main]
```

`simulate --compare` lines a simulated run up against the `.events.csv` the
Desktop recorded next to the same samples, by `frame_seq`.

## Library

```js
import { analyzeFlow, Simulator, parseSamplesCsv } from "./lib/index.mjs";

const analysis = analyzeFlow(source, { cellCount: 196 });
// analysis.ok, analysis.diagnostics[] (line/col), analysis.report, analysis.bytes

const sim = new Simulator(analysis.package);
for (const frame of parseSamplesCsv(csv, { rows: 14, cols: 14 })) sim.step(frame);
// sim.events, sim.ledChanges, sim.nodeValues()
```

## What changed from the Python tools

Packages are byte-identical: `canonical.mjs` writes numbers the way Python's
`json.dumps` did, so no published `.nha` changes. Behaviour now follows the
firmware more closely:

- The simulator computes in float32 (`Math.fround`), as the ESP32 does.
- `peak`/`arg_max` start from 0 and `delta` from the node's `value`, as in
  `FlowApp.cpp`.
- Events need `emit_event`; LED changes are reported separately, since the
  device drives the LED without logging it.
- `budget_load`/`grace_left` can be driven with `Simulator.setBudget()`.
- The validator refuses what the device would refuse after upload: LED
  colours outside red/green/blue/white/off, windows over the shared 128-float
  pool, graphs over the 1500 us budget, debounce times over 65535 ms, and
  region indices over 255. `min_os` is compared as a version.
- Compile errors carry a column as well as a line.
- For the v1.6.0 ops, `Simulator.setBattery()` / `setLinked()` set what
  `battery()` and `linked()` read, `tick(ms)` runs a `background` graph on the
  device's 10 Hz tick, and `persisted()` with the `restore` option carries
  `persist` counters across a simulated reboot. A frame's `imu` / `mag`
  samples come from a recording's `Acc_*`, `Gyro_*` and `Mag_*` columns.
- `lib/flowmath.mjs` holds the region and angle arithmetic the firmware's
  `FlowMath.cpp` shares; the contract test compiles that file and compares
  them value for value.

## Tests

```
cd sdk && npm test
```

`test/firmware-contract.test.mjs` reads the firmware's sources from
`../NewHorizonsOS-OTA` when it is checked out beside this repository, and
skips otherwise.
