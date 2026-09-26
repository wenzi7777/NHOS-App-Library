# Step Peak

Peak cell and peak load of every step, as it ends.

The highest single cell and the highest total load of each step, reported
once the step ends. The running maximum restarts at every strike, so one
heavy step does not hide the ones after it -- unlike a fixed window.

**Events:** `stance` (rise/fall), `step_cell`, `step_load`.

**Needs:** New Horizons OS v1.6.0.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
