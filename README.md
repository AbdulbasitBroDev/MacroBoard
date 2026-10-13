# MacroBlock

A premium, block-based (Scratch-style) macro builder for Windows, built with **Electron + Blockly**.

MacroBlock watches for real keyboard/mouse input and replays macros by simulating that input for
you. It is a desktop app, not a script runner: everything lives in a dark, drag-and-drop Blockly
workspace and runs from the main process against native Windows APIs.

```text
┌─────────────────────────────────────────────────────────────┐
│ ● MacroBlock  [● Idle]  START when Run is pressed  0 steps   │  ← status pill, Run/Arm, Stop (F8)
│                                        [● Record] [Run] [Stop]│
├──────────────┬──────────────────────────────────────────────┤
│ My macros    │        ▶ when Run is pressed                 │
│  • Farm      │          do ┌ click left at x 100 y 200      │
│  • Sell      │             │ press key A 3 times …          │
│              │             └ repeat 10 times do …           │
│ Save Rename  │                                              │
│ Dup   Delete │                                              │
│ Activity log │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

---

## 1. Install and run

```bat
npm.cmd install
npm.cmd start
```

> **Use `npm.cmd`, not `npm`.** On many Windows machines PowerShell's execution policy blocks
> `npm.ps1`, so plain `npm start` fails with *"File C:\Program Files\nodejs\npm.ps1 cannot be loaded
> because running scripts is disabled on this system"*. `npm.cmd` bypasses the PowerShell shim.
> Fix it permanently with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### Two install traps this project hits on Windows

Both were hit while building this app, and both are handled for you.

**1. npm 11 blocks install scripts, which silently breaks Electron.**

```text
npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn install-scripts   @fainthit/uiohook-napi-suppress@1.6.4 (install: node-gyp-build)
```

npm 11 **skips** those scripts. The hook module survives this (it uses `node-gyp-build` *at require
time* and finds its N-API prebuild), but **Electron's binary comes from its postinstall** - so npm
reports success while `node_modules/electron/dist/` is empty, and `npm start` then fails with
*"Electron failed to install correctly"*.

`npm start` therefore runs `scripts/ensure-electron.js` first. It detects the missing binary, tries
Electron's own installer, and if there is no network it extracts the binary from `@electron/get`'s
download cache (`%LOCALAPPDATA%\electron\Cache`). Manually: `npm.cmd run ensure-electron`.

To fix it at the npm level instead:

```bat
npm.cmd install --foreground-scripts
:: or
npm.cmd install-scripts approve electron
```

**2. Native modules must match your Node/Electron version.**

```bat
npm.cmd run verify
```

checks all three native dependencies and prints exactly what breaks - without failing the install.

MacroBlock is deliberately written so a broken native module **never stops the app from starting**.
Every service loads inside `try/catch`, reports why it is unavailable, and the UI shows an amber bar
naming the disabled features. You can always open the app, edit macros, and run `npm.cmd test`.

### Commands

| Command | What it does |
| --- | --- |
| `npm.cmd start` | Launch the app |
| `npm.cmd run dev` | Launch with Chromium logging |
| `npm.cmd test` | Run the full suite (492 tests) |
| `npm.cmd run smoke` | Launch, screenshot the UI to `_screenshot.png`, auto-quit |
| `npm.cmd run verify` | Check the native dependencies |
| `npm.cmd run ensure-electron` | Repair a missing Electron binary |
| `npm.cmd run dist` | **Build the distributable installer + portable `.exe` into `release/`** |
| `npm.cmd run dist:dir` | Fast unpacked build (no installer) into `release/win-unpacked/` |
| `npm.cmd run serve` | Serve `release/` at `http://127.0.0.1:8000` so the installer can be downloaded through a browser |
| `npm.cmd run test:feed -- <port> --fake` | Serve a throwaway update feed so the update flow can be tested without publishing |

---

## 1b. Building a distributable

`npm.cmd start` is a *developer* workflow - it needs Node, `npm install`, and a
terminal. To hand the app to someone who has none of that, build an installer:

```
npm.cmd run dist
```

Output lands in `release/`:

| File | Size | What it is |
| --- | --- | --- |
| `MacroBlock-Setup-1.0.0.exe` | **102 MB** | NSIS installer. Install wizard, Start Menu + desktop shortcut, proper uninstall entry in Apps & Features |
| `MacroBlock-1.0.0-portable.exe` | **102 MB** | Single file, no install, runs from a USB stick |

The recipient double-clicks and runs it. No Node, no `npm start`, no terminal.

### Why the build is ~100 MB and not ~450 MB

The repo folder is 446 MB, but almost none of that is MacroBlock:

| | Repo | Shipped |
| --- | --- | --- |
| `src/` (your code) | 0.4 MB | 0.4 MB |
| `node_modules/` | 445 MB | ~20 MB, inside `app.asar` |
| Electron runtime | 368 MB | 235 MB (`MacroBlock.exe`) |

Three things shrink it, all configured in the `build` block of `package.json`:

- **`electronLanguages: ["en-US"]`** - drops 47 of 48 language packs, saving 48 MB.
- **`files`** - only `src/` and `package.json` ship. `test/`, `scripts/` and dev
  dependencies (`jsdom`, `electron`) are excluded.
- **NSIS compression** - LZMA over the Chromium binary.

The floor is `MacroBlock.exe` at 235 MB. That is Chromium plus Node, which every
Electron app carries; there is no way to avoid it short of not using Electron.

### Two deliberate build settings

- **`npmRebuild: false`** - `@fainthit/uiohook-napi-suppress` and
  `@nut-tree-fork/libnut-win32` ship **prebuilt NAPI** binaries, which are
  ABI-stable across Node *and* Electron. Rebuilding them is unnecessary, and it
  fails hard without Visual Studio Build Tools installed. Native `.node` files
  are automatically unpacked out of the asar into `app.asar.unpacked/`, which is
  what makes them loadable.
- **`perMachine: false`, `oneClick: false`** - a per-user install wizard. No
  administrator prompt, no UAC, installs to `%LOCALAPPDATA%`.

### The icon

`build/icon.png` (512x512) is the source; electron-builder converts it to a
multi-resolution `.ico` and applies it to the installer and the executable.
Replace that file and rebuild to rebrand.

### Shipping it unsigned

These builds are **not code-signed**, so on first run Windows shows:

> **Windows protected your PC** - Microsoft Defender SmartScreen prevented an
> unrecognized app from starting.

Users click **More info -> Run anyway**. Put those instructions on your download
page. SmartScreen reputation accumulates from real download volume over time, so
this warning eases on its own as the app gets used. See the project notes for
when signing becomes worth its cost.

### Testing the download experience

Do not judge the installer by double-clicking it in `release/`. A file opened off
disk carries **no Mark-of-the-Web**, so Windows treats it differently from the
same file a user downloaded. SmartScreen only appears on a real download.

```
npm.cmd run serve
```

Then open **http://127.0.0.1:8000** and download through the browser. The page
lists every artifact with its size and SHA-256 so a truncated download is
detectable. The server binds `127.0.0.1` only, so nothing is exposed to the
network.

What to check after downloading:

- Windows shows **"Windows protected your PC"** -> **More info -> Run anyway**
- `Get-Item "$env:USERPROFILE\Downloads\MacroBlock-Setup-1.0.0.exe" -Stream *`
  shows a `Zone.Identifier` stream, confirming the file really was downloaded
- The install wizard runs, shortcuts appear, uninstall works
- Compare the downloaded SHA-256 against the one on the page

Note: `Invoke-WebRequest` and `curl.exe` do **not** attach the Mark-of-the-Web,
so a download test done from the command line will not reproduce SmartScreen.
Use a real browser.

### Automatic updates

The app checks for a newer version once, 8 seconds after launch, and offers it
in a bar in the bottom-left corner. There is also a **Check for updates** button
in the top bar.

**Nothing happens until you host the update feed.** The `publish.url` value in
`package.json` is a placeholder:

```json
"publish": { "provider": "generic", "url": "https://REPLACE-ME.example.com/macroblock" }
```

Until that points at a real host, every check logs `ERR_NAME_NOT_RESOLVED` and
the app carries on normally. That is deliberate - a broken feed must never stop
someone opening the editor.

