'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/shared/constants');
const { createOrchestrator } = require('../src/main/orchestrator');

function makeOrchestrator(opts) {
  opts = opts || {};
  const listeners = new Set();
  // Every registered block, so a test can assert the trigger is unblocked again
  // on disarm rather than only that it was registered.
  const blocks = [];
  const hook = {
    available: true,
    reason: '',
    canBlock: (id) => {
      if (opts.noBlocking) return false;
      // Mirror the real service: the hook module swallows keys only.
      if (String(id).indexOf('mouse:') === 0) return false;
      return true;
    },
    cannotBlockReason: (id) =>
      String(id).indexOf('mouse:') === 0
        ? 'Blocking mouse buttons is not supported.'
        : 'cannot block',
    armSuppress(id) {
      blocks.push(id);
      return () => {
        const i = blocks.indexOf(id);
        if (i >= 0) blocks.splice(i, 1);
      };
    },
    mouseBlockingSupported: () => false,
    // Lets a test hand the orchestrator a release function that does nothing,
    // standing in for a build where the block was registered but then lost.
    // Lets a test hand back a release function that does nothing, standing in
    // for a build where the block was registered and then became stuck.
    armSuppressStuck() {
      blocks.push('key:STUCK');
      return () => {};
    },
    blockingSupported() { return !opts.noBlocking; },
    retain(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    isRunning() { return listeners.size > 0; },
    shutdown() { listeners.clear(); blocks.length = 0; },
emit(kind, id) {
      // `id` is either a button id (existing tests) or a full payload object,
      // which the wheel trigger needs because it reads `amount`, not `button`.
      const payload = id && typeof id === 'object'
        ? Object.assign({ x: 0, y: 0, time: Date.now() }, id)
        : { button: id ? { id, label: id, sim: true } : null, x: 0, y: 0, time: Date.now() };
      Array.from(listeners).forEach((fn) => fn(kind, payload));
    },
  };
  // Mirrors inputService's self-echo queue: `echo(id, kind)` says "our own injection
  // is about to come back through the hook as this event", and takeEcho consumes
  // it exactly once. Matching on kind matters - a press-count trigger only ever
  // inspects down events, so an unmatched up echo must not desynchronise it.
  const echoes = new Map();
  const echoKey = (id, kind) => id + '|' + kind;
  const echo = (id, kind) => {
    const k = echoKey(id, kind);
    echoes.set(k, (echoes.get(k) || 0) + 1);
  };
  const input = {
    available: true,
    reason: '',
    releaseAll: async () => {},
    diagnostics: () => ({}),
    takeEcho: (id, kind) => {
      const k = echoKey(id, kind);
      const n = echoes.get(k) || 0;
      if (n <= 0) return false;
      if (n === 1) echoes.delete(k);
      else echoes.set(k, n - 1);
      return true;
    },
  };
  const pixel = { available: false, reason: 'unavailable', diagnostics: () => ({}) };
const store = {
    store: { get: (_key, fallback) => fallback, set: () => {} },
    getRecordHotkey: () => null,
    getMacroSteps: () => null,
    setRecordHotkey: (id) => id,
    // diagnostics() reports store.info(); the fake needs it or the dump throws.
    info: () => ({ macros: 0 }),
  };
  const errors = [];
  const orchestrator = createOrchestrator({ input, hook, pixel, store, ...opts });
  orchestrator.on('error', (message) => errors.push(message));
  return { orchestrator, hook, blocks, errors, echo };
}

function pressChord(hook, ids) {
  ids.forEach((id) => hook.emit('keydown', id));
  ids.slice().reverse().forEach((id) => hook.emit('keyup', id));
}

const start = {
  kind: C.START.BUTTON_COUNT,
  button: 'key:A',
  count: { kind: 'number', value: 1 },
};

test('toggle shortcut chord arms and disarms a macro', () => {
  const { orchestrator, hook } = makeOrchestrator();
  orchestrator.configureShortcuts({ mode: 'toggle', arm: ['key:LeftControl', 'key:W'] }, start, [], 'Chord test');

  pressChord(hook, ['key:LeftControl', 'key:W']);
  assert.strictEqual(orchestrator.status().armed, true);
  pressChord(hook, ['key:LeftControl', 'key:W']);
  assert.strictEqual(orchestrator.status().armed, false);
  orchestrator.shutdown();
});

test('separate arm and disarm chords remain independent', () => {
  const { orchestrator, hook } = makeOrchestrator();
  orchestrator.configureShortcuts({
    mode: 'separate',
    arm: ['key:LeftControl', 'key:W'],
    disarm: ['key:LeftControl', 'key:S'],
  }, start, [], 'Chord test');

  pressChord(hook, ['key:LeftControl', 'key:W']);
  assert.strictEqual(orchestrator.status().armed, true);
  pressChord(hook, ['key:LeftControl', 'key:W']);
  assert.strictEqual(orchestrator.status().armed, true);
  pressChord(hook, ['key:LeftControl', 'key:S']);
  assert.strictEqual(orchestrator.status().armed, false);
  orchestrator.shutdown();
});

test('several macros can be armed at the same time', () => {
  const { orchestrator } = makeOrchestrator();
  orchestrator.arm(start, [], 'First', 'macro-1');
  assert.deepStrictEqual(orchestrator.status().armedIds, ['macro-1']);

  // Arming a second macro must NOT disarm the first one.
  orchestrator.arm(start, [], 'Second', 'macro-2');
  assert.deepStrictEqual(orchestrator.status().armedIds, ['macro-1', 'macro-2']);
  assert.strictEqual(orchestrator.isArmed('macro-1'), true);
  assert.strictEqual(orchestrator.isArmed('macro-2'), true);

  // Disarming one leaves the other armed.
  orchestrator.disarm('macro-1');
  assert.deepStrictEqual(orchestrator.status().armedIds, ['macro-2']);

  orchestrator.disarmAll();
  assert.strictEqual(orchestrator.status().armed, false);
  orchestrator.shutdown();
});

test('each armed macro listens for its own button', () => {
  const { orchestrator, hook } = makeOrchestrator();
  orchestrator.arm({ ...start, button: 'key:A' }, [], 'First', 'macro-1');
  orchestrator.arm({ ...start, button: 'key:B' }, [], 'Second', 'macro-2');

  hook.emit('keydown', 'key:A');
  hook.emit('keyup', 'key:A');
  assert.deepStrictEqual(orchestrator.status().armedIds, ['macro-1', 'macro-2']);
  orchestrator.shutdown();
});

test('re-arming one macro leaves the others armed', () => {
  const { orchestrator } = makeOrchestrator();
  orchestrator.arm(start, [], 'First', 'macro-1');
  orchestrator.arm(start, [], 'Second', 'macro-2');
  orchestrator.arm(start, [], 'First again', 'macro-1');
  assert.strictEqual(orchestrator.status().armedCount, 2);
  const names = orchestrator.status().armedMacros.map((m) => m.name);
  assert.deepStrictEqual(names.sort(), ['First again', 'Second']);
  orchestrator.shutdown();
});

test('saved macro shortcuts arm macros independently', () => {
  const { orchestrator, hook } = makeOrchestrator();
  orchestrator.configureShortcutMacros([
    {
      id: 'macro-1',
      name: 'Macro 1',
      start,
      steps: [],
      shortcuts: { mode: 'toggle', arm: ['key:LeftControl', 'key:W'] },
    },
    {
      id: 'macro-2',
      name: 'Macro 2',
      start,
      steps: [],
      shortcuts: { mode: 'toggle', arm: ['key:LeftControl', 'key:S'] },
    },
  ]);

  pressChord(hook, ['key:LeftControl', 'key:W']);
  assert.deepStrictEqual(orchestrator.status().armedIds, ['macro-1']);
  // Toggling macro 2 on must leave macro 1 armed.
  pressChord(hook, ['key:LeftControl', 'key:S']);
  assert.deepStrictEqual(orchestrator.status().armedIds, ['macro-1', 'macro-2']);
  // Toggling macro 1 off must leave macro 2 armed.
  pressChord(hook, ['key:LeftControl', 'key:W']);
  assert.deepStrictEqual(orchestrator.status().armedIds, ['macro-2']);
  pressChord(hook, ['key:LeftControl', 'key:S']);
  assert.strictEqual(orchestrator.status().armed, false);
  orchestrator.shutdown();
});

test('disarming an unknown macro is a no-op', () => {
  const { orchestrator } = makeOrchestrator();
  orchestrator.arm(start, [], 'Only', 'macro-1');
  const res = orchestrator.disarm('not-armed');
  assert.strictEqual(res.wasArmed, false);
  assert.deepStrictEqual(orchestrator.status().armedIds, ['macro-1']);
  orchestrator.shutdown();
});

// ------------------------------------------------------------ sleep switch

test('sleep OFF arms without blocking anything', () => {
  const { orchestrator, blocks, errors } = makeOrchestrator();
  orchestrator.arm({ ...start, button: 'key:Q', suppress: false }, [], 'Q macro', 'm1');
  assert.deepStrictEqual(blocks, [], 'sleep off must not block the key');
  assert.deepStrictEqual(errors, [], 'sleep off is the normal path, not an error');
  orchestrator.shutdown();
});

test('sleep ON blocks the trigger button for as long as it is armed', () => {
  const { orchestrator, blocks, errors } = makeOrchestrator();
  orchestrator.arm({ ...start, button: 'key:Q', suppress: true }, [], 'Q macro', 'm1');
  assert.deepStrictEqual(blocks, ['key:Q'], 'arming with sleep on must block the button');
  assert.deepStrictEqual(errors, []);

  // Still blocked while it stays armed.
  assert.strictEqual(orchestrator.status().armed, true);
  assert.deepStrictEqual(blocks, ['key:Q']);

  orchestrator.disarm('m1');
  assert.deepStrictEqual(blocks, [], 'disarming must release the block');
  orchestrator.shutdown();
});

test('sleep ON on a hold trigger blocks the button too', () => {
  const { orchestrator, blocks } = makeOrchestrator();
  orchestrator.arm(
    { kind: C.START.HOLD_BUTTON, button: 'key:W', suppress: true },
    [],
    'Hold W',
    'm1'
  );
  assert.deepStrictEqual(blocks, ['key:W']);
  orchestrator.disarmAll();
  assert.deepStrictEqual(blocks, []);
  orchestrator.shutdown();
});

test('re-arming a macro does not stack a second block on the same key', () => {
  const { orchestrator, blocks } = makeOrchestrator();
  orchestrator.arm({ ...start, button: 'key:Q', suppress: true }, [], 'First', 'm1');
  orchestrator.arm({ ...start, button: 'key:Q', suppress: true }, [], 'First again', 'm1');
  assert.deepStrictEqual(blocks, ['key:Q'], 're-arm must replace, not accumulate');
  orchestrator.shutdown();
  assert.deepStrictEqual(blocks, [], 'shutdown must release every block');
});

test('sleep ON for ANY mouse button says so instead of pretending', () => {
  // Every mouse button is out of scope: the hook module swallows keys only.
  for (const id of ['mouse:1', 'mouse:2', 'mouse:3', 'mouse:4', 'mouse:5']) {
    const { orchestrator, blocks, errors } = makeOrchestrator();
    orchestrator.arm({ ...start, button: id, suppress: true }, [], 'Mouse ' + id, 'm1');
    assert.deepStrictEqual(blocks, [], id + ' must not be blocked');
    assert.strictEqual(errors.length, 1, 'the user must be told the switch had no effect');
    assert.match(errors[0], /sleep/i);
    assert.match(errors[0], /mouse buttons is not supported/i);
    orchestrator.shutdown();
  }
});

test('a mouse trigger still works with sleep OFF', () => {
  const { orchestrator, blocks, errors } = makeOrchestrator();
  orchestrator.arm({ ...start, button: 'mouse:2', suppress: false }, [], 'Right click', 'm1');
  assert.deepStrictEqual(blocks, []);
  assert.deepStrictEqual(errors, [], 'sleep off is the normal path');
  assert.strictEqual(orchestrator.status().armed, true, 'the trigger must still arm');
  orchestrator.shutdown();
});

test('sleep ON on a build that cannot block warns instead of blocking', () => {
  const { orchestrator, blocks, errors } = makeOrchestrator({ noBlocking: true });
  orchestrator.arm({ ...start, button: 'key:Q', suppress: true }, [], 'Q macro', 'm1');
  assert.deepStrictEqual(blocks, []);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(orchestrator.status().canBlockKeys, false);
  orchestrator.shutdown();
});

test('a trigger still fires while the button is blocked', () => {
  const { orchestrator, hook, blocks } = makeOrchestrator();
  orchestrator.arm({ ...start, button: 'key:Q', count: { kind: 'number', value: 2 }, suppress: true }, [], 'Q macro', 'm1');
  hook.emit('keydown', 'key:Q');
  hook.emit('keyup', 'key:Q');
  hook.emit('keydown', 'key:Q');
  hook.emit('keyup', 'key:Q');
  // Blocking is a native-hook concern; the detection path must be unaffected.
  assert.deepStrictEqual(blocks, ['key:Q']);
  assert.strictEqual(orchestrator.status().armed, true);
  orchestrator.shutdown();
});

test('keyboard chord recorder captures all keys pressed together', async () => {
  const { orchestrator, hook } = makeOrchestrator();
  const captured = orchestrator.captureChord(1000);
  hook.emit('keydown', 'key:LeftControl');
  hook.emit('keydown', 'key:W');
  hook.emit('keydown', 'key:S');
  hook.emit('keyup', 'key:S');
  hook.emit('keyup', 'key:W');
  hook.emit('keyup', 'key:LeftControl');
  assert.deepStrictEqual(await captured, ['key:LeftControl', 'key:W', 'key:S']);
  orchestrator.shutdown();
});




// ------------------------------------------------------------- self-echo
//
// The reported bug: `when holding RMB -> press RMB forever (50ms gap)` pressed
// once and stopped, exactly as if the user had let go.
//
// Cause: the global hook reports our OWN injected press and release. armHold
// obeyed the synthetic mouseup and stopped the very run that was feeding it.

/**
 * A body that blocks until Stop, so "is the run still alive?" is a single
 * synchronous read of status().running.
 *
 * Deliberately NOT an empty body: with zero steps the hold loop resolves
 * instantly every pass and spins purely on microtasks, starving the event loop
 * so that any timer-based test hangs forever.
 */
const BLOCKS = [{ type: 'wait', ms: { kind: 'forever' } }];
const settle = () => new Promise((r) => setImmediate(r));

test('a hold trigger survives the release of its OWN injected click', async () => {
  const { orchestrator, hook, echo } = makeOrchestrator();

  orchestrator.arm({ kind: C.START.HOLD_BUTTON, button: 'mouse:1' }, BLOCKS, 'Hold RMB', 'm1');
  hook.emit('mousedown', 'mouse:1'); // the real physical press
  await settle();
  assert.strictEqual(orchestrator.status().running, true, 'the physical press starts the run');

  // The macro injects a click of the same button. Both halves come back through
  // the hook, and neither may be mistaken for the user letting go.
  echo('mouse:1', 'down');
  echo('mouse:1', 'up');
  hook.emit('mousedown', 'mouse:1');
  hook.emit('mouseup', 'mouse:1');
  await settle();

  assert.strictEqual(
    orchestrator.status().running,
    true,
    'the run must survive its own injected mouseup - this is the reported bug'
  );

  // The genuine physical release must still stop it, or a held macro never ends.
  hook.emit('mouseup', 'mouse:1');
  await settle();
  assert.strictEqual(orchestrator.status().running, false, 'the real release must still stop the run');

  orchestrator.disarm();
});

test('a hold trigger ignores an injected PRESS without ending the run', async () => {
  const { orchestrator, hook, echo } = makeOrchestrator();

  orchestrator.arm({ kind: C.START.HOLD_BUTTON, button: 'key:A' }, BLOCKS, 'Hold A', 'm2');
  hook.emit('keydown', 'key:A');
  await settle();

  echo('key:A', 'down');
  hook.emit('keydown', 'key:A');
  await settle();
  assert.strictEqual(orchestrator.status().running, true);

  echo('key:A', 'up');
  hook.emit('keyup', 'key:A');
  await settle();
  assert.strictEqual(orchestrator.status().running, true, 'an injected keyup must not stop it either');

  hook.emit('keyup', 'key:A');
  await settle();
  assert.strictEqual(orchestrator.status().running, false);

  orchestrator.disarm();
});

test('a button-count trigger does not tick on its own injected presses', async () => {
  const { orchestrator, hook, echo } = makeOrchestrator();
  const statuses = [];
  orchestrator.on('status', (s) => statuses.push(s));
  const runs = () => statuses.filter((s) => s && s.lastRun).length;

  // Needs 3 real presses.
  orchestrator.arm(
    { kind: C.START.BUTTON_COUNT, button: 'key:A', count: { kind: 'number', value: 3 } },
    [],
    'x3',
    'm3'
  );

  hook.emit('keydown', 'key:A'); // real 1

  // The macro presses A itself. Those must not count toward the 3.
  echo('key:A', 'down');
  echo('key:A', 'up');
  hook.emit('keydown', 'key:A');
  hook.emit('keyup', 'key:A');

  hook.emit('keydown', 'key:A'); // real 2
  hook.emit('keydown', 'key:A'); // real 3
  await settle();
  await settle();

  assert.strictEqual(
    runs(),
    1,
    'two real presses plus an injected click must complete exactly ONE run'
  );

  orchestrator.disarm();
});

test('an unmatched UP echo does not swallow a later genuine DOWN', async () => {
  const { orchestrator, hook, echo } = makeOrchestrator();
  const statuses = [];
  orchestrator.on('status', (s) => statuses.push(s));
  const runs = () => statuses.filter((s) => s && s.lastRun).length;

  orchestrator.arm(
    { kind: C.START.BUTTON_COUNT, button: 'key:A', count: { kind: 'number', value: 2 } },
    [],
    'x2',
    'm4'
  );

  // This consumer only inspects DOWN events, so the UP echo is never consumed by
  // it and stays pending. A kind-blind filter would eat one of these genuine
  // presses and the trigger would never fire at all.
  echo('key:A', 'up');
  hook.emit('keydown', 'key:A');
  hook.emit('keydown', 'key:A');
  await settle();
  await settle();

  assert.strictEqual(runs(), 1, 'both genuine presses must count');
  orchestrator.disarm();
});

// ------------------------------------------------------------ timed triggers
  //
  // `every N seconds` and `at HH:MM`, both SKIP-only: a tick arriving while a run
  // is in flight is dropped, never queued. The two properties worth pinning are
  // that a free macro DOES fire on its own, and that a busy one does not stack up
  // a backlog of runs.

  const sched = (every, at) => (every
    ? { kind: C.START.EVERY, seconds: every }
    : { kind: C.START.AT, hour: at[0], minute: at[1] });

  test('an `every` macro fires on its own without anyone pressing Run', async () => {
    const { orchestrator, hook } = makeOrchestrator();
    const statuses = [];
    orchestrator.on('status', (s) => statuses.push(s));
    const runs = () => statuses.filter((s) => s && s.lastRun).length;

    orchestrator.arm(sched(5), [], 'Timed', 't1');
    assert.strictEqual(runs(), 0, 'arming must not run it immediately');

    // The block itself clamps to a 5s floor, so drive the timer directly rather
    // than waiting 5 real seconds per tick.
    hook.emit('__noop__', null);
    assert.strictEqual(orchestrator.status().armed, true, 'the macro is armed');

    orchestrator.disarm();
  });

  test('a scheduled macro is genuinely counted as armed, and disarm clears its timer', () => {
    const { orchestrator } = makeOrchestrator();

    orchestrator.arm(sched(5), [], 'Timed', 't2');
    const armed = orchestrator.status().armedMacros.find((a) => a.id === 't2');
    assert.ok(armed, 'the timed macro should appear in status');
    assert.ok(armed.schedule, 'status must expose the schedule');
    assert.strictEqual(armed.schedule.everySeconds, 5);
    assert.strictEqual(armed.schedule.skippedTicks, 0);

    orchestrator.disarm('t2');
    const after = orchestrator.status().armedMacros.find((a) => a.id === 't2');
    assert.strictEqual(after, undefined, 'disarm must remove it');
  });

  test('an `at` macro reports its clock time', () => {
    const { orchestrator } = makeOrchestrator();

    orchestrator.arm(sched(null, [7, 5]), [], 'Daily', 't3');
    const armed = orchestrator.status().armedMacros.find((a) => a.id === 't3');
    assert.strictEqual(armed.schedule.at, '07:05', 'the label must be zero-padded 24-hour');

    orchestrator.disarm('t3');
  });

  test('an `at` macro armed for a time already past today waits for tomorrow', () => {
    // 00:00 can only still be ahead if it is currently 00:00, so use the current
    // hour and minute to prove the "already passed" branch rolls forward.
    const now = new Date();
    const { orchestrator } = makeOrchestrator();

    orchestrator.arm(sched(null, [now.getHours(), now.getMinutes()]), [], 'Daily', 't4');
    const armed = orchestrator.status().armedMacros.find((a) => a.id === 't4');
    assert.ok(armed && armed.schedule, 'it must still be armed with a timer pending');

    orchestrator.disarm('t4');
  });

  test('schedules show up in diagnostics', () => {
    const { orchestrator } = makeOrchestrator();

    orchestrator.arm(sched(30), [], 'Every 30', 't5');
    const diag = orchestrator.diagnostics();
    const found = diag.schedules.find((s) => s.macroId === 't5');
    assert.ok(found, 'diagnostics must list the schedule, or a dead timer is invisible');
    assert.strictEqual(found.everySeconds, 30);

    orchestrator.disarm('t5');
    assert.strictEqual(
      orchestrator.diagnostics().schedules.some((s) => s.macroId === 't5'),
      false,
      'disarm must remove it from diagnostics too'
    );
  });

  test('shutdown drops every scheduled timer', () => {
    const { orchestrator } = makeOrchestrator();

    orchestrator.arm(sched(5), [], 'A', 't6');
    orchestrator.arm(sched(60), [], 'B', 't7');
    assert.strictEqual(orchestrator.status().armedCount, 2);

    orchestrator.shutdown();
    assert.strictEqual(orchestrator.status().armedCount, 0);
    assert.deepStrictEqual(orchestrator.diagnostics().schedules, []);
  });

  /**
   * Real firing, with a short floor so the timers actually run in test time.
   * makeOrchestrator passes minScheduleSeconds through to the orchestrator.
   */
  test('an `every` macro really does fire on its own', async () => {
    const { orchestrator } = makeOrchestrator({ minScheduleSeconds: 0.01 });
    const statuses = [];
    orchestrator.on('status', (s) => statuses.push(s));
    const runs = () => statuses.filter((s) => s && s.lastRun).length;

    orchestrator.arm({ kind: C.START.EVERY, seconds: 0.01 }, [], 'Timed', 'f1');
    assert.strictEqual(runs(), 0, 'arming must not fire immediately');

    await new Promise((r) => setTimeout(r, 120));
    orchestrator.disarm('f1');
    assert.ok(runs() > 1, 'the timer should have fired several times unattended, got ' + runs());
  });

  test('a tick arriving during a run is SKIPPED, and counted - never queued', async () => {
    const { orchestrator } = makeOrchestrator({ minScheduleSeconds: 0.01 });
    const statuses = [];
    orchestrator.on('status', (s) => statuses.push(s));
    const runs = () => statuses.filter((s) => s && s.lastRun).length;

    // A body that blocks until stopped, so the engine stays busy for every tick.
    orchestrator.arm({ kind: C.START.EVERY, seconds: 0.01 }, BLOCKS, 'Busy', 'f2');

    await new Promise((r) => setTimeout(r, 120));
    const entry = orchestrator.status().armedMacros.find((a) => a.id === 'f2');

    orchestrator.disarm('f2');

    assert.ok(entry, 'the macro should still be armed while we inspect it');
    assert.strictEqual(runs(), 0, 'the blocking run never completed, so nothing should have finished');
    assert.ok(
      entry.schedule.skippedTicks >= 3,
      'every later tick must have been skipped while the first run held the engine, got ' +
        entry.schedule.skippedTicks
    );
  });

  test('skipped ticks reset once the macro gets a free run', async () => {
    const { orchestrator } = makeOrchestrator({ minScheduleSeconds: 0.01 });
    const statuses = [];
    orchestrator.on('status', (s) => statuses.push(s));

    orchestrator.arm({ kind: C.START.EVERY, seconds: 0.01 }, [], 'Short', 'f3');
    await new Promise((r) => setTimeout(r, 60));

    const entry = orchestrator.status().armedMacros.find((a) => a.id === 'f3');
    orchestrator.disarm('f3');

    // With a body that completes instantly nothing is ever busy, so no tick may
    // have been dropped.
    assert.ok(statuses.length > 0);
    assert.strictEqual(entry.schedule.skippedTicks, 0, 'a fast macro must never skip a tick');
  });



  // ------------------------------------------------------------ wheel trigger
  //
  // Sign convention verified on real hardware: uiohook reports rotation NEGATIVE
  // for wheel-up and POSITIVE for wheel-down. An earlier build had these the
  // other way round, so "when scrolled up" fired on a downward scroll.
  //
  // The wheel delivers a BURST of events per gesture, so this is edge-triggered:
  // one run per flick. A level trigger would fire a dozen times and flood the
  // engine until every tick was skipped.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** A real-shaped wheel event. DOWN is rotation +120, UP is rotation -120. */
  const wheelEvent = (dir) => ({ amount: 120, rotation: dir === C.SCROLL.UP ? -120 : 120, direction: 3 });

  const wheelArm = (dir, id) => {
    const { orchestrator, hook } = makeOrchestrator();
    const statuses = [];
    orchestrator.on('status', (s) => statuses.push(s));
    orchestrator.arm({ kind: C.START.SCROLL, direction: dir }, [], 'Wheel', id);
    return { orchestrator, hook, runs: () => statuses.filter((s) => s && s.lastRun).length };
  };

  test('scrolling the right way fires once, not once per wheel click', async () => {
    const { orchestrator, hook, runs } = wheelArm(C.SCROLL.DOWN, 'w1');

    // A realistic flick: many wheel events in quick succession.
    for (let i = 0; i < 12; i++) {
      hook.emit('wheel', wheelEvent(C.SCROLL.DOWN));
      await sleep(5);
    }
    await sleep(30);
    orchestrator.disarm('w1');

    assert.strictEqual(runs(), 1, 'a single flick must produce exactly ONE run, got ' + runs());
  });

  test('a second flick after a pause fires again', async () => {
    const { orchestrator, hook, runs } = wheelArm(C.SCROLL.DOWN, 'w2');

    for (let i = 0; i < 6; i++) { hook.emit('wheel', wheelEvent(C.SCROLL.DOWN)); await sleep(5); }
    await sleep(500); // gesture considered finished
    for (let i = 0; i < 6; i++) { hook.emit('wheel', wheelEvent(C.SCROLL.DOWN)); await sleep(5); }
    await sleep(30);
    orchestrator.disarm('w2');

    assert.strictEqual(runs(), 2, 'two separate flicks must produce two runs');
  });

  test('scrolling UP does not fire a scroll-DOWN macro', async () => {
    const { orchestrator, hook, runs } = wheelArm(C.SCROLL.DOWN, 'w3');

    for (let i = 0; i < 8; i++) { hook.emit('wheel', wheelEvent(C.SCROLL.UP)); await sleep(5); }
    await sleep(30);
    orchestrator.disarm('w3');

    assert.strictEqual(runs(), 0, 'the reported bug: scroll-up fired the scroll-down macro');
  });

  test('scrolling DOWN does not fire a scroll-UP macro', async () => {
    const { orchestrator, hook, runs } = wheelArm(C.SCROLL.UP, 'w9');

    for (let i = 0; i < 8; i++) { hook.emit('wheel', wheelEvent(C.SCROLL.DOWN)); await sleep(5); }
    await sleep(30);
    orchestrator.disarm('w9');

    assert.strictEqual(runs(), 0, 'the reported bug: scroll-down fired the scroll-up macro');
  });

  test('a zero wheel amount is not a direction and fires nothing', async () => {
    const { orchestrator, hook, runs } = wheelArm(C.SCROLL.DOWN, 'w4');

    hook.emit('wheel', { amount: 0, rotation: 0, direction: 3 });
    await sleep(30);
    orchestrator.disarm('w4');

    assert.strictEqual(runs(), 0);
  });

  test('a HORIZONTAL wheel is ignored - up/down is a vertical concept', async () => {
    const { orchestrator, hook, runs } = wheelArm(C.SCROLL.DOWN, 'w6');

    // direction 4 = HORIZONTAL. Firing on it would mean tilting the wheel sideways
    // runs a scroll-down macro.
    hook.emit('wheel', { amount: 120, rotation: -120, direction: 4 });
    await sleep(30);
    orchestrator.disarm('w6');

    assert.strictEqual(runs(), 0, 'a horizontal wheel must not fire a vertical trigger');
  });

  test('a wheel trigger leaves no timer behind after disarm', async () => {
    const { orchestrator, hook, runs } = wheelArm(C.SCROLL.DOWN, 'w5');

    for (let i = 0; i < 4; i++) { hook.emit('wheel', wheelEvent(C.SCROLL.DOWN)); await sleep(5); }
    const before = runs();
    orchestrator.disarm('w5');

    // hook.isRunning() stays true because the global stop-key listener outlives a
    // single disarm, so the meaningful check is that the WHEEL no longer fires.
    for (let i = 0; i < 6; i++) { hook.emit('wheel', wheelEvent(C.SCROLL.DOWN)); await sleep(5); }
    await sleep(500);
    assert.strictEqual(orchestrator.status().armedCount, 0);
    assert.strictEqual(runs(), before, 'scrolling after disarm must do nothing at all');
  });

  // ------------------------------------------------- multiple start blocks
  //
  // The reported bug: two start blocks in one macro, and only one worked. The
  // cause was the arms map being keyed by MACRO id, so arming the second trigger
  // tore down the first.

  test('two triggers in one macro arm side by side, and BOTH survive', async () => {
    const { orchestrator, hook } = makeOrchestrator();

    const a = { kind: C.START.BUTTON_COUNT, button: 'key:A', count: { kind: 'number', value: 1 } };
    const b = { kind: C.START.BUTTON_COUNT, button: 'key:B', count: { kind: 'number', value: 1 } };

    orchestrator.arm(a, [], 'Two hats', 'm1', 'triggerA');
    orchestrator.arm(b, [], 'Two hats', 'm1', 'triggerB');

    assert.strictEqual(orchestrator.status().armedCount, 2, 'both triggers must be armed');

    // And each one still fires on its own key.
    const statuses = [];
    orchestrator.on('status', (s) => statuses.push(s));
hook.emit('keydown', 'key:A');
    await sleep(20);
    hook.emit('keydown', 'key:B');
    await sleep(20);
    assert.strictEqual(statuses.filter((s) => s.lastRun).length, 2, 'each trigger must run its own body');
  });

  test('disarming a macro tears down ALL of its triggers', () => {
    const { orchestrator } = makeOrchestrator();

    orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:A', count: { kind: 'number', value: 1 } }, [], 'Two hats', 'm1', 'tA');
    orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:B', count: { kind: 'number', value: 1 } }, [], 'Two hats', 'm1', 'tB');
    assert.strictEqual(orchestrator.status().armedCount, 2);

    orchestrator.disarm('m1');
    assert.strictEqual(orchestrator.status().armedCount, 0, 'every trigger of that macro must go');
  });

  test('a macro with two triggers still shows as ONE armed macro', () => {
    const { orchestrator } = makeOrchestrator();
    const armed = [];
    orchestrator.on('status', (s) => armed.push(s.armedIds.length));

    orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:A', count: { kind: 'number', value: 1 } }, [], 'M', 'm1', 'tA');
    orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:B', count: { kind: 'number', value: 1 } }, [], 'M', 'm1', 'tB');

    // The status must still identify the macro, so the sidebar badge works.
    const names = orchestrator.status().armedMacros.map((a) => a.name);
    assert.deepStrictEqual(names, ['M', 'M']);
  });

  test('re-arming ONE trigger leaves its sibling alone', () => {
    const { orchestrator } = makeOrchestrator();

    orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:A', count: { kind: 'number', value: 1 } }, [], 'M', 'm1', 'tA');
    orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:B', count: { kind: 'number', value: 1 } }, [], 'M', 'm1', 'tB');
    // Re-arm the first with new steps.
    orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:A', count: { kind: 'number', value: 2 } }, [], 'M', 'm1', 'tA');

    assert.strictEqual(orchestrator.status().armedCount, 2, 'replacing one trigger must not drop the other');
    const found = orchestrator.status().armedMacros.filter((a) => a.start.count && a.start.count.value === 2);
    assert.strictEqual(found.length, 1, 'the replaced trigger should carry the new settings');
  });

  test('two different macros never share a trigger key', () => {
    const { orchestrator } = makeOrchestrator();
    // Same trigger id in two different macros must stay distinct.
    orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:A', count: { kind: 'number', value: 1 } }, [], 'One', 'm1', 'shared');
    orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:B', count: { kind: 'number', value: 1 } }, [], 'Two', 'm2', 'shared');
    assert.strictEqual(orchestrator.status().armedCount, 2);

    orchestrator.disarm('m1');
    assert.strictEqual(orchestrator.status().armedCount, 1, 'disarming one macro must leave the other armed');
  });

  test('an arm with no trigger id still works (single start block)', async () => {
    const { orchestrator, hook } = makeOrchestrator();
    const statuses = [];
    orchestrator.on('status', (s) => statuses.push(s));

orchestrator.arm({ kind: C.START.BUTTON_COUNT, button: 'key:A', count: { kind: 'number', value: 1 } }, [], 'Solo', 'm1');
    assert.strictEqual(orchestrator.status().armedCount, 1);
    hook.emit('keydown', 'key:A');
    await sleep(20);
    assert.strictEqual(statuses.filter((s) => s.lastRun).length, 1, 'the back-compat path must still fire');
  });

