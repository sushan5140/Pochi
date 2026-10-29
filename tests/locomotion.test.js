// Run with: node --test tests/locomotion.test.js
// Exercise the real Electron renderer in a tiny DOM/IPC simulation.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness() {
  const callbacks = [];
  let tick = 0;
  let stateHandler;
  const dragEnds = [];
  const windowHandlers = {};
  const clearedTimers = [];
  const motionSetting = { matches: false, addEventListener(name, cb) { this.onChange = cb; } };
  const element = () => ({
    style: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 144, bottom: 144 }),
    set src(v) { this._src = v; },
    get src() { return this._src; }
  });
  const dom = { 'pochi-wrap': element(), 'pochi-sprite': element(), 'pochi-bubble': element() };
  const context = vm.createContext({
    document: { getElementById: key => dom[key] },
    window: {
      matchMedia: () => motionSetting,
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (name, fn) => { windowHandlers[name] = fn; },
      removeEventListener() {},
      pochi: {
        onState: cb => { stateHandler = cb; },
        settled() {},
        setIgnoreMouse() {},
        dragStart() {}, dragEnd: point => dragEnds.push(point)
      },
      pochiSound: { play() {} }
    },
    performance: { now: () => tick },
    requestAnimationFrame: cb => callbacks.push(cb),
    setTimeout: () => 1,
    clearTimeout: id => clearedTimers.push(id),
    Math
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8'), context);
  const sample = expr => vm.runInContext(expr, context);
  const advance = (frames = 1) => {
    for (let i = 0; i < frames; i++) {
      tick += 1000 / 30 + 0.01;
      const next = callbacks.shift();
      if (!next) {
        // A settled simulation correctly stops scheduling rAF; advancing
        // beyond that point is harmless, not a test failure.
        if (!vm.runInContext('isAnimating()', context)) continue;
        throw new Error('Animation loop stopped while still animating');
      }
      next(tick);
    }
  };
  return { send: data => stateHandler(data), sample, advance, dragEnds, windowHandlers, clearedTimers, motionSetting };
}

test('acceleration begins from rest and ramps up without exceeding the gait cap', () => {
  const h = harness();
  h.send({ state: 'walking', target: { x: 900, y: 0 }, gait: 'normal' });
  assert.equal(h.sample('sim.currentSpeed'), 0);
  h.advance();
  const first = h.sample('sim.currentSpeed');
  assert.ok(first > 0 && first < 130, 'first frame must accelerate from rest');
  h.advance(8);
  assert.ok(h.sample('sim.currentSpeed') > first, 'velocity increases');
  h.advance(20);
  assert.ok(h.sample('sim.currentSpeed') <= 130, 'normal speed cap preserved');
});

test('braking lowers speed near target and finishes exactly on the goal', () => {
  const h = harness();
  h.send({ state: 'walking', target: { x: 210, y: 0 }, gait: 'normal' });
  const speeds = [];
  let finished = false;
  for (let i = 0; i < 250; i++) {
    if (!h.sample('sim.moving')) { finished = true; break; }
    h.advance();
    speeds.push(h.sample('sim.currentSpeed'));
  }
  assert.ok(finished, 'walk should finish');
  assert.ok(speeds.some(v => v >= 120), 'walk reaches cruise speed');
  assert.ok(speeds.some((v, i) => i > 10 && v > 0 && v < 100),
    'speed drops during the final approach');
  assert.equal(h.sample('sim.x'), 210, 'no overshoot');
  assert.equal(h.sample('sim.currentSpeed'), 0, 'rest on arrival');
});

test('sleepy gait obeys the lower speed cap on a long walk', () => {
  const h = harness();
  h.send({ state: 'walking', target: { x: 900, y: 0 }, gait: 'sleepy' });
  h.advance(30);
  assert.ok(h.sample('sim.currentSpeed') <= 70);
});

test('short trips use a gentler cruise speed than long trips', () => {
  const shortWalk = harness();
  shortWalk.send({ state: 'walking', target: { x: 35, y: 0 }, gait: 'normal' });
  const shortCap = shortWalk.sample('sim.cruiseSpeed');
  const longWalk = harness();
  longWalk.send({ state: 'walking', target: { x: 350, y: 0 }, gait: 'normal' });
  const longCap = longWalk.sample('sim.cruiseSpeed');
  assert.ok(shortCap < longCap);
  assert.equal(longCap, 130);
  assert.ok(shortCap > 0 && shortCap <= 130);
});

test('short-trip pacing still reaches target without overshoot', () => {
  const h = harness();
  h.send({ state: 'walking', target: { x: 35, y: 0 }, gait: 'normal' });
  for (let i = 0; i < 250 && h.sample('sim.moving'); i++) h.advance();
  assert.equal(h.sample('sim.moving'), false);
  assert.equal(h.sample('sim.x'), 35);
  assert.equal(h.sample('sim.currentSpeed'), 0);
});

test('adaptive speed respects the sleepy gait cap', () => {
  const h = harness();
  h.send({ state: 'walking', target: { x: 25, y: 0 }, gait: 'sleepy' });
  assert.ok(h.sample('sim.cruiseSpeed') < 70);
  assert.ok(h.sample('sim.cruiseSpeed') > 0);
});

test('gravity jump rises, falls, and returns to the original ground position', () => {
  const h = harness();
  assert.equal(h.sample('startJump()'), true);
  assert.equal(h.sample('startJump()'), false, 'no double jump');
  let apex = 0;
  for (let i = 0; i < 90 && (h.sample('sim.jumpVelocity') !== 0 || h.sample('sim.jumpY') !== 0); i++) {
    h.advance();
    apex = Math.min(apex, h.sample('sim.jumpY'));
  }
  assert.ok(apex < -15, 'jump rises off the ground');
  assert.equal(h.sample('sim.jumpY'), 0, 'no ground penetration');
  assert.equal(h.sample('sim.jumpVelocity'), 0, 'velocity reset on landing');
  assert.equal(h.sample('sim.y'), 0, 'the underlying ground coordinate is unchanged');
});

test('movement and dragging cannot initiate overlapping jumps', () => {
  const h = harness();
  h.send({ state: 'walking', target: { x: 300, y: 0 }, gait: 'normal' });
  assert.equal(h.sample('startJump()'), false);
  h.send({ state: 'idle', pose: null });
  assert.equal(h.sample('startJump()'), true);
  h.send({ state: 'nagging_water', pose: 'water_bottle' });
  assert.equal(h.sample('sim.jumpY'), 0);
  assert.equal(h.sample('sim.jumpVelocity'), 0);
});

test('landing produces a short squash and returns to neutral proportions', () => {
  const h = harness();
  assert.equal(h.sample('startJump()'), true);
  for (let i = 0; i < 90 && h.sample('sim.landingTime') === 0; i++) h.advance();
  assert.ok(h.sample('sim.landingTime') > 0, 'ground contact triggers recovery');
  h.advance(2);
  assert.ok(h.sample('landingScale().x') > 1, 'horizontal squash expands');
  assert.ok(h.sample('landingScale().y') < 1, 'vertical squash compresses');
  for (let i = 0; i < 30 && h.sample('sim.landingTime') > 0; i++) h.advance();
  assert.equal(h.sample('sim.landingTime'), 0, 'recovery finishes');
  assert.equal(h.sample('landingScale().x'), 1);
  assert.equal(h.sample('landingScale().y'), 1);
  assert.equal(h.sample('sim.y'), 0, 'ground coordinates never shift');
});

test('new state cancels landing recovery to avoid overlapping animations', () => {
  const h = harness();
  h.sample('sim.landingTime = LANDING_RECOVERY_S');
  h.send({ state: 'nagging_water', pose: 'water_bottle' });
  assert.equal(h.sample('sim.landingTime'), 0);
});

test('redundant idle updates preserve jump and landing but interruptions cancel them', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  assert.equal(h.sample('startJump()'), true);
  h.advance(3);
  const before = h.sample('sim.jumpY');
  assert.ok(before < 0);
  h.send({ state: 'idle', pose: null, expression: 'happy' });
  assert.equal(h.sample('sim.jumpY'), before, 'ordinary idle refresh should not teleport jump');
  h.send({ state: 'walking', target: { x: 140, y: 0 } });
  assert.equal(h.sample('sim.jumpY'), 0, 'new walking target cancels jump');
  assert.equal(h.sample('sim.jumpVelocity'), 0);
});