To switch it on:

1. Point `publish.url` at an **HTTPS** host you control (Cloudflare R2's free
   tier is enough; plain HTTP is rejected by electron-updater).
2. Build, then upload these files to that URL:

   | File | Needed for |
   | --- | --- |
   | `latest.yml` | tells the app what version exists |
   | `MacroBlock-Setup-1.0.0.exe` | the installer to download |
   | `MacroBlock-Setup-1.0.0.exe.blockmap` | differential download |

   `npm.cmd run dist:publish` builds and uploads in one step once the host is
   configured. Plain `npm.cmd run dist` only writes them to `release/`.
3. Bump `version` in `package.json`, rebuild, upload. That is the whole release
   process.

**The portable `.exe` cannot update itself.** It has no installer, and the
update mechanism relies on the NSIS installer running unattended. Portable
copies are therefore always one manual upgrade behind. Say so on your download
page, or drop the portable build once auto-update is live.

#### Testing it without publishing anything

An update cannot be tested from the plain `npm.cmd start` window: electron-updater
refuses to run when the app is unpacked, which is why the button reports
"Automatic updates only apply to the installed app". That is correct behaviour,
not a bug.

`MB_UPDATE_FEED_URL` is the escape hatch. Setting it flips
electron-updater's `forceDevUpdateConfig`, so the updater runs from source and
points wherever you tell it. It is ignored entirely in a packaged build unless
the variable is set.

```
REM terminal 1 - a throwaway feed advertising a version that does not exist
npm.cmd run test:feed -- 8123 --fake

REM terminal 2
$env:MB_UPDATE_FEED_URL = "http://127.0.0.1:8123"
npm.cmd start
```

`--fake` fabricates `latest.yml` for 1.0.1 from the installer already in
`release/`, so **no second build is needed** to prove detection works. Within
about two seconds the app logs:

```
INFO update: checking
INFO update: available 1.0.1
```

and a bar appears bottom-left: *"MacroBlock 1.0.1 is available"* with **Download**
and **Later**.

Verified working this way: `checking` -> `available 1.0.1`, the banner rendering,
and the same graceful failure against the real placeholder URL in a packaged
build.

**What this cannot prove:** `quitAndInstall`. The fabricated version has no real
higher-versioned installer behind it, so the final reinstall step is still
unexercised. That needs two genuine published versions - see the `NOT verified`
list. Use `--fake` for detection, the UI and the download; do not treat a
successful download as proof that an install works.

Clear the variable afterwards or every later `npm.cmd start` will keep hitting the
test feed:

```
Remove-Item Env:\MB_UPDATE_FEED_URL
```

#### Behaviour guarantees

- **Never automatic.** `autoDownload` is off, so the app only ever *offers* an
  update. Nothing is downloaded without a click, and nothing restarts the app
  without a click.
- **A failed check is not the user's problem.** It becomes a 6-second toast, not
  a persistent bar, and never blocks launch.
- **"Later" sticks.** Dismissing 1.4.0 keeps it dismissed until 1.5.0 appears.
- **Checks are rate-limited** to once per 60 seconds, so several triggers cannot
  pile up on one feed request.
- **Unpackaged builds never touch the updater at all.** `npm.cmd start` cannot
  reach it, so development cannot accidentally check or download anything.

Implementation is `src/main/services/updateService.js`. The updater is injected
rather than required at module load, so all 16 of its tests run without booting
Electron - see `test/updateService.test.js`, which spends most of its effort on
the failure paths (throwing updater, rejected check, stream error, install from
the wrong state) because "no network" is the common case, not the rare one.

### Note on `release/` and `.gitignore`

`release/` and `node_modules/` are both gitignored. `build/` is deliberately
**not** ignored - that is where the icon lives and electron-builder needs it.

---

## 2. Architecture

The most important decision: **the editor and the executor never touch each other's internals.**
Blockly is compiled into a plain JSON step list, and the engine executes that list. That is what
makes the interesting logic testable without a screen, an input hook, or a human.

```text
renderer (sandboxed)                       main process (Node)
┌───────────────────────────┐              ┌──────────────────────────────────────────────┐
│ Blockly workspace         │              │ Orchestrator                                 │
│   ↓ src/blockly/compiler  │              │   ├─ MacroEngine   src/main/engine           │
│ JSON step list            │────IPC──────▶│   │    ├─ ActionGate  min gap between actions │
│   ↓ src/renderer/js/app   │◀───events────│   │    └─ step interpreter                    │
│ top bar / sidebar / modals│              │   ├─ InputService   nut-js   (simulate)      │
└───────────────────────────┘              │   ├─ HookService    uiohook  (detect)        │
                                            │   ├─ PixelService   desktopCapturer (read)   │
                                            │   └─ MacroStore     userData/*.json          │
                                            └──────────────────────────────────────────────┘
```

```text
src/
  shared/     constants.js  catalog.js  buttons.js  expressions.js  pixels.js  (UMD: all three)
  blockly/    compiler.js   blocks.js   fields.js                    (Blockly-facing, headless-safe)
  main/       main.js  preload.js  preloadChip.js  previewChip.js  orchestrator.js
              engine/    engine.js  gate.js  timing.js
              services/  inputService.js  hookService.js  pixelService.js  macroStore.js
                        eyedropper.js  windowService.js
  renderer/   index.html  eyedropper.html  eyedropper-chip.js  css/
              js/(errors, theme, modals, actions, marquee, recorder, app)
test/         engine  compiler  blocks  loops  windowService  expressions  pixels  eyedropper  pixelTrigger
              fields  inputService  macroStore  orchestrator  pixelService  timing  .test.js
              +  helpers/env.js
```

Two shared modules exist specifically to stop one class of bug:

- **`src/shared/expressions.js`** is the single evaluator behind every Logic block. The compiler, the
  engine and the tests all use the same file: two copies of the truth is how a macro ends up
  previewing one way and running another.
- **`src/shared/pixels.js`** is the single colour comparison, used by both the pixel *trigger* and
  the `if pixel is` *condition*. Two copies of that rule is how you get a macro whose trigger fires
  on a colour its own inline `if` insists does not match.

`expressions.js` is pure and synchronous on purpose - it has no I/O, so the pixel nodes in a
condition are resolved by the ENGINE before evaluation (see *if pixel is*). That ordering is the
whole reason the two files can be shared safely.

There is **no build step.** Every shared file is a UMD module, so the same source is consumed by
`require()` in main, a `<script>` tag in the renderer, and `require()` in the tests.

### Why three input libraries

| Need | Tool | Why not the obvious choice |
| --- | --- | --- |
| Simulate input | `@nut-tree-fork/nut-js` | - |
| **Detect** input globally | `@fainthit/uiohook-napi-suppress` | Electron's `globalShortcut` cannot see arbitrary keys, cannot see mouse buttons at all, and cannot distinguish key-down from key-up. Hold-to-run, press-N-times, "listen for a press", the coordinate picker, record mode and the global Stop key all need those. This is a maintained fork of `uiohook-napi`: it is the same detector, plus the `registerSuppress` call the "sleep" switch needs (upstream's addon exports only `start`/`stop`/`keyTap`, so upstream physically cannot block a key). |
| Read a screen pixel | Electron `desktopCapturer` | `nut-js`'s `screen.grabRegion` measured **~250 ms per call** (2.6 s for ten 1×1 grabs) - unusable for polling. `desktopCapturer` makes one full-desktop grab, after which the pixel read is a buffer index. The nut-js path is kept as a documented slow fallback for one-shot eyedropper reads. |
| Read window titles | PowerShell | `EnumWindows` via `Add-Type`, so there is **no native dependency** - which matters more than elegance here, because this project has deliberately stayed free of compiled modules. Spawning PowerShell per poll measured **~1030 ms**; a resident helper answers in **~10-16 ms**, so the helper is long-lived, started lazily and killed when idle. |

### The compiled step list

The compiler emits plain JSON. Every step is one of:

