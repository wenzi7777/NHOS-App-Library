# Writing an NHOS app

## What an app is

A **flow graph**: an ordered list of nodes, each one an operation on the
pressure matrix or on the result of an earlier node. The device evaluates the
whole list once per frame.

Two properties define the model, and everything else follows from them:

- **A node may only reference an earlier node.** So a cycle cannot be
  expressed, and the array order is already a valid evaluation order.
- **There are no loops.** Execution time therefore has an upper bound equal to
  the sum of every node's cost, which means the cost can be estimated *before*
  the graph ever runs.

There *are* conditionals (`select`, `gate`). Branches do not break the bound —
worst case is simply that every branch runs. Only loops would, and there are
none. The graph is not Turing complete, and that is the point: "tell me at
install time roughly what this costs" and Turing completeness are mutually
exclusive.

Despite that, a graph has state: `threshold` latches, `debounce` times,
`counter` accumulates, and `mean` / `max_hold` / `integrate` each own a
fixed-length ring buffer. It is a finite state machine with real-valued
registers, which covers essentially all of the sensor-event domain.

## The language

You write `.nhs`. The compiler does the three jobs that make hand-writing the
node array miserable: **topological ordering** (inserting an intermediate value
would otherwise renumber every `in`), **common-subexpression elimination** (12
nodes is a brutal budget, and a value used twice would otherwise cost two of
them), and **cost estimation** (otherwise you find out by uploading).

```
app <id> {
  name    "Human readable name"
  version 1.0.0
  author  wenzi7777
  summary "One line, 63 characters."
  category biomechanics        # optional
  icon     foot                # optional, a symbolic name
}

region <name> = rows <a>..<b>, cols <c>..<d>

signal <name> = <expression>

event  <name> when <expression> <cmp> <number> [hyst <number>] [for <n>ms]
emit   <name> value <expression> on rise(<event>)
led    <colour> when <event>
show   <row> "<label>" <expression> [digits <n>]
bar    <row> "<label>" <expression> range <lo>..<hi>

gate (<expression> <cmp> <number> ...) {
  signal / event / emit / led / show / bar statements
}
```

