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
      addEventListener() {},
      removeEventListener() {},
      pochi: {
        onState: cb => { stateHandler = cb; },
        settled() {},
        setIgnoreMouse() {},
        dragStart() {}, dragEnd() {}
      },
      pochiSound: { play() {} }
    },
    performance: { now: () => tick },
    requestAnimationFrame: cb => callbacks.push(cb),
    setTimeout: () => 1,
    clearTimeout() {},
    Math
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8'), context);
  const sample = expr => vm.runInContext(expr, context);
  const advance = (frames = 1) => {
    for (let i = 0; i < frames; i++) {
      tick += 1000 / 30 + 0.01;
      const next = callbacks.shift();
      if (!next) throw new Error('Animation loop stopped unexpectedly');
      next(tick);
    }
  };
  return { send: data => stateHandler(data), sample, advance };
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
