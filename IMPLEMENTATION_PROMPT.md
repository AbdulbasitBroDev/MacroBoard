# MacroBoard — Feature Implementation Prompt

Paste the contents of this file into a fresh opencode session to resume this work.

---

## Context

We are adding 23 features to **MacroBoard**, an existing Windows desktop macro builder at
`C:\Users\abdul\Desktop\ForStudy\ForStudy\MacroBoards`.

Read `README.md` first — it is the de-facto spec. Then read `src/shared/constants.js`,
`src/shared/catalog.js`, `src/blockly/blocks.js`, `src/blockly/compiler.js`,
`src/blockly/fields.js`, `src/main/engine/engine.js`, `src/main/orchestrator.js`,
`src/main/services/*`, `src/renderer/js/app.js`, `src/renderer/index.html`.

### What the app is

Electron + Blockly. Users drag-and-drop blocks to build a macro. The workspace compiles to a
plain JSON step list. The main process interprets that step list using three native services:
`inputService` (nut-js simulate), `hookService` (uiohook global detect), `pixelService`
(desktopCapturer pixel reads). Macros persist as JSON in `%APPDATA%\MacroBoard\`.

There is **no build step**. Shared files under `src/shared/` and `src/blockly/` are UMD modules
usable from `require()` (main), `<script>` (renderer) and `require()` (test). Follow that pattern
for anything new that both sides need.

### Current baseline (verified)

```
Blocks          21   (src/shared/catalog.js:22-56, definitions in src/blockly/blocks.js)
Step types      12   (src/shared/constants.js:122-134)
Start types      4   (run, press, hold, pixel)
Categories       5   (START, MOUSE, KEYBOARD, CONTROL, VALUES)  src/shared/constants.js:87-93
Custom fields    4   (src/blockly/fields.js:445-466)
Value chips      3   (number, forever, between)                 src/blockly/blocks.js:733-770
Tests          164   across 9 files, all passing
                node --test --test-concurrency=1 "test/*.test.js"
```

### Target after all 23

```
Blocks          51   (+30)
Step types      23   (+11)
Start types      8   (+4)
Categories       6   (+LOGIC)
Custom fields    6   (+display picker, +window picker)
Value chips      4   (+random number)
Tests          260+  (4 new suites)
```

---

## Ground rules

1. **Do not implement anything not on this list.** Notably absent: #3 zoom presets, #4 block
   comments, #8 variables, #12 wait-until-pixel, #16 double-click, #17 mouse hold, #20 window
   movement/resize, #26 scan-region-for-colour, #27 region picker, #29 save screenshot,
   #33 dry-run/step-through, #35 per-macro settings block, #36 template gallery, #37 record
   region, #39 record edit pass, #40 doc fixes.

2. **Backward compatibility is mandatory.** Existing user macros are saved JSON in AppData.
   Old files must load and run unchanged. New step types must be ignored or rejected
   gracefully by anything that doesn't understand them. Never renumber or repurpose an
   existing `mb_*` id or STEP constant.

3. **No build step, no new runtime dependencies** unless explicitly approved. No bundler, no
   framework in the renderer, no FFI library. Window access (#24, #30, #31) goes through
   PowerShell shelling out from the main process — see "Window service" below.

4. **Every step type needs engine support, not just a compiler branch.** The engine is
   `src/main/engine/engine.js`. The gate between them is `src/main/engine/gate.js` and
   `src/main/engine/timing.js`.

5. **Test everything.** Each feature lands with tests in `test/`, following the existing
   pattern in `test/helpers/env.js` (real Blockly, headless). Run the full suite before
   reporting done. It must be green and longer than 164 tests.

6. **Work in small verified increments.** One feature, its tests, suite green, then the next.
   Do not attempt all 23 in one pass — the compiler and engine rework in particular will
   conflict if done all at once. Proposed order below.

7. **Match existing style.** Look at a neighbouring block definition before writing one.
   Same comment density, same field conventions, same naming. No new comment conventions.

---

## The 23 features

Grouped by dependency, not by original number. Each says what to build.

### Tier 0 — foundations (do first, everything leans on these)

**#28 — Multi-monitor / DPI correctness**
Not a feature, a bug fix. `README.md:429` lists this as unverified. Two parts:
- Call `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)` in
  `src/main/main.js` **before any BrowserWindow is created**. Without per-monitor awareness,
  Windows scales coordinates and pixel triggers fire on the wrong monitor.
- `pixelService` must select a display by index instead of assuming the primary one
  (currently reads the primary display's capture).

Add a display dropdown field so pixel blocks can target a specific monitor.
New custom field: `field_mb_display`.

**Error model (prerequisite for #22 and #25)**
The engine currently has no notion of a failed step. Introduce one before building retry or
abort. Steps that can time out (#24) must produce a catchable error. Design it first — this is
foundational and both #22 and #25 depend on it.

**#7 — Boolean operators and math (12 blocks)**
New `LOGIC` category. Boolean reporters: `and`, `or`, `not`, `=`, `>`, `<`.
Math reporters: `+`, `-`, `*`, `/`, `mod`, `round`.
Add `random number` as a 4th value chip.

These are pure expression nodes — they inline into numeric/boolean sockets and produce
**no new step types**. Needs a new shared UMD module `src/shared/expressions.js` exporting
`evalNumber` and `evalBoolean`, so the compiler, engine and tests all share one evaluator.
Single source of truth matters: the same expression must evaluate identically in all three.

**#6 — if/else (1 block, 1 step type)**
```
if <boolean> then
  ...
