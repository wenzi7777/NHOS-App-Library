# Tap Counter

Counts presses and times each hold; button resets.

For finger-tapping and press-and-hold exercises. Every press anywhere on
the sensor is counted; when it ends, how long it was held is reported. The
OLED shows the count, the last hold and the rate (presses a minute). A short
press of the action button resets the count.

**Events:** `press` (rise/fall), `tap` (value: the count), `hold_ms` (value:
the hold, reported as it ends).

**Needs:** New Horizons OS v1.6.0.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
