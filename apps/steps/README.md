# Step Counter

Counts heel strikes; kept across reboots, button resets.

Counts heel strikes on the rear half of the matrix and shows the count
and the cadence (steps a minute, from the last two strikes). The count is
kept in the device's NVS, so it survives a reboot; a short press of the action
button starts it over. Uninstalling the app, or installing a new version,
also starts from zero.

**Adjust:** the strike level (`300`) depends on your sensor and wearer.

**Events:** `strike` (rise/fall), `step` (value: the count).

**Needs:** New Horizons OS v1.6.0.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