`show` and `bar` draw on the OLED; see [The OLED and the button](#the-oled-and-the-button).

A `gate` block is skipped on frames where its condition is false; the nodes
inside hold their last values. See [Self-degradation](#self-degradation).

Names may contain `-` and `.` (so an author name like `jane-doe` reads as one
word), which means `l-r` is one unknown name, not a subtraction. Write
`l - r`.

Expressions support `+ - * / %`, parentheses, unary minus, numbers,
previously declared signals, and:

| Function | Meaning |
|---|---|
| `sum(region)` | total load over a rectangle |
| `total()` / `peak()` | whole-matrix sum / largest cell |
| `active(threshold)` | count of cells at or above a level |
| `feature(field)` | one field of a single `features` sweep |
| `arg_max()`, `row_centroid()`, `col_centroid()` | peak index, centre of pressure |
| `mean(x, n)`, `max_hold(x, n)`, `integrate(x, n)` | over the last `n` frames |
| `delta(x)`, `abs(x)`, `counter(x)` | |
| `min(a, b)`, `max(a, b)`, `clamp(x, lo, hi)` | |
| `budget_load()`, `grace_left()` | this app's current pressure |
| `button()` | true for one frame per short press of the action button |

`%` is C's `fmodf` (the result takes the sign of the left side) and, like
`/`, gives 0 rather than NaN for a zero divisor. It exists for paging:
`counter(button()) % 3` counts 0, 1, 2, 0, ...

`feature(...)` is the efficient way to read several quantities: every call
shares one `features` sweep, so eight reads cost one sweep plus eight cheap
scalar nodes, not eight sweeps.

`<` and `<=` are supported but compile to a subtraction against a constant,
which costs two extra nodes and pulls the graph up to v1.1.0. The compiler says
so when it happens.

`capabilities` and `min_os` are **derived** from the ops used (and, for
`min_os`, from the graph's size: more than 12 nodes needs v1.3.0; `show`, `bar`,
`button()` and `%` need v1.4.0). `read_matrix` is always among them, even for a
graph that never reads the matrix: the frame is what drives evaluation, and a
graph that may not read it is never woken. Do not declare
them — a hand-written `min_os` that is too low passes here and then fails on the
device as `unknown_op`.

## Hard limits

| Limit | Value | Where it comes from |
|---|---|---|
| Nodes per graph | 24 (12 before OS v1.3.0) | `FlowApp::kMaxNodes`; a graph over 12 gets `min_os: v1.3.0` |
| Package size | 4096 bytes | the firmware's parse buffer |
| App id length | 15 chars | `/files/apps/<id>.nha` vs SPIFFS' 31-char path cap |
| Event name | 23 chars | `FlowNode::event` is `char[24]` |
| Window length | 128 frames | `FlowApp::kMaxWindow` |
| All windows together | 128 floats | `FlowApp::kWindowPool`, one pool per slot |
| Cost per frame | 1500 us | `FlowApp::kDefaultBudgetUs`, or the manifest's `budget_us` if lower |
| Debounce time | 65535 ms | `FlowNode::ms` is a `uint16_t` |
| Region index | 255 | `FlowNode::r0..c1` are `uint8_t` |
| LED colour | red, green, blue, white, off | the firmware's palette |
| OLED rows | 0 to 3 | a 128x32 panel at text size 1 (`kOledRows`) |
| OLED label | 10 printable ASCII characters | `kMaxOledLabel`; the font draws nothing else |
| Decimals | 0 to 3 | `kMaxOledDigits` |
| Presses waiting | 3 | `FlowApp::kMaxPendingPresses` |

The window pool is the one that catches people out: two `mean(x, 100)` are
each within the window limit, but together need 200 floats from a pool of 128,
and the device refuses the graph as `window_pool_exhausted`.

The id limit bites in a confusing place if you ignore it: the Desktop uploads
`apps/<id>.nha` *before* calling `app_install`, so an over-long id fails during
the upload with `path_too_long` and you never see an install error at all.
The validator catches it first.

## Cost model

Sweep operators cost 300 ns per cell (`features` costs 500 ns per cell, since
it does more work per cell); scalar operators cost a flat 600 ns. These were
measured on a v1.5.F (about 86 ns and 235 ns per cell) and carry roughly 2x
margin — the goal is a bound, not a prediction.

`sdk/lib/opset.mjs` holds these constants and the firmware's
`FlowApp::estimateUs()` must agree with them. **That agreement is a
compatibility contract.** If they drift, an app passes locally and is refused
by the device, which is the most confusing failure this system can produce.

`gate` is costed at its worst case — as if it never skips. Costing the average
would understate the bound and make the install-time estimate a lie on exactly
the frames that matter.

## Budgets

An app's time budget is **not fixed**. The device divides a configurable share
of CPU among the apps that are actually running, so enabling a fourth app
shrinks the other three's allocation.

Scanning always wins. If the scan loop starts missing deadlines the apps' share
is reduced automatically, and in the limit every app is suspended — the device
exists to sample the matrix, and apps are additional value on top of that, never
at its expense.

Two states are distinct and must not be confused:

- **Killed** — the app repeatedly exceeded its own allocation. That is the
  app's fault, and an operator has to acknowledge it with `app-revive`.
- **Suspended** — the system needed the capacity. Not the app's fault, and it
  resumes on its own once the pressure clears.

## Self-degradation

An app is told when it is over budget (a `Budget` event carrying its current
load and how many overruns remain before it is stopped). It may respond by
doing less — `gate` an expensive subtree behind `budget_load()`, or `select` a
shorter window — or it may ignore the warning and be stopped. That is the
author's choice, not the system's.

If you do degrade, it is recorded: a `degraded` event is emitted and lands in
the recording's event sidecar. This matters more than it looks. This is a
research data-collection device, and a signal that quietly changes fidelity
because someone enabled another app would put a step change in the data that
has nothing to do with the subject. Recorded, it is merely honest.

## The OLED and the button

An app can show up to four rows on an SSD1306 OLED (128x32, on I2C at 0x3C or
0x3D) and hear short presses of the action button. The OLED is supported on
v1.0.F and v1.5.F, where the panel is external -- anything wired to the board's
exposed I2C bus is picked up once it is turned on.

```
app mat_view {
  name    "Mat View"
  version 1.0.0
  author  wenzi7777
  summary "Heel and toe load on the OLED; press the button for page 2."
}

region heel = rows 8..14, cols 0..14
region toe  = rows 0..6, cols 0..14

signal heel_load = sum(heel)
signal toe_load  = sum(toe)

# Each press advances the page; % 2 wraps it back to the first.
signal page = counter(button()) % 2

gate (page < 0.5) {
  show 0 "Heel" heel_load
  show 1 "Toe" toe_load
  bar  2 "Heel %" heel_load / (heel_load + toe_load) range 0..1
}

gate (page > 0.5) {
  show 0 "Peak" peak()
  show 1 "Cells" active(50)
  show 2 "CoP row" row_centroid() digits 1
}
```

```
|Heel             8676|        |Peak               85|
|Toe              3378|  -->   |Cells             105|
|Heel % [#########   ]|  press |CoP row          11.0|
|                     |        |                     |
```

A row states *what* to show; the firmware does the drawing. So:

- **Drawing costs the app nothing it can overrun.** `show` and `bar` are
  scalar nodes that record a row. The panel is redrawn at the OLED's own
  `update_hz` (at most 5 Hz), outside every app's budget.
- **The screen is rebuilt every frame from the nodes that ran.** A row drawn
  inside a closed `gate` is blank -- it does not freeze on its last value --
  which is what makes gated pages work. Two nodes on one row are fine; the
  later one wins.
- **A text row** is the label at the left and the value right-aligned to column
  21, rounded half away from zero from the float's true value. A value that
  does not fit beside the label is shown as `#`.
- **A bar** starts one character after its label and fills in proportion to
  where the value sits in `range`, clamped at both ends.

`button()` is true for exactly one frame per press and false for at least one
frame between presses, so `counter(button())` counts every press even when two
land in consecutive frames on a slow scan. Only short presses reach an app; a
long press is the soft-off gesture and never does. Presses made while no frames
are arriving are held, at most three, rather than replayed as a burst later.

Nothing appears until the operator sets the device's **OLED page to `app`**
(Settings, or `set-oled` in the Terminal). An installed app never takes the
screen over by itself, the same way it never starts itself. With several apps
running, each row comes from the lowest-numbered slot that drew it, so two apps
can share the panel by using different rows.

## Testing without a device

The Desktop app's SDK page replays a recording, or a live device's stream,
through the graph and shows every node's value as it goes. From the command
line, `simulate` does the same against a recorded sample CSV:

```
node sdk/bin/nhos.mjs simulate apps/heel_strike/app.nhs session.csv \
    --rows 15 --cols 15 --events simulated.events.csv --compare session.events.csv
```

It prints an event timeline, the OLED as the last frame left it, and, with
`--events`, writes the **same
`.events.csv` shape the Desktop writes beside a recording**. `--compare` lines
the simulated events up against the ones the device actually recorded, by
`frame_seq`, and exits non-zero if they differ. `--budget` prints the per-node
cost breakdown. A recording holds no button presses, so `--press 500,1800`
presses the button at those times (ms), each seen by the first frame at or
after it. A recording does not store the matrix shape, so pass
`--rows`/`--cols` for any board that is not square.

The simulator computes in 32-bit float, as the ESP32 does, so a threshold
right on a boundary goes the way it will on the device. It does not model the
device dropping frames: a recording can miss frames the device evaluated,
which shows up as an event a frame or two off.

This is worth more than convenience. The graph's semantics -- how a threshold
latches, when a debounce commits, which edge emits -- otherwise exist only in
the firmware's C++, where nothing can assert on them. The simulator is the
executable specification, and `sdk/test/firmware-contract.test.mjs` reads the
firmware's own sources to check that the constants have not drifted.

## A note on scope

The DSL is **syntactic sugar over the node graph, and nothing more**. If a
construct cannot be lowered to a fixed node array — a loop, a recursive
function, a dynamically sized buffer — it does not belong here, however
convenient it would be. Adding one would force the VM to support it, and the
cost model, the install-time estimate and the load-time rejection all rest on
its absence.
