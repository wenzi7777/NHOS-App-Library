# Fall Detector

Impact followed by stillness raises a fall alert.

A hard impact (over 2.5 g), then two seconds without movement, starting
within seven seconds of it. Either alone is common; together they are what a
fall looks like. A fall turns the LED and the last strip pixel red and
records `fallen`.

Runs in the background, so it keeps watching when nothing is streaming. It
then sees the IMU ten times a second instead of once a frame, and a short
impact can fall between two looks: while streaming it is far more reliable.

**Events:** `impact`, `moving`, `fallen` (rise/fall).

**Needs:** New Horizons OS v1.6.0 and a board with an IMU.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
