# Load Strip

Total load as an LED meter; contact and overload pixels.

Total load as a meter along the external LED strip, green at the first
pixel to red at the last. The first pixel turns blue on contact and the last
turns red when any cell nears full scale. A glance at the strip says whether
the sensor is loaded, and how much, without the OLED or the Desktop.

**Adjust:** the meter's range (`0..20000`) and the overload level (`1800`)
depend on your sensor.

**Needs:** New Horizons OS v1.5.0 and a board with the strip (v1.0.F shows 3
pixels, v1.5.F 9).

The source is [`app.nhs`](app.nhs); `app.nha` is compiled from it.
Install from the Apps page in the New Horizons Desktop app.

See the [authoring guide](../../docs/authoring.md) for the op reference and the
cost model.