else
  ...
```
Define your own `mb_control_if` rather than using Blockly's stock `controls_if`, so styling and
labels match the existing blocks. Compiles to `{ type:'if', cond, then:[steps], else:[steps] }`
— same nested shape `repeat`, `atOnce` and `chooser` already use. Add STEP constant `if`.

Useless without #7. Ship them together.

### Tier 1 — control flow

**#9 — repeat until (1 block, 1 step type)**
```
repeat until <boolean>
  ...
```
One block only. Do not also add `while` — it's the inverse and adds nothing.
Compiles to `{ type:'repeatUntil', cond, body }`. Add STEP constant `repeatUntil`.

**MUST have a stuck-loop guard.** A condition that never flips is an infinite loop that
occupies a macro slot forever. Cap iterations (see existing `MAX_REPEAT_COUNT` in
`src/shared/constants.js`) and on hitting the cap, abort with a clear message. Surface the cap
in the tooltip. Do not let a macro hang silently.

**#10 — break / continue (2 blocks, 0 step types)**
```
break out of loop
continue loop
```
Not step types — they are control-flow signals. The loop-body runner returns a status enum:

```js
{ status: 'continue' | 'break' | 'stop' }
```

and the loop handler interprets it. That design makes nested loops correct for free.

Compile-time scope tracking is required: push the current loop id on a stack while compiling a
loop body, so `break` knows which loop to escape. Add a compiler function for this.

**Decide and document this rule early:** what does `break` do inside an `at once` block that
is inside a loop? It must break the loop *and* end that concurrent task, otherwise the task
keeps running against a loop that no longer exists. Pick a rule, implement it, write it in
`README.md`. Do not leave it ambiguous.

### Tier 2 — input

**#13 — mouse down / mouse up (2 blocks, 2 step types)**
Enables real drag-and-drop, slider dragging and text drag-select — none of which is possible
today. `inputService` already has `pressBurst` and `releaseAll`, so the primitives exist.
Add STEP constants `mouseDown` and `mouseUp`.

**#14 — drag from A to B (1 block, 1 step type)**
```
drag mouse from x [⛶] y to x [⛶] y over [N] ms
```
Compiles to `{ type:'drag', from, to, ms }`. Composes #13. Add STEP constant `drag`.

**#15 — scroll wheel (1 block, 1 step type)**
```
scroll [up/down] [N] clicks at x [⛶] y
```
Entirely absent today. Verify nut-js exposes wheel scrolling; if not, fall back to P/Invoke
via the same PowerShell path used for windows, and say so in the log. Add STEP constant
`scroll`.

**#19 — paste text via clipboard (1 block, 1 step type)**
```
paste text "..."
```
One step instead of N keystrokes — dramatically faster for long strings, and avoids
per-character layout dependency. Add STEP constant `pasteText`. Needs clipboard read/write
over IPC (Electron `clipboard` module, main process only — never expose it to the renderer).

**#18 — jitter / humanize (0 new blocks)**
Do this as **optional fields on existing blocks**, not as new blocks. Add a `jitter` field to
`mb_mouse_click`, `mb_mouse_move_to` and `mb_key_type`. Default 0 = current exact behaviour.

This is an anti-detection feature. Scoped narrowly: random offset within ±N px for clicks,
random per-character delay within a range for typing. Do not build a general "humanize"
engine — you have `between X and Y` as a reporter and that is enough.

### Tier 3 — reactivity (the reliability story)

**#24 — wait for window (1 block, 1 step type)**
```
wait until window titled "…" exists   timeout [8000] ms
```

This is the highest-leverage block in the entire list. Every macro starts with "wait for the
app to load" followed by `wait 5 seconds`. Replacing the guess with a real condition is the
difference between reliable and not.

This is the **cheap half** of window support. It only polls for a title — it never moves,
resizes or focuses a window, which is what makes `SetForegroundWindow` flakiness irrelevant.
Ship this before any focus/move work.

Timeout is mandatory. A wait with no timeout is a permanent hang. Give it a numeric socket and
a sensible default, honour `MAX_DURATION_MS`, and on timeout raise a catchable error so #22
and #25 can act on it.

Add STEP constant `waitForWindow`.

**#11 — if pixel is <colour> (1 block, 1 step type)**
```
if pixel x [⛶] y is [⧉] tolerance [t] then
```
The inline form of the existing `mb_start_pixel` hat block. Reuse its fields, tolerance
semantics and the new display dropdown from #28.

This is the feature that changes what the app *is*. Today macros are replay. With this they can
react — "click, then wait and click until the button turns green" is currently impossible,
because pixel state can only be tested as a start condition, never mid-flow.

Add STEP constant `ifPixel`.

**Perf note:** `README.md:432` flags capture cost per tick as unverified. Do not let each macro
private-poll the screen. Register waiters with the existing `pixelService.watch()` poller and
have one capture fan out to all of them, or five simultaneous pixel checks will mean five
screen captures per tick.

### Tier 4 — reliability

**#22 — retry (1 block, 1 step type)**
```
retry [3] times
  ...
