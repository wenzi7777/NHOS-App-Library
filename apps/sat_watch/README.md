# Saturation Watch

Flags cells reading at the readout ceiling while it happens.

A cell whose reading reaches the readout circuit's ceiling reports the
ceiling, not the pressure on it. Every frame it spends clipped is data that
cannot be recovered afterwards, so this app says so while you can still
unload the sensor or change the feedback resistor.

While any cell reads 1050 or more for 50 ms, the LED and the last strip pixel
turn red. When the episode ends it reports how many cells it reached and how
long it lasted.

**Adjust:** 1050 suits a feedback resistor of 8.2 kOhm, whose ceiling is about
1110 uS. Set it a little below your own circuit's ceiling (edit
`active(1050)` and rebuild).

**Events:** `clipping` (rise/fall), `clip_cells` (most cells clipped at once),
`clip_ms` (episode length).

**Needs:** New Horizons OS v1.6.0.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
