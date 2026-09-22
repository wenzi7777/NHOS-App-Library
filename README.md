# NHOS App Library

The app catalog for **New Horizons OS**. The Desktop app reads `index.json`
from this repository and installs packages from `dist/`.

An app here is a **flow graph**: a small, loop-free dataflow program the device
evaluates once per frame. It is deliberately not a scripting language — see
[docs/authoring.md](docs/authoring.md) for why, and for the op reference.

You write `.nhs`; the compiler produces the `.nha` package. Nobody hand-writes
the node array.

## Layout

```
index.json              the catalog the Desktop app fetches (generated, checked in)
schema/                 JSON Schema for packages, the catalog and library metadata
apps/<id>/
  app.nhs               THE SOURCE -- this is what a PR reviews
  app.nha               compiled package (generated)
  meta.json             catalog-only extras (trilingual name/summary, license)
  icon.svg              96x96, must work on light and dark
  README.md             what the app does, in prose
dist/<id>/
  <id>-<version>.nha    published artifact (generated); never rewritten
  <id>-latest.nha       pointer copy
tools/
  opset.py              op table + cost model -- the single source of truth
  compile.py            .nhs -> .nha
  validate.py           everything the device checks, plus what it cannot
  build_index.py        compiles every app, regenerates dist/ and index.json
  check_versions.py     refuses a changed package that reuses its version
```

## Writing an app

```
app heel_strike {
  name    "Heel Strike"
  version 1.0.0
  author  wenzi7777
  summary "Emits heel_strike on the rear half of the mat."
}

region heel = rows 8..14, cols 0..14

signal heel_load = sum(heel)

event heel_strike when heel_load > 40 hyst 6 for 30ms
```

1. `mkdir apps/<id>` and write `app.nhs`. The id must match
   `^[a-z][a-z0-9_]{0,14}$` — **15 characters maximum**, because
   `/files/apps/<id>.nha` has to fit SPIFFS' 31-character path limit.
2. `python tools/compile.py` until it passes. It reports node count, how many
   nodes were shared, estimated cost and the minimum OS version.
3. `python tools/build_index.py` and commit the generated `app.nha`, `dist/`
   and `index.json` alongside your source.
4. Open a PR. CI re-runs all of the above and additionally requires a version
   bump if you changed an app that already exists.

`capabilities` and `min_os` are **derived from the ops the graph actually
uses**, never declared by hand — a hand-declared `min_os` that is too low is
accepted by the library and then rejected by the device as `unknown_op`.

## Compatibility

An app that sticks to the seven v1.0.0 ops (`total`, `peak`, `region_sum`,
`active_cells`, `threshold`, `debounce`, `emit`) reports `min_os: v1.0.0`, so
its graph is expressible on firmware that predates the package format. Note
that v1.1.0 renamed the engine from "rule" to "flow" and did not keep aliases,
so the commands and file paths differ on either side of that line.

Everything else needs **v1.1.0**, which added arithmetic, time-series
operators, the package registry and multiple app slots.

## Integrity

`index.json` records a sha256 for every package. The Desktop client verifies it
before a package goes anywhere near a device, which is what makes a mutable
`main` download URL safe: a silently edited artifact fails the check rather
than reaching hardware.

## Licence

MPL-2.0. See [LICENSE](LICENSE).
