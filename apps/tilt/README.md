# Tilt Alarm

Pitch and roll from the IMU; alerts on a lasting lean.

Pitch and roll from the direction of gravity. Mount the board flat,
component side up, in the posture you want to keep: leaning more than 25
degrees for three seconds raises `slouch` and turns the LED red, and how far
it went is reported when it ends. The strip shows the lean as a meter up to
45 degrees.

Gravity is the whole acceleration only while the board is not moving, so
this reads posture, not motion.

**Events:** `slouch` (rise/fall), `slouch_deg` (the largest lean).

**Needs:** New Horizons OS v1.6.0 and a board with an IMU.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
