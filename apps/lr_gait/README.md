# Left/Right Symmetry

Left/right load share and peaks; flags lasting asymmetry.

Each half's share of the load (averaged over a second), each half's peak
cell, and a `lopsided` event when the split stays more than 65/35 for two
seconds. The halves are percentages, so this works on any matrix, including
two insoles laid side by side.

**Events:** `lopsided` (rise/fall), `share` (the left share when it began).

**Needs:** New Horizons OS v1.6.0.

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
