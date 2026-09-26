# Battery & Link

Battery level, link state and time offline; low alert.

The battery's charge, whether the device has a Gateway or Hub to stream
to (the first strip pixel is green while it does), how long it has been
offline, and uptime. Below 15 % for five seconds the LED and the last pixel
turn red and `low_battery` is recorded.

Runs in the background, so it keeps working while nothing is streaming --
which is when you most want to know. A board without a fuel gauge shows -1
and never alerts.

**Events:** `low` (rise/fall), `low_battery` (the charge).

**Needs:** New Horizons OS v1.6.0.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