```js
{ type: 'wait',     ms: <slot> }
{ type: 'moveTo',   x, y }
{ type: 'moveBy',   dx, dy, ms }
{ type: 'click',    button, x, y }
{ type: 'typeText', text }
{ type: 'pressKey', button, count: <slot>, gapMs: <slot> }
{ type: 'holdKey',  button, ms: <slot> }
{ type: 'repeat',   count: <slot>, body: Step[] }
{ type: 'atOnce',   body: Step[] }
{ type: 'runMacro', name }
{ type: 'chooser',  id, mode: 'random'|'organized', pages: Step[][] }
{ type: 'if',       cond: <expr>, then: Step[], else: Step[] }
{ type: 'repeatUntil', cond: <expr>, body: Step[] }
{ type: 'break' }    // a marker with no payload - see "Loops"
{ type: 'continue' }
{ type: 'waitForWindow', title, timeoutMs: <slot>, pollMs }
```

where a `<slot>` is one of `{kind:'number', value}` / `{kind:'forever'}` /
`{kind:'range', min, max}`, and `<expr>` is the small JSON tree that backs the Logic blocks - booleans,
comparisons and pixel checks, documented in `src/shared/expressions.js`. Click the compile badge in
the top bar to see the live step list for whatever is on the canvas.

> **Step types are append-only.** An engine meeting a `type` it does not recognise raises a clear
> error rather than mis-reading it, so a macro saved by a newer version fails loudly instead of doing
> something subtly wrong on an older one.

> **Pixel checks are expression nodes, not steps.** `(pixel at x,y) is <colour>` compiles to
> `{e:'pixel', x, y, colour, tol}` inside an `if` condition, which is what lets the engine collect
> every pixel in one condition and satisfy them all from a single screen capture. It also means the
> block produces no step of its own, so it nests under `and`/`or`/`not` for free.

---

## 3. Using it

### Top bar

| Control | Behaviour |
| --- | --- |
| **Status pill** | Coloured dot + text: idle / running / armed / recording / limited functionality. Click it for a diagnostic dump. |
| **START** | Which start block is armed, in plain English. |
| **Compile badge** | Live compile result: `12 steps`, or the first warning/error. Click it to see the whole step list or the error list. |
| **Run / Arm / Watch / Disarm** | The label follows the start block you chose, and becomes **Disarm** while armed. |
| **Stop** | Stops the run, disarms, exits record mode. **F8 does the same thing globally, even when the app is not focused.** |
| **Record** (double-click) | Starts/stops record mode. Double-click it to choose a custom record hotkey. |

No countdown anywhere: Run and triggers start immediately, as specified.

### Start blocks (one per workspace)

| Block | Behaviour |
| --- | --- |
| `when Run is pressed` | Default. The toolbar button runs the body immediately. |
| `when [button] is pressed [N] times, then` | Arms a global listener. When the button has been pressed N times, the body runs once, then it re-arms. |
| `when holding [button] run` | Loops the body while held; stops the instant it is released; re-arms. |
| `when pixel x,y becomes [colour], then` | Polls one screen pixel. When it **becomes** the target colour the body runs once, then it re-arms. |
| `every [N] seconds run` | Runs the body on a timer, unattended, for as long as the macro stays armed. |
| `at [HH:MM] run` | Runs the body once a day at that wall-clock time. |

#### The two timed triggers

Both are **skip-only**. There is deliberately no queue option: a timer that queues
missed runs is how a slow macro ends up executing itself five times over.

```
every 60 seconds  →  the body is still running at the 60s mark
                   →  that tick is DROPPED and counted
                   →  the first free tick starts it again
```

Two consequences worth knowing:

- **A macro slower than its interval runs less often**, not faster. Nothing ever
  waits behind a running macro.
- **They need MacroBlock to be open.** `at 09:00` is not a Windows scheduled
  task: it will not wake the machine, start the app, or run while the app is
  closed. A missed day is skipped, not made up.

The interval is clamped to **5 seconds minimum** (a sub-second timer would spin
the event loop and look like a hung app) and 24 hours maximum. Out-of-range and
non-numeric values are clamped at compile time rather than rejected, so a typo
produces a sane schedule instead of a dead macro.

Timers are **armed**, not run: pressing the toolbar button says `Arm`, and does
not fire the schedule early.

Both show up in the diagnostics dump under `schedules`, along with `skippedTicks`
- so a schedule that is quietly never firing is visible rather than mysterious.

**Every start block is armed at a time.** Drop in as many hats as you like - each is an independent
trigger with its **own body**, and pressing Arm arms all of them. Pressing the button again disarms
every trigger belonging to that macro.

Only one hat can *run* at a time, because the engine executes a single macro at a time. If two
triggers fire together the second is skipped and the activity log says
`ignored a trigger while a run was already in flight` - the same thing that already happened when
two separate macros were armed.

If you delete every start block, a default `when Run is pressed` is recreated automatically, so the
workspace is never unusable.

**Press-N-times needs a window.** N presses must happen within 1200 ms of each other to count as one
gesture; otherwise a stray press an hour later would complete the count. It is shown in the
diagnostics panel.

**The pixel trigger is edge-triggered.** It fires when the pixel *becomes* the target colour, not on
every poll while it merely *stays* that colour - otherwise a permanently-red pixel would flood the
engine with runs. There is also a `tolerance` field (default 0 = exact match).

**Arming it on a pixel that is ALREADY the right colour fires immediately.** That is deliberate, and
it is the common case: you sample a colour with the eyedropper, then arm. Waiting for a transition
that may never come would mean the macro silently never runs. After firing, it re-arms when the pixel
leaves the colour - so red → green → red fires twice.

> **This used to be broken, and silently.** The trigger ran *two* pollers over the same pixel: the
> watcher, plus a `setInterval` "level tracker" that read the same pixel to decide whether a rising
> edge had happened. They raced. When the level tracker finished first it claimed the match, and the
> watcher's own match for the very same pixel was then discarded as a duplicate - so a macro armed on
> an already-correct pixel would **never fire, with no error shown**. There is now one poller and one
> flag, and `test/pixelTrigger.test.js` guards exactly that case.

**Pixel polling cost is real, and the number in the block is not the whole story.** A single pixel
read requires a **full screen capture**, measured at **~117 ms** on the machine this was built on -
an earlier version of this README claimed 40-90 ms, which turned out to be a guess nobody had
checked. So the real interval is *your number plus a capture*:

| You set | You actually get |
| --- | --- |
| 50 ms | ~170 ms |
| 100 ms | ~220 ms |
| 250 ms | ~370 ms |

Polling faster **cannot** make it faster - the capture is the bottleneck - it just burns CPU, which
was made much worse when the duplicate poller doubled the work. The floor is **50 ms** and the
default **100 ms**.

**The status pill shows the measured interval, not the requested one.** While a pixel macro is armed,
click the status pill: the diagnostics dump lists the requested interval, the measured one, the
average capture cost, and the sample count. That is the number to quote in a bug report.

The poller is **capture-then-wait**, not a fixed timer, so a slow capture delays one sample instead
of queueing a backlog of them.

### Control blocks

- `wait N seconds` - seconds, not milliseconds (the block says seconds, the step list stores ms).
  Decimals are fine: `0.5`.
- `repeat N times` - sequential.
- `at once` - every block stacked inside becomes its own concurrent task and the macro waits for all
  of them. `hold A for 1s` + `hold B for 1s` inside `at once` genuinely overlap; outside it they run
  one after the other. If one branch fails, its siblings are stopped and the error surfaces.
- `run another macro [dropdown]` - loads and runs another saved macro inline, like a subroutine.
  The dropdown is **rebuilt every time it opens**, so renames and deletions appear immediately.
  Two clear errors are built in:
  - nesting deeper than **10** levels →
    `Maximum macro nesting depth (10) exceeded: A → B → A. Two macros are probably calling each other in a loop.`
  - the named macro no longer exists →
    `Macro "Farm" could not be found - it may have been renamed or deleted since this block was placed.`
- `random chooser` / `organized chooser` - see below.
- `if <> then / else` - runs one of two branches. See **Logic blocks** below.
- `repeat until <>` - loops until a condition is true. See **Loops** below.
- `break` / `continue` - leave a loop, or skip the rest of a pass. See **Loops** below.
- `wait until window titled "…" exists` - the anti-`wait N seconds` block. See **Windows** below.

### Windows — `wait until window titled "…" exists`