test('repeated landing-state refresh does not cancel recovery', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  h.sample('sim.landingTime = LANDING_RECOVERY_S');
  h.send({ state: 'idle', pose: null, expression: 'happy' });
  assert.equal(h.sample('sim.landingTime'), h.sample('LANDING_RECOVERY_S'));
  h.send({ state: 'sleeping', pose: null });
  assert.equal(h.sample('sim.landingTime'), 0);
});

test('teleports cancel jump offset and reset moving speed', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  h.sample('startJump()');
  h.advance(3);
  h.send({ state: 'idle', place: { x: 80, y: 45 } });
  assert.equal(h.sample('sim.jumpY'), 0);
  assert.equal(h.sample('sim.jumpVelocity'), 0);
  assert.equal(h.sample('sim.x'), 80);
  assert.equal(h.sample('sim.y'), 45);
});

test('release momentum dissipates and dragEnd reports the final resting position', () => {
  const h = harness();
  h.sample('sim.x = 150; sim.y = 100; sim.glideVX = 220; sim.glideVY = 0; sim.gliding = true; ensureLoop()');
  h.advance(20);
  assert.equal(h.sample('sim.gliding'), false);
  assert.ok(h.sample('sim.x') > 150, 'glide should move Pochi forward');
  assert.ok(h.sample('sim.x') < 190, 'friction limits total displacement');
  assert.equal(h.dragEnds.length, 1, 'only one dragEnd message');
  assert.equal(h.dragEnds[0].x, h.sample('sim.x'), 'main receives final position');
});

