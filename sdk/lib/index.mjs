// @ts-check
/**
 * NHOS App SDK: compiler, validator and simulator for New Horizons OS apps.
 * Zero dependencies and no I/O, so the same files run in Node and in the
 * browser. File handling lives in `bin/nhos.mjs`.
 */

export * from "./opset.mjs";
export * as readoutset from "./readoutset.mjs";
export { canonicalBytes, canonicalText, pythonFloatRepr } from "./canonical.mjs";
export { CompileError, LANGUAGE, compileSource, tokenize } from "./compile.mjs";
export { PackageError, validateGraph, validateManifest, validatePackage, validateReadout } from "./validate.mjs";
export { Simulator, computeFeatures, simulate } from "./simulate.mjs";
export { formatOledTextLine, formatOledValue, oledBarGeometry } from "./oled.mjs";
export { extMeterColour, extMeterLit, renderExtLeds } from "./extled.mjs";
export { EVENT_COLUMNS, IMU_COLUMNS, MAG_COLUMNS, compareEvents, formatEventsCsv, inferShape, parseCsvRows, parseEventsCsv, parseSamplesCsv } from "./csv.mjs";
export { analyzeFlow, analyzeReadout, describeCode } from "./analyze.mjs";