Every macro starts with "wait for the app to load", and then guesses a duration with
`wait N seconds`. Sometimes the load is 3s, sometimes 9s, and the guess is either wasteful or broken.
This block replaces the guess with a fact:

```
wait until window titled "Notepad" exists   timeout 8000 ms
  click left at 640,380
  type text "hello"
```

**The match is case-insensitive and only needs to be PART of the title.** Real titles are long and
compound, and nobody should have to type `1 Second Cps test - cpstest.org - Google Chrome` in full:

| You type | It matches |
| --- | --- |
| `Notepad` | `Sales.csv - Notepad` |
| `Chrome` | every Chrome tab you have open |
| `Docx` | `AppSaaS.docx - WPS Office` |

There is a **⧶ list** button on the block that reads the currently open windows and lets you pick
one, so you do not have to guess the title.

**The timeout is mandatory**, and `forever` is refused. A wait with no timeout is a permanent hang,
and "wait forever for the app" is the wrong reading of this block when the app was never going to
open. A hang is worse than a failure, because a failure tells you why.

**If it times out, the error lists the windows that WERE open:**

> Waited 8000ms but no window title containing "Notepad" appeared. The windows that WERE open were:
> "Chrome - Google Chrome", "Spotify", "fields.test.js - Visual Studio Code". Match part of one of those.

That is the entire point of the timeout. "No window matching Notepad" tells you nothing; the list
tells you what to match on instead.

**Stop is immediate, not "one poll later".** The wait is *raced* against the stop token rather than
polled for, and Stop kills the window helper, because a PowerShell call cannot be interrupted from
Node. Without that, a 60-second wait would keep the macro running for up to a full poll interval after
you pressed Stop.

#### The PowerShell cost, measured

Reading window titles has no FFI layer in this project, so it shells out to PowerShell. That is only
viable because of *how* it is done:

| | measured |
| --- | --- |
| spawn PowerShell **per poll** | **~1030 ms** |
| resident helper, **first** start | **~975 ms** (one-off) |
| resident helper, **each query** | **~10-16 ms** |

So the cost is almost entirely process startup, not the query. Spawning per poll would burn a second
of CPU per second of waiting. Instead one long-lived helper process answers one query per line on
stdin, and it is **started lazily** - a session that never waits for a window never spawns PowerShell
at all - and **torn down after 30 s idle** so nothing lingers.

Consequences you can see:

- The **first** wait in a session is slow (~1s of startup). The block checks **immediately** rather
  than sleeping first, so a window that is *already* open is found in ~16 ms anyway.
- The poll interval you choose is roughly the interval you get. 50 ms is the floor; below that you are
  just spinning a PowerShell child.
- The helper is killed on app exit, and killed on Stop to unwind an in-flight query.

#### What is listed

Visible top-level windows only, and **MacroBlock's own window is excluded** - otherwise
`wait until window titled "MacroBlock"` would match this app and the macro would run before it had
done anything. Minimised windows still count: they are visible in the sense that matters here.

#### Honest limits

- Windows only. Off Windows the service reports itself unavailable and the block explains why.
- Titles are sanitised server-side: a title containing a tab or newline is flattened to a space.
  They are display text and never functional, and the wire protocol is line- and tab-delimited, so
  letting one through would corrupt every record after it.
- Output is pinned to UTF-8. Without that a non-ASCII title arrives as mojibake and silently fails
  to match, which is the worst kind of failure because the title looks right in the UI.
- `EnumWindows` is a snapshot, so a window that opens and closes between polls can be missed. The
  poll interval is the bound on that, not a guarantee.

### Loops

| Block | Behaviour |
| --- | --- |
| `repeat N times` | sequential, fixed count. `forever` chip loops until Stop. |
| `repeat until <condition>` | re-checks the condition before every pass and stops when it is true. |
| `break` | leaves the **nearest** loop around it |
| `continue` | ends this pass and starts the next one |

`repeat until` is the piece that makes *"keep trying until the screen looks right"* expressible:

```
repeat until (pixel 640,380 is <#00ff00>)
  do
    click left at 640,380
    wait 500 milliseconds
```

**The condition is checked BEFORE the first pass**, so if it is already true the body never runs.
That is the whole difference from `repeat N times`.

**`break` and `continue` are scope-checked at compile time.** On its own, with no loop above it,
either is a clear compile error rather than a block that silently does nothing. They are legal
anywhere inside a loop - including inside an `if` branch, inside a chooser page, and inside an
`at once` that is itself inside a loop.

#### Why they are returned, not thrown

A loop exit is a normal outcome, not an exception. Modelling it as a thrown error would unwind
**every** enclosing loop at once - the one thing `break` must never do. Instead each loop *consumes*
the signal for itself, so a `break` three levels down leaves exactly one loop and the other two carry
on. `test/loops.test.js` pins this at three nesting levels.

#### The rule for `break` inside `at once` - stated plainly

Two things are true at once, because `at once` is genuinely parallel:

1. The `break` reaches **out** and stops the surrounding loop.
2. **Every other stacked block still runs to completion.** In `at once` each stacked block is its
   own concurrent task, so a `break` is a *sibling* of the block below it, not a statement in front of
   it. Cancelling the others would also mean abandoning a half-finished click.

A `break` inside an `at once` that is **not** in a loop is dropped with a warning rather than
truncating the rest of the macro.

#### `continue` is honest about being nearly a no-op

In a plain loop body, `continue` behaves exactly like ending the body early, because nothing else
happens per pass. It is still worth using - the block below it becomes obviously dead instead of a
trap - and it is the **only** way to end one task of an `at once` without disturbing the others.

#### The stuck-loop guard

`repeat until` stops itself after **100,000** passes and says so, **naming the condition that never
came true**:

> "repeat until" ran 100,000 times without its condition becoming true, so it stopped rather than loop
> forever. The condition was: pixel(640,380) is #00ff00. If the pixel coordinates or the colour are
> wrong, the condition may be impossible to satisfy.

"this loop ran 100,000 times" is useless on its own; naming the condition tells you immediately which
check is never going to come true. The cap is separate from `repeat N times`'s 100,000, and
`repeat forever` is deliberately **not** capped - asking for it forever is unambiguous.

Both branches are always present on the block. An empty `else` compiles to an empty step list and
costs nothing at run time.

> **Why the else branch is always visible.** Blockly's stock `if` hides the else behind a mutation.
> Every macro in this app is saved as JSON, and a mutation field is a second serialisation path to
> keep honest. Keeping the block's shape static means `if` saves, copies and pastes with no special
> cases - the same reasoning behind the chooser's single-statement-input design.

### Logic blocks (the `if` condition)

`if` takes a **condition** in a Boolean-checked socket, so a Logic block drops in and a plain number
cannot - you get a clear compile error rather than a silent truthy/falsy surprise.

| Block | Reads | Meaning |
| --- | --- | --- |
| `(pixel at x,y) is [colour]` | the screen | that one pixel matches the colour |
| `(a) = (b)` |  | exactly equal |
| `(a) > (b)` |  | greater than |
| `(a) < (b)` |  | smaller than |
| `<a> and <b>` |  | both true |
| `<a> or <b>` |  | at least one true |
| `not <a>` |  | reversed |

Numeric sockets (`wait`, `repeat`, `hold`, press counts) take **chips only** - a comparison cannot go
there, because `wait (a) > (b)` would mean "wait 1ms" or "wait 0ms" depending on the answer. That
is enforced by Blockly's own type check.

#### `if pixel is <colour>` - why combining pixels is the point

Before this block, the only way a macro could look at the screen was the pixel **trigger**, and a
trigger is a start condition: it fires when a pixel *becomes* a colour, runs the body once, then
re-arms. You could not ask "what does the screen look like right now" and decide.

One pixel answers one bit, and one bit is usually ambiguous. A health bar's left edge is green at
full health *and* for one frame while damage is landing. Three pixels plus `and` tell those states
apart:

```
if (pixel 655,402 is red) and (pixel 700,402 is red) then
  → the bar is completely drained

if (pixel 300,250 is red) or  (pixel 520,250 is red) then
  → the error is on field 1 or field 2

if not (pixel 655,415 is grey) then
  → ignore the first frame of a highlight
```

