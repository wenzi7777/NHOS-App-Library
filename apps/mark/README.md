# Experiment Marker

Button press records a numbered mark in the event log.

Each short press of the action button records a `mark` event carrying
its number (1, 2, 3, ...). The Desktop writes app events into the
recording's `.events.csv` next to the frame they happened on, so the marks
line up with the samples: "trial 3 started here" without a stopwatch.

The OLED shows the latest mark number and the seconds since it.

**Events:** `mark` (value: the mark's number).

**Needs:** New Horizons OS v1.6.0; the OLED is optional (v1.0.F / v1.5.F).

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