test('glide stops at screen boundary instead of escaping the overlay', () => {
  const h = harness();
  h.sample('sim.x = 650; sim.y = 100; sim.glideVX = 260; sim.glideVY = 0; sim.gliding = true; ensureLoop()');
  h.advance(8);
  assert.equal(h.sample('sim.gliding'), false);
  assert.equal(h.sample('sim.x'), 656);
  assert.equal(h.dragEnds.length, 1);
});

test('canceling glide sends completion once, and idle does not animate indefinitely', () => {
  const h = harness();
  h.sample('sim.x = 100; sim.glideVX = 200; sim.glideVY = 0; sim.gliding = true; ensureLoop()');
  h.sample('finishGlide()');
  h.sample('finishGlide()');
  assert.equal(h.dragEnds.length, 1);
  assert.equal(h.sample('sim.gliding'), false);
});

test('fast throw slows under friction and reports one final dragEnd', () => {
  const h = harness();
  h.sample('sim.x = 150; sim.y = 100; sim.glideVX = 500; sim.glideVY = 0; sim.throwing = true; sim.gliding = true; ensureLoop()');
  h.advance(2);
  assert.ok(h.sample('sim.glideVX') < 500, 'throw slows due to friction');
  for (let i = 0; i < 90 && h.sample('sim.gliding'); i++) h.advance();
  assert.equal(h.sample('sim.gliding'), false);
  assert.equal(h.sample('sim.throwing'), false);
  assert.equal(h.dragEnds.length, 1);
  assert.equal(h.dragEnds[0].x, h.sample('sim.x'));
});

test('fast throw rebounds at most once and never leaves the display', () => {
  const h = harness();
  h.sample('sim.x = 651; sim.y = 100; sim.glideVX = 500; sim.glideVY = 0; sim.throwing = true; sim.gliding = true; ensureLoop()');
  h.advance();
  assert.equal(h.sample('sim.throwBounces'), 1);
  assert.ok(h.sample('sim.glideVX') < 0, 'velocity reverses after impact');
  for (let i = 0; i < 90 && h.sample('sim.gliding'); i++) h.advance();
  assert.ok(h.sample('sim.x') >= 0 && h.sample('sim.x') <= 656);
  assert.equal(h.dragEnds.length, 1);
});

test('ordinary glide does not receive throw-speed or bounce mechanics', () => {
  const h = harness();
  h.sample('sim.x = 651; sim.y = 100; sim.glideVX = 220; sim.glideVY = 0; sim.throwing = false; sim.gliding = true; ensureLoop()');
  h.advance(3);
  assert.equal(h.sample('sim.gliding'), false);
  assert.equal(h.dragEnds.length, 1);
});

test('out-of-bounds drag and walking targets clamp to the overlay', () => {
  const h = harness();
  h.send({ state: 'idle', place: { x: -80, y: 3000 } });
  assert.equal(h.sample('sim.x'), 0);
  assert.equal(h.sample('sim.y'), 456);
  h.send({ state: 'walking', target: { x: 3000, y: -20 } });
  assert.equal(h.sample('sim.targetX'), 656);
  assert.equal(h.sample('sim.targetY'), 0);
});