Its fields deliberately mirror the `when pixel ... becomes` trigger - same names, same coordinate
picker, same eyedropper - so moving between the two is not relearning anything.

**All the pixels in one condition are read from a SINGLE screen capture.** A capture is a
full-desktop grab (measured 40-90 ms), so this is both a speed and a correctness decision: reading
two pixels independently would double the cost *and* could answer about two different frames - a
state that never existed. The same question asked twice in one condition is one read.

Note that `and` does **not** short-circuit the screen read here. Deliberate: one capture for both
pixels beats two captures, and the answers stay coherent.

| Where this is useful | Before | Now |
| --- | --- | --- |
| Toggle a setting only if it's off | two macros, arm the right one by hand | `if pixel is grey then click` |
| Fill then collect | `wait 8 seconds` and hope | `if pixel is not full then wait 200 ms` |
| Submit a form, correct it if rejected | the retry half was unreachable | `if pixel is red then ...` |

> **Performance.** This is a decision point, not a wait. Reading a pixel costs a real capture, so
> use it to branch and put a `wait` inside the branch that needs one.

> **Degrades rather than breaks.** A failed capture - display asleep, UAC prompt, locked screen -
> makes the condition false and logs a warning, rather than killing a macro that may be mid-loop.
> With no pixel port at all the same applies.

### Why there is no math category

There isn't one. A `+`/`-`/`×`/`÷`/`mod`/`round` set was built and then removed in the same
session, and the reasoning is worth keeping because it is the kind of thing that looks obviously
useful and isn't:

- Arithmetic needs a data source. The only non-constant values available were random `between` rolls,
  and `(random) * 2` is a job that chip already does.
- Every field that would carry real data - coordinates, tolerance, poll interval - is a plain
  **field**, not a socket, precisely because Blockly cannot attach a field to a block by dropping
  another block on it (see the trade-off note under *Function chips*). So there was nothing
  arithmetic could act on.
- Logic blocks output `Boolean` and are refused by numeric sockets, so `(a) + (b)` had no operands
  available to it at all.

What would justify math later: **variables** (a real data source), or making coordinates sockets.
Both are separate features, and neither is in the current plan.

### Scrolling, and the wheel trigger

Two new blocks, both built on the same wheel geometry: Windows counts one wheel
notch as `WHEEL_DELTA` (120), and that is the **only** unit available. The
input library takes a raw wheel delta, not a count of notches.

| Block | Notes |
| --- | --- |
| `scroll [360] px up/down within [0] ms` | One wheel **event per click**, each carrying a full notch of delta. Firing faster than ~12ms and apps coalesce the burst and discard the rest, so that gap is a floor, not a preference. `within` is the total time for the whole scroll. |
| `when scrolled up/down run` | Edge-triggered: one run per **gesture**, not per wheel click, then it re-arms after 400ms of quiet. Horizontal wheels are ignored. |

Pixel amounts are converted at 120px per click, but the distance the content
actually moves is decided by the app being scrolled - a browser and a game will
not agree. One click is the unit that behaves the same everywhere.

### Recording: text or separate keys

Hovering **Record** opens a small menu with two options, and the choice is
remembered between sessions (stored in `settings`, which is the first thing to
use `macroStore.getSettings`/`setSettings`).

| Mode | Pressing G, T, L gives |
| --- | --- |
| **As text** (default) | one `write GTL` block - consecutive printable presses coalesce |
| **As separate keys** | three `press key` blocks |

Gaps, double-click upgrades and modifier folding are identical in both modes.

Recording starts **2 seconds** after you press Record, so you can switch to the
window you want captured. Click Record again during the countdown to cancel.

With several start blocks in a workspace, recording attaches to the one you
**touched most recently** - edit or drop a block into macro Y's body and Y
becomes the target. Falling back to the only hat when there is just one.

### Function chips (drag onto numeric sockets)

Every numeric input is a **value socket** with a real number shadow already plugged in, so blocks
look clean by default but always have a number underneath. Drop one of these in:

| Chip | Meaning |
| --- | --- |
| plain number | the default shadow block itself |
| `forever` | "until I press Stop" instead of a fixed amount |
| `between N1 and N2` | a random value in range, **re-rolled fresh every time that step executes** |

`forever` is a *socket modifier*, not a value, so it cannot be used as an operand inside a math
block or a comparison. Doing so is a clear compile error rather than a silent `0`.

`forever` is interpreted per context by the engine:

| Slot | `forever` means |
| --- | --- |
| repeat count | loop until Stop |
| hold duration | hold until Stop, then **release the key cleanly** |
| wait duration | idle until Stop |
| press count | press repeatedly until Stop |
| press gap | hangs after the first press until Stop - unusual, so it carries a tooltip warning |
| trigger count | fire on every press |

> **Trade-off I want to be explicit about.** The original request included a chip that could *attach
> new fields* to a block that has none (drag "times" onto a bare `press key` and it becomes
> `press key N times`). A block's shape changing because another block was dropped **on** it is not
> how Blockly's drag/connection system works. The value-socket approach above reaches the same
> practical outcome - an optional-feeling, swappable count - through a supported mechanism. `press
> key` stays a single press; `press [key] [N] times with [N] ms gap` is its own block.

### The choosers (the paged blocks)

Both choosers look and behave identically:

```text
┌──────────────────────────────────────────────────────┐
│ random chooser  ‹  page 1/2  ›   +   ✕              │
│   do  ┌ type text "buying"                           │
│       └ click left at x 800 y 640                    │
└──────────────────────────────────────────────────────┘
```

- Starts at **2 pages**; `+` adds one (max 24); `✕` deletes the page you are looking at **after
  confirming**; `‹` `›` wrap around.
- Only the **active page's blocks are shown**.
- `random chooser` picks one page at random each run (empty pages are skipped, so it never looks like
  it did nothing).
- `organized chooser` uses the pages **in order**: 1st run → page 1, 2nd → page 2, looping after the
  last. The cursor is **persistent** - it is stored per block id in `state.json`, so it survives
  separate runs *and* app restarts, and adding a page later does not reset it.

**How it is implemented (the fiddly part).** Each chooser has exactly **one** statement input holding
the active page. Every other page is kept as serialized block JSON inside the block's
`extraState`. Switching pages serializes the live stack into the stash and loads the target page.
This beat the alternatives:

- one statement input per page + `Input.setVisible` → hidden inputs still render their child blocks
  in the wrong place;
- dynamically adding/removing inputs → loses the blocks inside them.

`saveExtraState` deliberately stores `null` for the active page (it already lives in `inputs.DO`).
The first version stored it in both places, which made Blockly reload a **duplicate copy** of that
page - a bug caught by a test that counts occurrences of a string in the saved JSON.

### Mouse & keyboard blocks

- `click [button] at x,y` / `move mouse to x,y` - both have a **⛶ pick** control: clicking it
  minimizes MacroBlock, arms a one-shot global mousedown listener, captures the real coordinates of
  your next click, restores the window and fills in x,y.
- `move mouse by dx,dy within N ms` - smooth relative move, interpolated over exactly N ms. No picker
  (it is relative, not absolute). `nut-js`'s own `mouse.move` is paced by `mouseSpeed`/`autoDelay`,
  which does not map onto "within N ms", so the interpolation is done explicitly.
- `type text`, `press key`, `press [button] [N] time(s) with [N] ms gap`, `hold [button] for [N] ms`.

### The button picker

Clicking any button field opens a modal with:

1. a **full US keyboard grid** (function row, digits, letters, numpad, navigation cluster), plus
   mouse buttons, click-directly;
2. **⏺ Listen for a press** - arms a one-shot global capture so you can just press the real key or
   mouse button instead of hunting for it.

**Mouse side buttons (4/5) can never be an action.** `nut-js` can only simulate Left/Middle/Right on
Windows, so:

- in **action** blocks the side buttons are shown greyed out with an explanation, so you cannot
  silently pick something that will fail;
- in **trigger** blocks they are fully selectable;
- if one ever does reach the engine (e.g. a stale saved macro), it throws
  `Cannot click mouse button code 4: the input simulation library can only simulate Left, Middle and
  Right clicks on Windows. Extra side buttons can be used as triggers, but never as an action.`
  rather than failing silently.

