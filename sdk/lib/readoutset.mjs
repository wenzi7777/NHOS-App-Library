// @ts-check
/**
 * What a readout package may declare.
 *
 * A readout reads out what the instrument measured. The rule that makes it
 * safe is the same one that makes a flow graph safe: it is DECLARATIVE. It
 * names device commands to read and widgets to draw, and carries no code, so
 * installing one cannot run anything -- which matters more here than on the
 * device side, because this renders in the operator's browser.
 *
 * A readout is installed ON THE DEVICE like any other package, so what a
 * device has travels with the device rather than living in whichever Desktop
 * happened to install it. It occupies a registry entry and nothing else: no
 * slot, no budget, no dispatch.
 *
 * Only real measurements appear here. The device has no per-task RAM
 * accounting and no current sensor, so there are deliberately no fields for
 * either: a column that looks like macOS but is invented would be worse than
 * no column.
 */

/**
 * Device commands a readout may poll. Read-only by construction -- a readout
 * cannot be used to reconfigure or write to a device.
 */
export const ALLOWED_SOURCES = Object.freeze(new Set([
  "task_list",
  "service_list",
  "app_list",
  "app_list_packages",
  "app_events",
  "memory_status",
  "scan_health",
  "storage_status",
  "status",
  "capabilities",
  // v1.6.0: the latest IMU, magnetometer and fuel-gauge readings.
  "sensor_sample",
]));

/**
 * Widget kinds the renderer knows. A chart plots up to MAX_SERIES numeric
 * fields of one source over its last `points` polls; the history lives in the
 * browser, so it starts empty whenever the readout is opened.
 */
export const SECTION_KINDS = Object.freeze(new Set(["stats", "table", "chart"]));

/**
 * How a raw number is presented. Nothing here computes a value the device did
 * not report.
 */
export const FORMATS = Object.freeze(new Set([
  "raw", // as-is
  "int", // thousands separators
  "permille", // 996 -> 99.6%
  "micros", // 1234 -> 1.23ms
  "bytes", // 134008 -> 130.9 KB
  "percent", // 0.42 -> 42%
  "bool", // true/false -> yes/no
  "text",
]));

export const MAX_SOURCES = 8;
export const MAX_SECTIONS = 8;
export const MAX_COLUMNS = 8;
export const MAX_STATS = 12;
export const MAX_SERIES = 4;
export const MIN_CHART_POINTS = 10;
export const MAX_CHART_POINTS = 600;
export const MIN_REFRESH_MS = 500;
export const MAX_REFRESH_MS = 60000;