test('desktop resizing clamps positions and finishes an active throw once', () => {
  const h = harness();
  h.sample('sim.x = 800; sim.y = -100; sim.glideVX = 200; sim.gliding = true');
  h.windowHandlers.resize();
  assert.equal(h.sample('sim.x'), 656);
  assert.equal(h.sample('sim.y'), 0);
  assert.equal(h.sample('sim.gliding'), false);
  assert.equal(h.dragEnds.length, 1);
  h.windowHandlers.resize();
  assert.equal(h.dragEnds.length, 1);
});

test('dragging cannot leave the overlay even when pointer does', () => {
  const h = harness();
  h.sample('dragCandidate = { active: true, grabOffsetX: 10, grabOffsetY: 10, lastSample: { x: 0, y: 0, time: 0 }, velocity: { x: 0, y: 0 } }');
  h.sample('onDragMove({clientX: -1000, clientY: 2000})');
  assert.equal(h.sample('sim.x'), 0);
  assert.equal(h.sample('sim.y'), 456);
});

test('idle breathing is subtle and stops during locomotion', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  assert.equal(h.sample('breathingScale(0)'), 1);
  const mid = h.sample('breathingScale(2000)');
  assert.ok(mid > 1 && mid <= 1.0061);
  h.send({ state: 'walking', target: { x: 250, y: 0 } });
  assert.equal(h.sample('breathingScale(2000)'), 1);
});

test('breathing is suspended during landing and non-idle poses', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  h.sample('sim.landingTime = LANDING_RECOVERY_S');
  assert.equal(h.sample('breathingScale(2000)'), 1);
  h.sample('sim.landingTime = 0');
  h.send({ state: 'sleeping', pose: null });
  assert.equal(h.sample('breathingScale(2000)'), 1);
});

test('L11 idle micro-motion remains bounded and periodically returns to neutral', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  const neutral = h.sample('idleMicroMotion(500)');
  assert.equal(neutral.blink, 1);
  const closing = h.sample('idleMicroMotion(90)');
  assert.ok(closing.blink >= 0.986 && closing.blink < 1);
  const glance = h.sample('idleMicroMotion(600)');
  assert.ok(glance.glance > 0 && glance.glance <= 0.65);
  assert.equal(h.sample('idleMicroMotion(2000).glance'), 0);
});

test('L11 micro-motion never overrides walking or non-idle expressions', () => {
  const h = harness();
  h.send({ state: 'nagging_water', pose: 'water_bottle' });
  assert.equal(h.sample('idleMicroMotion(90).blink'), 1);
  assert.equal(h.sample('idleMicroMotion(600).glance'), 0);
  h.send({ state: 'walking', target: { x: 300, y: 0 } });
  assert.equal(h.sample('idleMicroMotion(90).blink'), 1);
  assert.equal(h.sample('idleMicroMotion(600).glance'), 0);
});

test('L12 posture moves gently and returns to neutral within one cycle', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  assert.equal(h.sample('idlePosture(0).tilt'), 0);
  const midway = h.sample('idlePosture(POSTURE_PERIOD_MS / 2)');
  assert.ok(midway.shift > 0 && midway.shift <= 1.2);
  assert.ok(midway.tilt > 0 && midway.tilt <= 0.65);
  assert.equal(h.sample('idlePosture(POSTURE_PERIOD_MS * 0.9).tilt'), 0);
});

test('L12 posture does not affect locomotion, landing or non-idle expressions', () => {
  const h = harness();
  h.send({ state: 'walking', target: { x: 200, y: 0 } });
  assert.equal(h.sample('idlePosture(POSTURE_PERIOD_MS / 2).shift'), 0);
  h.send({ state: 'idle', pose: null });
  h.sample('sim.landingTime = LANDING_RECOVERY_S');
  assert.equal(h.sample('idlePosture(POSTURE_PERIOD_MS / 2).tilt'), 0);
  h.sample('sim.landingTime = 0');
  h.send({ state: 'nagging_water', pose: 'water_bottle' });
  assert.equal(h.sample('idlePosture(POSTURE_PERIOD_MS / 2).tilt'), 0);
});

test('L13 prevents physics overlap between a throw and new jump', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  h.sample('sim.gliding = true; sim.throwing = true; sim.glideVX = 200');
  assert.equal(h.sample('startJump()'), false);
  assert.equal(h.sample('sim.jumpVelocity'), 0);
  h.sample('finishGlide()');
  assert.equal(h.sample('startJump()'), true);
});