**Raw button numbering is not something I claim to know.** The labels ("Left", "Side 1") are
best guesses; the stored value is the **raw code your machine reported**. The picker says so, and
"Listen for a press" is the real source of truth - it reports what the hook actually saw, including
unmappable inputs (`Swift (hook-only)`), which are marked trigger-only.

### Coordinate picker

"⛶ pick" hides the app, waits so it is out of the way, arms a one-shot global mousedown listener,
and fills in the coordinates. **There is no DPI conversion anywhere in that path**: coordinates come
straight from the hook, which reports in the same physical-pixel space the input library uses to
perform clicks. The pixel reader is the one place a mapping is needed, and the diagnostics panel
prints the measured scale factors plus the colour under your cursor so you can verify it on your
machine instead of trusting it.

### Eyedropper (⧉ on a colour field, or the button in the colour modal)

Press the eyedropper and the app **hides** - not minimizes, hides, so nothing flashes and focus is
not stolen. A small dark chip then follows your cursor showing the colour currently under it, and
that colour is sampled **live as you move**.

| To | do |
| --- | --- |
| **pick** | **Ctrl + left click** |
| **pick with no click at all** | **Ctrl + Enter** (whatever the cursor is hovering) |
| **cancel** | **Escape** |
| a plain click | ignored, and tells you once that Ctrl is needed |

**Why it samples on hover rather than on click.** The old eyedropper waited for a click and *then*
captured the screen - so it photographed whatever the click had just caused. A menu had opened, a page
had navigated, a row had highlighted, and the colour you got back was frequently the reaction rather
than the target. There is no click in the sampling path now, so nothing can change underneath it.

**Why Ctrl is required.** MacroBlock **cannot block mouse buttons** - the low-level hook addon
swallows keyboard events only, so a click is always delivered to the app underneath. Requiring a
modifier is what makes the commit a deliberate act instead of an accident. If picking a pixel must
have **zero** effect on the app you are sampling, use **Ctrl+Enter**, which involves no click at all.

Sampling is throttled to one capture in flight. A capture costs 40-90 ms and a mouse emits moves far
faster than that, so the preview trails the cursor slightly rather than queueing captures that would
answer about positions it has already left.

### Selection + "test one block"

Drag on **empty canvas** to rubber-band select. Then right-click for a small menu:

| Item | Behaviour |
| --- | --- |
| **▶ Run selected** | Compiles just those blocks and runs them immediately, bypassing the start block. This is also the "test a block without running the whole macro" feature. |
| **⧉ Copy (duplicate) selected** | Duplicates the selected stacks, offset so the copy is visible. |
| **✕ Delete selected** | Removes the selected stacks. If that removed every start block, a default one is recreated. |

Right-clicking a block with nothing selected selects that block first, so "right-click → Run
selected" doubles as testing a single block.

If you select a container *and* a block inside it, the inner block is not run twice - blocks with a
selected ancestor are skipped.

> **Why this is hand-rolled:** Blockly's own selection model is single-block, and its multi-select API
> has changed shape across versions. The marquee tracks its own id set using only stable public APIs
> (`getTopBlocks`, `getSvgRoot().getBoundingClientRect()`, `Blockly.serialization`), so it will not
> break on a Blockly upgrade.

### Saved macros

Sidebar: **New / Save / Rename / Duplicate / Delete**, plus click-to-open. Each macro is stored in
`%APPDATA%\MacroBlock\macros.json` with **both** the Blockly workspace state (so it re-opens for
editing) **and** the compiled step list (so execution and `run another macro` never re-parse blocks).
Renaming warns that callers by the old name will report it. Writes are temp-file + rename, and a
corrupt file degrades to "no macros" with a logged error rather than a crash.

### Record mode

Press **Record** (or your configured hotkey). From then on, real global input is converted to blocks
and appended live under the start block:

- consecutive typing is **coalesced** into a single `type text` block (flushed after 900 ms of
  silence, or when a non-typing action arrives);
- observed delays become `wait N seconds` blocks, but gaps under **60 ms** are snapped away as noise;
- **mouse moves are not recorded** - only clicks - because recording every pixel of travel produces
  unusable macros;
- rapid repeat clicks at nearly the same spot fold into `press N times` instead of a stack of clicks;
- modifier keys (Shift/Ctrl/Alt) are folded into the text rather than emitted as their own blocks;
- clicks with an unmappable button are **skipped with a visible warning**.

