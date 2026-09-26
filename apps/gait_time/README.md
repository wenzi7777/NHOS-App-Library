# Gait Timing

Stance time and stride time for every step.

Temporal gait parameters, per step: stance time (how long the foot was on
the ground) as each step ends, and stride time (strike to strike) as each
begins. Neither uses a window, so a slow walk is timed as accurately as a
fast one. The OLED also shows the duty factor: the share of each stride spent
on the ground.

The very first `stride_ms` of a session is 0: a stride needs two strikes.

**Events:** `stance` (rise/fall), `stance_ms`, `stride_ms`.

**Needs:** New Horizons OS v1.6.0.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