```
Add STEP constant `retry`. Requires the Tier 0 error model.

Two honesty requirements, both non-negotiable:
- **Retry is not idempotent.** If the body is "click Submit" and the click landed but the
  response was slow, retrying double-submits. Fine for a game macro, never fine for a form.
  Offer a mode that retries only lookup/wait failures, not performed actions.
- **State must reset between attempts.** If the body already pressed keys, retrying may leave
  modifiers stuck down. Call `inputService.releaseAll()` between attempts at minimum.

**#25 — abort (2 blocks, 1 step type)**
```
abort this macro
abort if <boolean>
```
Add STEP constant `abort`.

Today a macro that hits an unexpected state keeps pressing keys at whatever is on screen —
which is how macros end up deleting the wrong thing. An explicit abort is a clean, *logged*
exit, and the reason must appear in the activity log panel so a silently-failing macro is
diagnosable.

This is also the missing piece for **error propagation out of sub-macros**. `mb_control_run_macro`
currently cannot report failure to its caller. With abort, a child can fail, the parent can
check the status, and #22 becomes meaningful.

### Tier 5 — scheduling (needs the window service)

**New: `src/main/services/windowService.js`**
Serves #24, #30 and #31. No FFI layer exists in this project and you may not add one — shell out
to PowerShell from the main process. Sketch:

```powershell
Add-Type -Namespace W -Name U -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
Get-Process | Where-Object MainWindowTitle -like '*Notepad*'
```

Expose `listWindows`, `waitForWindow`, `titleExists`, `focusWindow`, `powershell`.

Budget for ~200ms per PowerShell invocation. That is expensive — it is why polling intervals
must be configurable and why #24 (poll only) is cheap while window movement (deliberately
excluded from this list) would not be.

**#30 — timed triggers (2 start blocks)**
```
▶ every [N] seconds → run […]
▶ at [HH:MM] → run […]
```
Scheduler lives in `src/main/orchestrator.js`. Persist schedules in `state.json` — the
`settings` object there is currently always empty and is the right home. Note
`macroStore.js:252` already implements `getSettings()`/`setSettings()` and they are **never
called anywhere**; wire them up rather than adding new storage.

**#31 — startup / window-open triggers (2 start blocks)**
```
▶ when Windows starts → run […]
▶ when window titled "…" opens → run […]
```
Startup: Electron's `app.setLoginItemSettings({ openAtLogin: true })`. On boot, auto-arm the
designated macros and minimize to tray.

Window-open: poll `Get-Process MainWindowTitle` via `windowService` on a configurable interval
(1–2s is the likely right range). Make the interval user-visible in the diagnostics dump
(`app.js:618`) so CPU cost is not mysterious.

Payoff: macros become conditional on their target actually being open, which makes pixel
coordinates inside them **valid by construction**. This is how the app stops being
single-monitor-only once #28 lands.

### Tier 6 — scheduling/UX polish (0 new blocks, cheap)

**#21 — speed multiplier (0 new blocks)**
One number scaling every duration. A toolbar slider (0.25×–4×) plus an optional per-macro field
on `mb_start_run`.

**Critical:** apply it in `src/main/engine/timing.js` at the sleep call — at *runtime*, not in
the compiler. If you scale at compile time, moving the slider forces a recompile and the
workspace flashes. At runtime the macro just slows instantly.

Beyond debugging, this is how people come to trust a macro: watch it work slowly once, then run
it at speed.

**#23 — macro timeout (0 new blocks)**
An optional timeout field on `mb_start_run`. Prevents runaway `forever` loops from occupying a
macro slot indefinitely. Pair it with #9's iteration cap.

**#1 — undo / redo (0 new blocks)**
Blockly's undo is already built in and already active — one comment at `blocks.js:591` refers to
it. It is simply never exposed. Add toolbar buttons wired to `Blockly.undo()` / `Blockly.redo()`.

**#2 — minimap (0 new blocks)**
One option in `Blockly.inject` (`app.js:580`):
```js
minimap: { enabled: true }
```
Plus CSS to match the dark theme and sit above the record banner. Note the workspace inject
options block at `app.js:580-602` is the reference for how options are set here.

**#32 — export / import macro (0 new blocks)**
Export a macro to a `.json` file and import it back. Right now macros are trapped in
`%APPDATA%\MacroBoard\macros.json` with no way to share them. Add IPC for read/write via a file
dialog. Imported macros must be validated — same care as loading `macros.json`, see
`macroStore.js:40-67` which already degrades corrupt files to defaults.

**#34 — highlight the active block (0 new blocks)**
Engine emits the current step id over IPC; renderer locates the source block and applies a glow
class.

**Check first whether the compiler already stamps each step with its source block id.** If it
does, this is nearly free. If it doesn't, adding that is part of this feature — and it also
makes future debugging output possible.

### Tier 7 — recorder

**#38 — record smart cleanup (0 new blocks)**
Post-process a recorded step list and compress it:

| Recorded | Tidied |
|---|---|
| 14 × `click at 400,300` | `press 14 times with 80 ms gap` |
| 30 × `move mouse by 2,1` | `move mouse to 412,377 over 640 ms` |
| `move by 0,0` ×5 | dropped |
| `type "h"` `type "e"` … | `type text "hello"` |

Recorded macros are currently unreadable noise. This is what makes them openable and editable a
week later.

Requirements:
- **A button, never automatic.** Show a preview and let the user confirm. Blockly's undo
  history (see `blocks.js:591`) makes it safely reversible, but merging that runs
  automatically on every recording will occasionally destroy timing fidelity the target
  application genuinely required.
- **Preserve significant gaps.** `recorder.js:33-37` defines `MIN_RECORDED_GAP_MS = 60`,
  `TEXT_IDLE_MS = 900`, `SAME_POINT_PX = 6` — these are explicitly judgement calls, not
  measurements. A gap exceeding the threshold must survive as an explicit `wait`, never be
  swallowed.

New renderer module, e.g. `src/renderer/js/tidy.js`, with ~4 transform helpers.

---

## Suggested build order

Dependencies force roughly this sequence. Do not reorder without checking.

1. **#28** DPI + display picker — bug fix, unblocks everything coordinate-related
2. **Error model** — no new UI, but #22 and #25 are meaningless without it
3. **#7** expressions + **#6** if/else — shipped as one unit
4. **#9** repeat until + **#10** break/continue — control-flow core, do before pixel logic
5. **windowService.js** + **#24** wait for window — cheapest real reliability win
6. **#11** if pixel — depends on 1 and 4
7. **#13 #14 #15 #19 #18** — input batch
8. **#22** retry + **#25** abort — depends on 2 and 5
9. **#30 #31** — scheduling, depends on windowService
10. **#21 #23 #1 #2 #32 #34** — polish, independent, can be interleaved anywhere
11. **#38** recorder tidy — independent

Tier 0 through Tier 4 is the actual product. Tier 6 and 7 are quality-of-life and can be
dropped without leaving a broken app.

---

## Out of scope — do not add

Explicitly excluded despite being discussed: #3 zoom presets, #4 block comments, #8 variables,
#12 wait-until-pixel, #16 double-click, #17 mouse hold, #20 window move/resize, #26 scan-region
colour search, #27 region picker, #29 save screenshot, #33 dry-run/step-through, #35 per-macro
settings block, #36 template gallery, #37 record region, #39 record edit pass.

If one of these turns out to be necessary for something on the list, say so and ask before
adding it.

---

## Definition of done

- All 23 features implemented
- 51 blocks, 23 step types, 8 start types, 6 categories, 6 custom fields, 4 value chips
- `node --test --test-concurrency=1 "test/*.test.js"` green, 260+ tests
- Existing saved macros load and run unchanged — verify by reasoning about each new STEP
  constant and confirming no existing one changed meaning
- README updated: test count (currently says 88, actually 164+), file tree, new blocks, new
  step types, and the break-inside-`at once` rule
- `scripts/selftest.cmd` and `scripts/smoke.cmd` still pass — they exercise the real
  toolbox and renderer, so a broken theme or missing block shows up there

## Known pre-existing issues

Not on the list, but you may touch these files and will notice them:

- `src/shared/catalog.js:6,8` — header comment points at `src/renderer/js/toolbox.js` and
  `src/renderer/js/workspace.js`; **neither file exists** (that code is in `theme.js` and
  `app.js`)
- `catalog.js:76` — declares an `mb_record_hotkey` block that is never defined; the record
  hotkey is set from a toolbar double-click instead
- `catalog.js:80-85` `START_META` and `catalog.js:69-77` `BUTTON_FIELDS` are shipped over IPC
  and never consumed by the renderer
- `constants.js` `RUN_STATE`, `SLOT.COUNT`, `SLOT.DURATION` are shipped and unused
- `macroStore.js:252,283-288` `getSettings`/`setSettings` are implemented but never called
  (Tier 5 wires these up)
- Dead exports: `orchestrator.js:645` `captureCoordinateWithMinimize`, `engine.js:554`
  `runInline`, `inputService.js:303` `screenSize`, `hookService.js:339`
  `mouseBlockingSupported`, `preload.js:72` `mb.minimize`
- `README.md:511-528` known limitations: chooser `✕` deletes the visible page rather than a
  per-page icon; `wait` is in seconds while every other duration is ms
- `README.md:237-242` documents a deliberate non-feature: blocks that attach a new field to
  another block on drop. That is why value chips exist instead. Don't build it.
- Formatting glitch at `hookService.js:145`