Stop with the toolbar button, the Record button again, your configured hotkey, or **Escape**/**F8**.
Record settings live in `%APPDATA%\MacroBlock\state.json`.

> These thresholds are judgement calls, not physics. If recorded macros feel wrong, the two knobs to
> change are `MIN_RECORDED_GAP_MS` and `TEXT_IDLE_MS` at the top of
> `src/renderer/js/recorder.js`.

### Execution engine guarantees

- **A minimum gap (~1 ms) between any two physical input actions.** Every mouse move/click and key
  down/up acquires a slot from `ActionGate`. Slots are handed out over a promise chain, so even
  concurrent `at once` branches respect the gap between each other. A `repeat forever { click }` with
  no wait cannot flood the OS - there is a test asserting the click rate.
- **Hard caps** (unless `forever`): repeat 100 000, press count 10 000, durations/gaps 1 hour, macro
  nesting 10. Over-limit values are clamped and **warned about** in the compile badge, not silently
  accepted.
- **Stop interrupts between steps** - checked at every step and every loop iteration, and long waits
  are chunked every 20 ms so Stop feels instant. Actions already in flight finish cleanly.
- **Held keys are always released.** A `hold` interrupted by Stop releases its key, and
  `inputService.releaseAll()` tracks everything pressed so shutdown cannot leave a key stuck down.
  A press+release pair is deliberately **atomic** - there is no stop-check between keyDown and keyUp,
  because one there could leave a key physically stuck.
- **`forever` in a press gap hangs after the first press** (a real but degenerate case), with a
  tooltip warning rather than hidden behaviour.
- **Chooser state persists** across runs and restarts.

---

## 4. What I verified, and what I could not

Being straight with you, because this app leans on OS-level behaviour.

### Verified by automated tests (492 tests, all passing)

Run `npm.cmd test`. Everything OS-specific is mocked, so the pure logic is genuinely covered:

| Area | Covered |
| --- | --- |
| Engine | step ordering, minimum-gap enforcement, forever slots in every context, random-range re-rolling, hard caps, Stop interrupting mid-wait, held keys released on Stop, unknown step types |
| `at once` | branches start within ms of each other and the whole thing finishes in ~one branch's time, overlapping holds release independently, a failing branch stops its siblings |
| `run another macro` | inline execution, 3-level nesting, missing macro message, mutual recursion `A → B → A` depth guard, self-recursion |
| Choosers | random picks a non-empty page, organized cycles and **persists across a simulated restart**, independent cursors per block, adding a page later does not reset the cursor, nesting inside `repeat` |
| Logic | all three comparisons, and/or/not, nesting preserves the grouping drawn on screen, boolean↔number coercion, short-circuiting, malformed and self-referential nodes cannot hang the evaluator or the reporter |
| `if` | takes the then/else branch correctly, empty else does nothing, a missing condition is false rather than a crash, **the condition is re-evaluated on every pass through a loop**, only the taken branch is counted as executed, works inside `at once`, nesting and `next`-chain continuation, and a `break` inside a branch still leaves the loop |
| Loops | `repeat until` stops the moment the condition is true and **checks it before the first pass**, re-tests every pass, **a stuck loop stops itself at the cap and names the condition**, a `break` leaves **exactly one** loop (pinned at one, two and three nesting levels), `break`/`continue` work inside `if` branches, chooser pages and `at once`, a `break` with no loop is a compile error and a logged warning if it slips through, a sub-macro's break cannot escape into its caller's loop, and the `at once` rule is asserted in both directions: the loop stops, the siblings finish |
| `wait for window` | returns immediately when the title is already open, a `forever` timeout is refused, **a timeout names the windows that WERE open** and says so when none were, an empty title and a missing port both give clear errors, **Stop ends it promptly and aborts the in-flight query**, and it works inside a loop |
| WindowService | the READY handshake (**nothing is written to stdin before the child is ready** - a lost query is a hang with no error), `DONE` does **not** settle the query early, a zero-window result settles on `DONE` alone, titles with spaces and non-ASCII survive, a split chunk boundary parses, an `E` line and a dead child both reject, `shutdown` kills the PowerShell child, our own windows are excluded, `waitFor` checks immediately / polls / reports a timeout with the windows it saw / stops on request, and the script is passed as an **argument** so stdin stays free |
| `if pixel is` | match and no-match take opposite branches, **two pixel checks in one `and` cost ONE capture** (and are asserted on capture count, not pixel count), the same pixel twice is one read, `or` batches too, tolerance widens the match, a condition with no pixels never touches the screen, a **failed capture makes the condition false instead of killing the run**, no pixel port at all still runs, re-read on every loop pass, and the motivating case is asserted: identical first pixel, different second pixel, opposite outcomes |
| Colour rules | per-channel tolerance (not euclidean), hex parse/refuse, clamping, `maxChannelDelta` for "why didn't it match", and that `pixelService` delegates to the shared rule rather than keeping a private copy |
| Eyedropper | **a plain click never picks a colour** and explains the Ctrl requirement exactly once, shift/alt alone is not enough, `Ctrl+Enter` picks with no click, `Escape` cancels, the hook is always released, a second session is refused, a **failed capture does not end the session**, an off-screen pixel never becomes a colour, three moves cost one capture, and the accuracy case is asserted directly: the screen changes the instant the click lands and the pre-click colour is still what comes back |
| Pixel trigger | **a pixel that is already the right colour fires on arm** (the reported bug), **exactly one run rather than zero or a flood**, staying the same colour does not re-fire, red→green→red fires twice, **one capture per tick rather than two**, the poll floor is enforced *and logged*, status reports the measured interval, disarm stops all captures, and an invalid colour is refused cleanly rather than throwing |
| Block definitions | every catalog block instantiates headlessly, hats have no previous connection, sockets really hold shadow blocks, chips displace shadows, tooltips exist, `if` round-trips with both branches intact, Logic outputs `Boolean` and numeric sockets are `Number` so neither accepts the other, the pixel check carries the same fields as the pixel trigger, and there are no `mb_math_*` blocks |
| Compiler | every block type, chips only in numeric sockets (a comparison there is a clear error), seconds→ms conversion, cap warnings, reversed ranges, empty sockets, side-button-as-action **error**, missing macro warning, start-block selection, run-selected ancestor filtering, `forever` rejected as a comparison operand at every depth of the tree, pixel tolerance clamped |
| Timed triggers | `every N seconds` compiles to an interval and `at HH:MM` to a clock time, **an interval below 5s is clamped rather than honoured** (0 would spin the event loop forever), absurd intervals clamp to the 24h max, a non-numeric interval falls back to the default instead of becoming `NaN`, an out-of-range clock **clamps rather than wraps** (99:77 does not become a valid time), a fractional clock time rounds to whole minutes, midnight and 23:59 both render zero-padded, both are labelled `Arm` rather than `Run`, and a timer **really fires unattended** with no one pressing Run |
| Timed triggers (runtime) | an `every` macro fires on its own several times over, **a tick arriving during a run is skipped and counted rather than queued** (the blocking body never completes and `skippedTicks` climbs past 3), skipped ticks reset to zero once a macro gets a free run, `at` reports its zero-padded label, a time already past today rolls forward to tomorrow, schedules appear in `diagnostics().schedules` and vanish on disarm, and **shutdown drops every pending timer** |
| Self-echo | the reported bug: `while holding RMB → press RMB forever` pressed once and stopped. Our own injected click comes back through the global hook and used to stop the very run feeding it. Now: a hold **survives its own injected mouseup**, a real release still stops it, the press-count trigger does not tick on its own injections, and an **unmatched UP echo cannot swallow a later genuine DOWN** (matching on button alone desynchronises and would drop a real press) |
| Self-echo bookkeeping | a click notes one down and one up echo, a burst notes a pair per press, `releaseAll` notes an echo too, echoes for different buttons never consume each other, and **stale echoes expire** so a dropped hook event cannot eat the user's next real release and leave a macro running forever |
| Updates | an available version is reported with its number, up-to-date is distinct, download and install are **refused from the wrong state**, progress reaches downloaded, **a throwing updater / missing updater / rejected check / error on the event stream all land in `error` instead of crashing**, a failed `quitAndInstall` returns false rather than throwing, **nothing is automatic** (`autoDownload` off, `autoInstallOnAppQuit` on), the 60s cooldown suppresses repeat checks unless forced, overlapping checks do not pile up, and **an unpackaged build never even subscribes to the updater** |

### Verified manually, in the real Electron window

- The app launches, creates its window, and reaches `MacroBlock ready` (`npm.cmd run smoke` writes
`_screenshot.png`; the rendered UI was inspected: dark theme, hat-shaped start block, all six
   toolbox categories, status pill, sidebar, activity log).
- All three native modules load on this machine: `@fainthit/uiohook-napi-suppress` (N-API prebuild, no rebuild needed),
  `nut-js`, and Electron's `desktopCapturer`.
- Two real install problems were found and fixed (see §1): Electron's binary was never downloaded
  because npm 11 blocked its postinstall, and Blockly was fetching its sprite sheet from the internet
  (fixed by pointing `Blockly.inject`'s `media` option at the local `node_modules/blockly/media/`).

The block tests run **real Blockly headlessly** (no jsdom needed - Blockly's core loads without a DOM),
so the chooser round-trip and the compile path are exercised against the real library, not a mock.

The renderer self-test (`npm.cmd run selftest`) drives the real toolbox and dumps every category and
every block type to `_selftest.json`: 35/35 types instantiate, and the Logic flyout reports its seven
blocks plus the numeric shadows that come with them.

### Packaging and updates, verified against real artifacts

These were checked by building and running, not by reading code:

- **The packaged app launches and opens its window** (`release\win-unpacked\MacroBlock.exe`,
  5 processes, titled window), and it resolves Blockly and both prebuilt native
  modules out of the built `app.asar`.
- **The update path runs end to end and fails safely.** With the placeholder
  feed URL, the delayed check fires, the lookup fails, and the log shows
  `update: checking` then `update: error - net::ERR_NAME_NOT_RESOLVED` - absorbed,
  with the app still running and the window visible. That is the intended
  behaviour for a dead feed.
- **A successful check was observed, not just failures.** Driven from source via
  `MB_UPDATE_FEED_URL` against the fabricated feed, the log shows `update:
  checking` then `update: available 1.0.1`, and the bottom-left banner renders
  with **Download** / **Later** - confirmed in the smoke screenshot.
- **`electron-updater` is confirmed present inside the built `app.asar`** (95
  entries), so a packaged build can actually reach it rather than silently
  degrading.
- **The build emits a usable update feed**: `latest.yml` carries the version, a
  SHA-512 and the installer size.
- **The download server was exercised for real**: five sequential requests
  (`200 / 200 / 404 / 404 / 200`) with the server surviving all of them, path
  traversal refused, and a full 102.1 MB download that came back byte-identical.
- **The app is confirmed unsigned** - `Get-AuthenticodeSignature` reports
  `NotSigned` on the installer, the portable build and `MacroBlock.exe`.
- **A ReferenceError shipped in the first build of this feature.** `devFeedUrl`
  was declared inside `buildServices()` but read by the startup timer outside it,
  so the update check silently never ran in a packaged build. The smoke run's log
  caught it, not the 16 unit tests - which is a reminder that `main.js` has no test
  coverage of its own. Fixed, then re-verified in both source and packaged runs.
- **The self-echo fix was confirmed on real hardware** by the author: a
  `when holding RMB -> press RMB forever` macro now keeps firing for as long as the
  button is held, and stops the moment it is released.
- **Both timed triggers were confirmed in the live toolbox**: the renderer
  self-test reports **35/35 block types** instantiating with zero renderer errors,
  up from 33.
- **The picker's record button** was confirmed as a full-width primary button at
  the top of the dialog, and the activity-log pause button was confirmed
  rendering beside the log-folder button in the smoke screenshot.
- **The 2-second record delay is unverified by machine**: the countdown, the
  cancel-on-second-click path, and the "no start block" and compile-error guards
  that run before it are all plain code, but nobody has yet alt-tabbed during one.

**Not verified:** a real update was never installed, because that needs a
hosted feed with two versions in it. The download-and-install half of
electron-updater is unexercised.

### NOT verified - please expect to iterate here

I could not drive real global input, a real screen, or real DPI scaling from the build environment.
Specifically untested on your machine:

1. **Real click/keypress simulation.** That `nut-js` actually moves the cursor and presses keys the
   way the engine expects. The call shapes come from the installed `.d.ts` files and were probed at
   runtime, but the physical result is unverified.
2. **Real global hook behaviour.** Whether the hook reports the mouse button numbers I assume.
   This is exactly why "Listen for a press" is the source of truth and why raw codes are displayed.
3. **The "sleep" switch really swallowing the key.** The 16 modifier rules are registered with the
   addon and the addon's own C code sets the consumed flag on the hook thread, which is the only
   place Windows honours it - but the end-to-end proof is pressing the trigger key with a real
   text field focused and confirming nothing is typed. Two known limits: blocking works for
   keys only, not mouse buttons (see below), and it is registered per armed trigger, so a key
   that is already held when you arm will not be retroactively swallowed.
4. **A real auto-update install.** Only the *failure* path has been observed end to end, because
   that is what a placeholder URL gives you. Downloading an update, verifying its signature block,
   and `quitAndInstall` relaunching into the new version has never run. This needs two published
   versions against a real HTTPS feed.

### Why "sleep" works for keys but not mouse buttons

The `sleep` switch swallows the trigger button so it never reaches the app you are driving. It
works for **keys only**.

Blocking a mouse click is a real capability limit, not a setting. A low-level Windows hook
swallows an event by returning non-zero from inside the hook procedure, and no published build of
the hook module marks *mouse* events that way - the library in use consumes keystrokes only.
Closing that gap would mean shipping our own compiled native addon, which is not a trade worth
making for a macro builder, so the switch reports the limit instead of quietly doing nothing.

**Mouse buttons still work as triggers.** Only the blocking is unavailable: a `when [RMB] is
pressed 1 time` trigger with `sleep` on runs the macro *and* lets the click through, and the app
says so when you arm it.
4. **DPI / multi-monitor pixel mapping.** The pixel reader maps nut-space coordinates onto a captured
   image using `display.scaleFactor`. On a single display at 100% scaling this is exact; mixed-DPI
   multi-monitor setups may be off. **Use the diagnostics panel**: it prints the measured scale
   factors and the colour under your cursor so you can confirm before trusting a pixel trigger.
5. **The pixel trigger's timing.** It polls with a fresh full-screen capture per tick, so the real
   interval on your hardware will be at least as long as your display's capture time.
6. **Record mode's feel.** The coalescing thresholds are guesses about what feels readable.
7. **The button-picker modal and marquee** rendered in a real window (built and syntax-checked; the
   code paths that need a pointer were not exercised).
8. **Screen readers / keyboard-only navigation** of the custom fields.

**Several rounds of "here's the error I got" are expected and normal here** - that is a property of
an app built on OS-level input APIs, not a sign anything went wrong. The activity log panel (bottom
left) and `%APPDATA%\MacroBlock\logs\macroblock.log` record everything, and clicking the status pill
gives you a diagnostics dump to paste back.

---

## 5. Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **F8** | Stop everything / disarm / exit record mode, **globally** (works when the app is not focused) |
| **Escape** | Stop recording |
| **Ctrl+S** | Save the current macro |
| **Ctrl+R** | Run / Arm |
| Right-click | Selection context menu (Delete / Run / Copy selected) |

---

## 6. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm start` says *"cannot be loaded because running scripts is disabled"* | PowerShell blocking `npm.ps1`. Use `npm.cmd start`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. |
| *"Electron failed to install correctly"* | npm 11 skipped Electron's postinstall. Run `npm.cmd run ensure-electron`. |
| App starts but an amber bar says features are disabled | A native module did not load; the bar names it and the reason. `npm.cmd run verify` reproduces it. |
| Global triggers do nothing | Global input detection is unavailable, or the trigger's button is not the one you think. Open the picker and use **Listen for a press** to see what your machine actually reports. |
| Pixel trigger never fires | Wrong coordinates, wrong colour, or the pixel is already the target colour (it is edge-triggered - it fires on the *change*). Use the diagnostics panel to check the colour under the cursor. |
| Clicking "pick" captures the wrong point | Mixed-DPI multi-monitor. The picker reports exactly what the hook saw; check the diagnostics scale factors. |
| A key seems stuck down | Press F8. Shutdown and Stop both release tracked keys, but if a crash ever leaves one down, F8's `releaseAll` is the recovery path. |
| Macro runs much slower than the numbers say | Check that nothing else is holding input. `nut-js`'s own auto-delay is switched off (`mouse autoDelayMs` defaults to 100 ms, keyboard to 300 ms!) precisely so the engine's gate is the only pacing. |
| A recorded macro has odd waits | Tune `MIN_RECORDED_GAP_MS` / `TEXT_IDLE_MS` in `src/renderer/js/recorder.js`. |

Where things live:

```text
%APPDATA%\MacroBlock\
  macros.json        saved macros (workspace state + compiled steps)
  state.json         organized-chooser cursors, record hotkey, settings
  logs\macroblock.log  everything, including renderer logs
```

---

## 7. Known limitations

- **Windows is the target.** The architecture is cross-platform, but the pixel reader and the
  "cannot simulate side buttons" rule are Windows-specific.
- **A side mouse button can be a trigger, never an action** (library constraint, surfaced explicitly
  rather than silently ignored).
- **The eyedropper cannot swallow a click.** The hook addon blocks keyboard events only, so a
  mouse click is always delivered to the app underneath. Ctrl+click picks a colour, but that click
  does still arrive. **Ctrl+Enter picks with no click at all** and is the option with zero side
  effects on whatever you are sampling.
- **One instance per app.** A second launch is refused, because two copies would fight over the
  global hook and the same macro file.
- **No undo history for chooser page switches.** Page contents survive save/load/copy correctly, but
  Blockly's undo will not step back through a page flip. Page switches are event-suppressed so they
  do not corrupt the rest of the undo stack.
- **Chooser page delete removes the page you are viewing.** The spec asked for a delete icon per
  page; only the active page is visible, so `✕` deletes the visible page (with confirmation). Other
  pages can be reached with the arrows first.
- **The pixel reader samples the primary display's capture** and maps the virtual desktop onto it.
  Single-monitor is exact; multi-monitor may need the tolerance field. This affects the `if pixel is`
  block exactly as it affects the pixel trigger, since both go through the same service - which is
  the point of sharing it.
- **`wait` is in seconds** (per the spec's wording for that block) while every other duration is in
  milliseconds. The block label says which.
- **No variables.** There is no way to store a value between steps or between runs, so a condition
  can only test what it can read: a pixel, or a comparison of literals. The organised chooser's
  persistent page cursor is currently the only state that survives a run. This is also the thing
  that would make arithmetic worth having.
- **No `while`, and no nested `repeat until` inside an `if`-driven loop.** `repeat until` exists, but a
  loop whose exit condition is computed rather than counted is still not expressible.
- **The timed triggers need MacroBlock open.** `at 09:00` is not a Windows scheduled task: it will not wake
  the machine, start the app, or catch up a missed day. There is deliberately no queue mode, so a macro slower
  than its interval runs less often rather than accumulating a backlog.
- **A hard kill can poison the next launch.** If the app is force-killed or loses power, Chromium's
  disk cache under `%APPDATA%\macroblock` can be left locked, and the next launch dies immediately
  with `Unable to move the cache: Access is denied` / `Unable to create cache` on stderr. Deleting
  that folder fixes it. Only affects the *packaged* app, where the user has no console to read the
  error - worth a friendly "startup failed, reset app data" path eventually.
- **Builds are unsigned.** See [Building a distributable](#1b-building-a-distributable).
- **The portable build cannot self-update.** Auto-update relies on the NSIS
  installer running unattended, which the portable `.exe` does not have.



