# Sensor Scope

Live IMU, magnetometer and battery readings, charted.

A readout: it runs in the Desktop, not on the device. It polls the
device's `sensor_sample` twice a second and charts acceleration, rotation
and the magnetic field over the last minute, with the battery beside them --
the same numbers the flow ops `imu()`, `mag()` and `battery()` read.

**Needs:** New Horizons OS v1.6.0 and New Horizons Desktop v0.13.0 or newer
(the chart widget).

The package is [`readout.json`](readout.json).
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
