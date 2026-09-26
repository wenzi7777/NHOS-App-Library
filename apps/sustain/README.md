# Sustained Load

Times continuous loading; alerts after 20 minutes.

A reminder to shift weight. Sustained load on the same place is how
pressure injuries start: this times continuous loading and, past 20 minutes,
turns the LED red and records `relieve`.

The 30 s debounce works both ways: loading starts counting after 30 s, and a
shift resets the clock only if the load is really off for 30 s, so fidgeting
does not.

**Adjust:** the load level (`300`) and the limit (`20` minutes).

**Events:** `loaded`, `overdue` (rise/fall), `relieve` (minutes loaded),
`loaded_min` (length of each loaded period, as it ends).

**Needs:** New Horizons OS v1.6.0.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