test('L13 rapid retargeting keeps all movement values finite and in bounds', () => {
  const h = harness();
  h.send({ state: 'walking', target: { x: 600, y: 200 } });
  for (let i = 0; i < 120; i++) {
    if (i % 12 === 0) {
      h.send({ state: 'walking', target: i % 24 === 0 ? { x: 0, y: 0 } : { x: 656, y: 456 } });
    }
    h.advance();
    assert.equal(h.sample('Number.isFinite(sim.x) && Number.isFinite(sim.y) && Number.isFinite(sim.currentSpeed)'), true);
    assert.ok(h.sample('sim.x') >= 0 && h.sample('sim.x') <= 656);
    assert.ok(h.sample('sim.y') >= 0 && h.sample('sim.y') <= 456);
  }
});

test('L14 starting active animation cancels pending idle timer', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  h.sample('idleTimer = 17');
  h.send({ state: 'walking', target: { x: 150, y: 0 } });
  assert.equal(h.sample('idleTimer'), null);
  assert.ok(h.clearedTimers.includes(17));
});

test('L14 transform origin is fixed once and survives multiple render passes', () => {
  const h = harness();
  assert.equal(h.sample("sprite.style.transformOrigin"), '50% 100%');
  h.send({ state: 'idle', pose: null });
  h.sample('render(1000)');
  assert.equal(h.sample("sprite.style.transformOrigin"), '50% 100%');
});

test('L15 redundant display updates never interrupt active glide settlement', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  h.sample('sim.x = 100; sim.y = 100; sim.glideVX = 220; sim.glideVY = 0; sim.gliding = true; ensureLoop()');
  h.send({ state: 'idle', pose: null, expression: 'happy' });
  assert.equal(h.sample('sim.gliding'), true);
  assert.equal(h.dragEnds.length, 0);
  for (let i = 0; i < 90 && h.sample('sim.gliding'); i++) h.advance();
  assert.equal(h.sample('sim.gliding'), false);
  assert.equal(h.dragEnds.length, 1);
});

test('L15 resize clears stale drag-release momentum samples', () => {
  const h = harness();
  h.sample('dragging = true; dragCandidate = { active: true, grabOffsetX: 5, grabOffsetY: 5, lastSample: { x: 600, y: 400, time: -100 }, velocity: { x: 900, y: -500 } }; sim.x = 900; sim.y = 800');
  h.windowHandlers.resize();
  assert.equal(h.sample('sim.x'), 656);
  assert.equal(h.sample('sim.y'), 456);
  assert.equal(h.sample('dragCandidate.velocity.x'), 0);
  assert.equal(h.sample('dragCandidate.velocity.y'), 0);
});

test('L15 genuine new movement cancels active glide exactly once', () => {
  const h = harness();
  h.sample('sim.x = 100; sim.y = 100; sim.glideVX = 200; sim.gliding = true; ensureLoop()');
  h.send({ state: 'walking', target: { x: 200, y: 100 } });
  assert.equal(h.sample('sim.gliding'), false);
  assert.equal(h.dragEnds.length, 1);
  assert.equal(h.sample('sim.moving'), true);
});

test('M2 L1 reduced motion suppresses decorative idle animation', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  assert.ok(h.sample('breathingScale(2000)') > 1);
  h.motionSetting.matches = true;
  h.motionSetting.onChange();
  assert.equal(h.sample('breathingScale(2000)'), 1);
  assert.equal(h.sample('idleMicroMotion(90).blink'), 1);
  assert.equal(h.sample('idleMicroMotion(600).glance'), 0);
  assert.equal(h.sample('idlePosture(POSTURE_PERIOD_MS / 2).tilt'), 0);
  assert.equal(h.sample('idleTimer'), null);
});

test('M2 L1 allows normal idle animations after reduced-motion setting is cleared', () => {
  const h = harness();
  h.send({ state: 'idle', pose: null });
  h.motionSetting.matches = true;
  h.motionSetting.onChange();
  h.motionSetting.matches = false;
  h.motionSetting.onChange();
  assert.ok(h.sample('breathingScale(2000)') > 1);
  assert.ok(h.sample('idlePosture(POSTURE_PERIOD_MS / 2).tilt') > 0);
});
