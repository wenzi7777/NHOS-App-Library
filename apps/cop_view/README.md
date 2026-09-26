# Centre of Pressure

Front/back and left/right load bias, with lean events.

Where the load sits, as two biases from -1 to +1: front (+) against back,
and right (+) against left, each averaged over half a second so a sway
counts and a footfall does not. A bias past 0.3 raises a lean event.

Built from region sums in percent rather than a centroid in rows and
columns, so a bias means the same thing on any matrix.

**Events:** `lean_front`, `lean_back`, `lean_left`, `lean_right` (rise/fall).

**Needs:** New Horizons OS v1.6.0.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
