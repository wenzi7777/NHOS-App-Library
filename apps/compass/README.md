# Compass

Heading and field strength; detects a nearby magnet.

Heading from the magnetometer (0-360 degrees; the first strip pixel turns
blue within 15 degrees of magnetic north) and the field strength. The
heading is not tilt-compensated, so it is a compass only while the board lies
flat.

The field strength works in any orientation, and a nearby magnet raises it
far above the Earth's 25-65 uT: over 150 uT raises `magnet`, a contact-free
switch.

**Events:** `north`, `magnet` (rise/fall), `magnet_ut` (the strongest field
while the magnet was near).

**Needs:** New Horizons OS v1.6.0 and a board with a magnetometer.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
