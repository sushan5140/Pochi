// Pochi renderer — owns position and appearance.
//
// There is exactly ONE clock in here: the requestAnimationFrame loop.
// Position is integrated in it, and every visual property (which sprite,
// which way she faces) is a pure function of state sampled inside the
// same frame. Nothing about her appearance is driven by its own timer,
// which is what makes pose and movement structurally unable to desync.
//
// main.js sends intent only ("go here, at this gait, in this state") and
// never positions her; this file is authoritative for where she actually
// is and reports back when she settles.

const wrap = document.getElementById('pochi-wrap');
const sprite = document.getElementById('pochi-sprite');
const bubble = document.getElementById('pochi-bubble');

const DEBUG_EXPRESSIONS = ['happy', 'smug', 'angry', 'tired', 'laughing', 'judging', 'worried', 'sleepy'];
const RESOLVABLE = ['nagging_water', 'nagging_food', 'nagging_break', 'nagging_entertainment', 'nagging_debug_support', 'nagging_distraction'];

// Ping-pong through the 3 frames: contact -> passing -> opposite contact
// -> passing -> ... Frame 2 is the natural midpoint between either contact
// pose, so it gets visited twice per full gait cycle.
const WALK_SETS = {
  side: ['walk_1_contact_right', 'walk_2_passing', 'walk_3_contact_left'],
  front: ['walk_front_1', 'walk_front_2', 'walk_front_3'],
  back: ['walk_back_1', 'walk_back_2', 'walk_back_3']
};
const WALK_SEQUENCE = [0, 1, 2, 1];

// Pixels of real travel per frame advance — the parameter that keeps her
// feet "gripping" the ground. Because the pose advances per distance
// covered rather than per unit of time, the gait cadence scales with
// speed automatically: half speed means half cadence, with no foot
// sliding and nothing to keep in sync by hand. front/back frames read
// more subtly than the side profile, so they advance less often.
const STRIDE_PX = { side: 20, front: 28, back: 28 };

// Procedural secondary motion, per view set, in CSS px at the 144px display
// size. Measured cause: across the three back frames the torso is very
// nearly byte-identical (0.4-1.7% difference in the chest band) while the
// legs change 75-81% — so legs animate underneath a completely frozen body,
// which reads as a paper doll rather than a person. Real gait lifts the
// body over the stance leg at passing and drops it at contact, and sways
// slightly toward whichever leg is bearing weight. The art supplies none of
// that, so it's added here.
//
// Both are pure functions of distanceWalked — the SAME value that selects
// the frame — so they are locked to the stride by construction and cannot
// drift out of phase with it. That is the structural difference from the
// earlier free-running-timer bob, which oscillated independently of whether
// she was actually covering ground.
//
// side is left at 0: its art already carries real torso motion (8-10%
// chest-band change). front is left at 0 until its frames are registered —
// it has an unwanted scale/position wobble already, and adding motion on
// top would compound it.
const GAIT_BOB_PX = { side: 0, front: 0, back: 3 };
const GAIT_SWAY_PX = { side: 0, front: 0, back: 1.5 };

const SPEEDS = { normal: 130, sleepy: 70 };
// M1.1 L1: speed ramps instead of snapping immediately to walking pace.
// Keep stride frames distance-based, so slowing down also slows the feet.
const WALK_ACCEL_PX_S2 = 320;
const WALK_BRAKE_PX_S2 = 440;
// M1.1 L2: stop and pivot on major mid-walk retargets, avoiding abrupt U-turns.
const SHARP_TURN_RAD = Math.PI / 3;
const TURN_RATE_RAD_S = Math.PI * 2; // 180 degrees in about half a second
const TURN_EPSILON_RAD = 0.025;
// M1.1 L3: shorter trips are strolls, not full-speed sprints. Long trips
// retain their original gait cap; sleepy mode keeps its stricter cap.
const SHORT_TRIP_PX = 120;
const SHORT_TRIP_MIN_FACTOR = 0.45;
// M1.2 L4: bounded, on-demand jump; vertical displacement is visual-only.
const JUMP_VELOCITY_PX_S = -220;
const JUMP_GRAVITY_PX_S2 = 750;
// M1.2 L5: brief, damped landing recovery (no extra screen movement).
const LANDING_RECOVERY_S = 0.28;
const LANDING_SQUASH = 0.12;

// Sprite shown when she's stood still with no state-specific pose.
// poses/arms_crossed.png is the only full-body pose that's both upright
// (feet planted, not sitting/kicking/hugging a prop) and not mid-action,
// so it reads as a neutral standing idle rather than a freeze-frame.
const IDLE_STANDING = { kind: 'poses', name: 'arms_crossed' };

const IDLE_ALTERNATE_MS = 2500;
const DEBUG_PREVIEW_MS = 1500;
const DRAG_THRESHOLD_PX = 4;
// Mini-game live-testing surfaced a real gap the distance threshold alone
// can't close: this window runs setIgnoreMouseEvents(true, {forward:true})
// (see main.js), which means it keeps receiving every mousemove across the
// WHOLE screen, not just ones over the sprite, so it can detect re-entry
// for click-through. That's fine for normal clicks (a real click's press
// and release are effectively instantaneous), but a mousedown held open
// even a few milliseconds -- exactly what happens during the mini-game's
// fast repeat-tapping -- has a real chance of an unrelated, ordinary
// mousemove from elsewhere on the screen landing inside that window and
// getting misread as drag movement of THIS gesture, however large the
// distance threshold is (confirmed live: even a generous 40px threshold
// didn't help, since ordinary cross-screen mouse travel routinely exceeds
// that). A real deliberate drag is always held open noticeably longer than
// a tap before the user starts moving to relocate her, so gating on HOLD
// TIME rather than distance is the actual fix: ignore all movement for the
// first MINIGAME_DRAG_HOLD_MS of a gesture that began as a minigame tap.
// main.js still deliberately treats a genuine drag as "cancel the game"
// (grabbing her mid-session is a real, wanted escape hatch) -- this only
// changes how soon that escape hatch can arm, and only for gestures that
// started on a live round, the one interaction pattern fast enough to
// expose this.
const MINIGAME_DRAG_HOLD_MS = 150;
const MAX_FRAME_DT = 0.1; // clamp so a stalled frame can't teleport her
// Animation runs at 30fps, not 60. Every position write forces the
// compositor to redraw a fullscreen transparent always-on-top layer, which
// measured 44% of a core at 60fps for a single moving sprite. Motion stays
// continuous (position is integrated from real elapsed time, not frame
// count) — it's only sampled half as often, which is plenty for a walk.
const MIN_FRAME_MS = 1000 / 30;

// Named `sim`, not `pochi`: the preload script exposes `window.pochi` as a
// non-configurable global, and a top-level `const pochi` cannot shadow it —
// that combination is a SyntaxError that kills this whole file silently.
const sim = {
  x: 0,
  y: 0,
  targetX: 0,
  targetY: 0,
  moving: false,
  speed: SPEEDS.normal,
  cruiseSpeed: SPEEDS.normal,
  currentSpeed: 0,
  jumpY: 0,
  jumpVelocity: 0,
  landingTime: 0,
  turning: false,
  heading: 0,
  turnTarget: 0,
  distanceWalked: 0,
  walkSet: 'side',
  facingLeft: false
};

let latest = { state: 'idle', pose: null, expression: 'happy', dialogue: null };
let dragging = false;
let suppressNextClick = false;
let debugUntil = 0;
let debugIndex = 0;

// Last values written to the DOM, so the loop only touches it on change.
let lastTransform = '';
let lastSrc = '';
let lastSpriteTransform = '';

let loopRunning = false;
let idleTimer = null;
let lastFrameTime = performance.now();

function assetPath(kind, name) {
  return `../assets/${kind}/${name}.png`;
}

// View set follows the actual velocity vector: dominant axis wins, so a
// mostly-vertical diagonal still reads as front/back. Only updated while
// moving, so her facing persists sensibly once she stops.
function updateViewSet(ux, uy) {
  if (Math.abs(uy) > Math.abs(ux)) {
    sim.walkSet = uy < 0 ? 'back' : 'front';
  } else {
    sim.walkSet = 'side';
    sim.facingLeft = ux < 0;
  }
}

function adaptiveCruiseSpeed(distance, gaitSpeed) {
  const fraction = Math.min(1, Math.max(0, distance / SHORT_TRIP_PX));
  return gaitSpeed * (SHORT_TRIP_MIN_FACTOR + (1 - SHORT_TRIP_MIN_FACTOR) * fraction);
}

function shortestAngle(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function faceHeading(angle) {
  updateViewSet(Math.cos(angle), Math.sin(angle));
}

function startJump() {
  if (dragging || sim.jumpY !== 0 || sim.jumpVelocity !== 0 || sim.moving) return false;
  sim.landingTime = 0;
  sim.jumpVelocity = JUMP_VELOCITY_PX_S;
  ensureLoop();
  return true;
}

function updateJump(dt) {
  if (sim.jumpVelocity === 0 && sim.jumpY === 0) return;
  const nextVelocity = sim.jumpVelocity + JUMP_GRAVITY_PX_S2 * dt;
  sim.jumpY += (sim.jumpVelocity + nextVelocity) * 0.5 * dt;
  sim.jumpVelocity = nextVelocity;
  if (sim.jumpY >= 0) {
    sim.jumpY = 0;
    sim.jumpVelocity = 0;
    sim.landingTime = LANDING_RECOVERY_S;
  }
}

function landingScale() {
  if (sim.landingTime <= 0) return { x: 1, y: 1 };
  const progress = 1 - sim.landingTime / LANDING_RECOVERY_S;
  const damped = Math.sin(Math.PI * progress) * Math.exp(-3 * progress);
  return { x: 1 + LANDING_SQUASH * damped, y: 1 - LANDING_SQUASH * damped };
}

function stopMoving(reachedTarget) {
  if (!sim.moving) return;
  sim.moving = false;
  sim.currentSpeed = 0;
  sim.turning = false;
  sim.distanceWalked = 0;
  window.pochi.settled({ x: sim.x, y: sim.y, reachedTarget });
}

// The whole appearance rule, in one place. Walking frames come from
// distance travelled; everything else is a static sprite (with the
// pose/expression alternation for states that have both).
function spriteSrcFor(now) {
  if (now < debugUntil) {
    return assetPath('expressions', DEBUG_EXPRESSIONS[debugIndex]);
  }
  if (sim.turning) {
    return assetPath('walk_cycle', WALK_SETS[sim.walkSet][0]);
  }
  if (sim.moving) {
    const stride = STRIDE_PX[sim.walkSet];
    const i = Math.floor(sim.distanceWalked / stride) % WALK_SEQUENCE.length;
    return assetPath('walk_cycle', WALK_SETS[sim.walkSet][WALK_SEQUENCE[i]]);
  }
  if (latest.pose && Math.floor(now / IDLE_ALTERNATE_MS) % 2 === 0) {
    return assetPath('poses', latest.pose);
  }
  // Plain idle deliberately does NOT fall back to the expression sprite.
  // expressions/ is bust-only (chest-up), not full-body, so it doesn't match
  // the scale/framing used everywhere else on screen. IDLE_STANDING is the
  // one pose that's a neutral full-body upright stance.
  if (!latest.pose) {
    return assetPath(IDLE_STANDING.kind, IDLE_STANDING.name);
  }
  return assetPath('expressions', latest.expression || 'happy');
}

// Vertical bob and lateral sway for the current point in the gait, keyed off
// distance travelled so it stays welded to the frame the walk cycle is
// showing. WALK_SEQUENCE is [contact, passing, contact, passing], one frame
// advance per STRIDE_PX, so a full gait cycle is 4 advances and a single
// step is 2.
function gaitOffset() {
  if (!sim.moving) return { x: 0, y: 0 };
  const bobAmp = GAIT_BOB_PX[sim.walkSet] || 0;
  const swayAmp = GAIT_SWAY_PX[sim.walkSet] || 0;
  if (!bobAmp && !swayAmp) return { x: 0, y: 0 };

  const advances = sim.distanceWalked / STRIDE_PX[sim.walkSet];

  // One rise-and-fall per step: lowest exactly on the contact frames
  // (advance 0, 2), highest on the passing frames (advance 1, 3).
  const bobPhase = advances % 2;
  const y = -bobAmp * (1 - Math.cos(Math.PI * bobPhase)) / 2;

  // Weight shifts to the other leg each step, so sway runs on the full
  // 4-advance cycle: peaks at one passing, troughs at the opposite one.
  const swayPhase = advances % 4;
  const x = swayAmp * Math.sin((Math.PI * swayPhase) / 2);

  return { x, y };
}

function render(now) {
  const transform = `translate3d(${sim.x.toFixed(2)}px, ${(sim.y + sim.jumpY).toFixed(2)}px, 0)`;
  if (transform !== lastTransform) {
    wrap.style.transform = transform;
    lastTransform = transform;
  }

  const src = spriteSrcFor(now);
  if (src !== lastSrc) {
    sprite.src = src;
    lastSrc = src;
  }

  // Flip is listed last so it resolves first, leaving the bob/sway translate
  // in unmirrored screen space rather than being flipped along with her.
  const flip = (sim.walkSet === 'side' && sim.facingLeft) ? 'scaleX(-1)' : '';
  const gait = gaitOffset();
  const landing = landingScale();
  const recovery = sim.landingTime > 0
    ? `scale(${landing.x.toFixed(4)}, ${landing.y.toFixed(4)})` : '';
  // Scale is centered at the feet by anchoring the transform origin.
  const spriteTransform = [
    (gait.x || gait.y) ? `translate(${gait.x.toFixed(2)}px, ${gait.y.toFixed(2)}px)` : '',
    recovery, flip
  ].filter(Boolean).join(' ');
  if (spriteTransform !== lastSpriteTransform) {
    sprite.style.transformOrigin = '50% 100%';
    sprite.style.transform = spriteTransform;
    lastSpriteTransform = spriteTransform;
  }
}

// The loop only runs while something is genuinely animating. This window
// is a fullscreen transparent overlay, so an always-on rAF makes the
// compositor redraw the whole screen 60x a second even when she's stood
// still — which is most of the time, and cost ~26% of a core.
function isAnimating() {
  return sim.moving || sim.jumpVelocity !== 0 || sim.jumpY !== 0 || sim.landingTime > 0 || dragging || performance.now() < debugUntil;
}

function ensureLoop() {
  if (loopRunning) return;
  loopRunning = true;
  lastFrameTime = performance.now();
  requestAnimationFrame(loop);
}

// Declared before use by loop() below; see scheduleFrame().

function scheduleFrame() {
  requestAnimationFrame(loop);
}

function loop(now) {
  // Stay on rAF (vsync-aligned, no tearing) but only do work every other
  // frame. Pacing with setTimeout instead was measurably cheaper but landed
  // at ~22fps once the timer and the vsync wait stacked up; the extra ~3%
  // of a core buys a true, even 30fps, which matters more here.
  if (now - lastFrameTime < MIN_FRAME_MS - 1) {
    requestAnimationFrame(loop);
    return;
  }
  const dt = Math.min((now - lastFrameTime) / 1000, MAX_FRAME_DT);
  lastFrameTime = now;

  if (sim.moving && !dragging) {
    if (sim.turning) {
      // Stop before pivoting; turning in place never advances walk frames.
      sim.currentSpeed = Math.max(0, sim.currentSpeed - WALK_BRAKE_PX_S2 * dt);
      if (sim.currentSpeed <= 0) {
        const difference = shortestAngle(sim.heading, sim.turnTarget);
        const turnStep = Math.max(-TURN_RATE_RAD_S * dt,
          Math.min(TURN_RATE_RAD_S * dt, difference));
        sim.heading += turnStep;
        faceHeading(sim.heading);
        if (Math.abs(difference) <= TURN_EPSILON_RAD ||
            Math.abs(turnStep - difference) < 0.000001) {
          sim.heading = sim.turnTarget;
          faceHeading(sim.heading);
          sim.turning = false;
        }
      }
    } else {
    const dx = sim.targetX - sim.x;
    const dy = sim.targetY - sim.y;
    const remaining = Math.hypot(dx, dy);
    if (remaining < 0.5) {
      sim.x = sim.targetX;
      sim.y = sim.targetY;
      stopMoving(true);
    } else {
      // Braking envelope: v^2 <= 2*a*distance. This makes arrival gentle
      // while retaining the existing max normal/sleepy speeds.
      const safeSpeed = Math.min(sim.cruiseSpeed, Math.sqrt(2 * WALK_BRAKE_PX_S2 * remaining));
      const rate = safeSpeed < sim.currentSpeed ? WALK_BRAKE_PX_S2 : WALK_ACCEL_PX_S2;
      const delta = rate * dt;
      const nextSpeed = sim.currentSpeed + Math.max(-delta, Math.min(delta, safeSpeed - sim.currentSpeed));
      const step = Math.min(remaining, (sim.currentSpeed + nextSpeed) * 0.5 * dt);
      sim.currentSpeed = nextSpeed;

      const ux = dx / remaining;
      const uy = dy / remaining;
      sim.x += ux * step;
      sim.y += uy * step;
      sim.distanceWalked += step;
      sim.heading = Math.atan2(uy, ux);
      updateViewSet(ux, uy);

      if (step >= remaining || remaining - step < 0.5) {
        sim.x = sim.targetX;
        sim.y = sim.targetY;
        stopMoving(true);
      }
    }
    }
  }

  if (!dragging) updateJump(dt);
  if (sim.landingTime > 0) sim.landingTime = Math.max(0, sim.landingTime - dt);
  render(now);

  if (isAnimating()) {
    scheduleFrame();
  } else {
    // Standing still: hand off to a cheap timer that only wakes up when
    // the idle pose/expression is actually due to swap. Movement and
    // walk-frames are still driven solely by the rAF loop above — these
    // two never run at the same time, so nothing can desync.
    loopRunning = false;
    scheduleIdleRefresh();
  }
}

function scheduleIdleRefresh() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (isAnimating() || !latest.pose) return; // nothing alternates without a pose
  const now = performance.now();
  const nextBoundary = (Math.floor(now / IDLE_ALTERNATE_MS) + 1) * IDLE_ALTERNATE_MS;
  idleTimer = setTimeout(() => {
    render(performance.now());
    scheduleIdleRefresh();
  }, Math.max(16, nextBoundary - now));
}

function applyState(data) {
  latest = data;
  debugUntil = 0; // a real state update always beats the debug preview

  if (data.dialogue) {
    bubble.textContent = data.dialogue;
    bubble.classList.add('visible');
  } else {
    bubble.classList.remove('visible');
  }

  // Chapter 23: sound is orthogonal to pose/expression/dialogue above —
  // playing it here means it fires exactly once per sendUpdate() from
  // main.js, regardless of what else that update changed.
  if (data.sound) {
    try { window.pochiSound.play(data.sound); } catch (_) { /* sound is enhancement, never load-bearing */ }
  }

  if (dragging) return; // user has hold of her; ignore positioning intent
  // State transitions take priority over an optional cosmetic jump.
  if (sim.jumpY !== 0 || sim.jumpVelocity !== 0) {
    sim.jumpY = 0;
    sim.jumpVelocity = 0;
  }
  sim.landingTime = 0;

  if (data.place) {
    sim.x = data.place.x;
    sim.y = data.place.y;
    sim.currentSpeed = 0;
    stopMoving(false);
  }

  if (data.target) {
    const dx = data.target.x - sim.x;
    const dy = data.target.y - sim.y;
    if (sim.moving && Math.hypot(dx, dy) > 0.5) {
      const desiredHeading = Math.atan2(dy, dx);
      const difference = Math.abs(shortestAngle(sim.heading, desiredHeading));
      // A sharp retarget becomes a brief stop-and-pivot. Slight corrections
      // continue normally, avoiding jitter near the 60-degree threshold.
      if (difference >= SHARP_TURN_RAD) {
        sim.turning = true;
        sim.turnTarget = desiredHeading;
      } else if (sim.turning) {
        sim.turnTarget = desiredHeading;
      }
    }
    sim.targetX = data.target.x;
    sim.targetY = data.target.y;
    sim.speed = SPEEDS[data.gait] || SPEEDS.normal;
    sim.cruiseSpeed = adaptiveCruiseSpeed(Math.hypot(dx, dy), sim.speed);
    // distanceWalked deliberately carries over on a retarget, so being
    // redirected mid-stride continues the gait instead of hitching.
    sim.moving = true;
    ensureLoop();
  } else {
    stopMoving(false);
    render(performance.now());
    scheduleIdleRefresh();
  }
}

window.pochi.onState(applyState);
render(performance.now());
scheduleIdleRefresh();

// Debug/dev affordance: clicking Pochi while she's actively nagging about
// water/food/breaks acknowledges the nag; otherwise it previews the next
// expression. The preview is a timestamp the render function reads, not a
// timer that suspends anything — she keeps walking underneath it and the
// walk frames resume exactly in step when it expires.
sprite.addEventListener('click', (event) => {
  // Explicit opt-in: Ctrl+click performs one small jump, leaving the normal
  // click/double-click, nag resolution, and mini-game semantics untouched.
  if (event.ctrlKey && latest.state === 'idle') {
    startJump();
    return;
  }
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }

  if (RESOLVABLE.includes(latest.state)) {
    window.pochi.resolveNag(latest.state.replace('nagging_', ''));
    return;
  }

  // Mini-game: a click only counts as a catch while a round is genuinely
  // live (latest.state === 'minigame_round'). Between rounds she's
  // showing 'minigame_miss'/'minigame_catch' instead, so a click during
  // those brief pauses correctly falls through to the debug-cycle below
  // rather than racing the main-process round timer.
  if (latest.state === 'minigame_round') {
    window.pochi.gameClick();
    return;
  }

  debugIndex = (debugIndex + 1) % DEBUG_EXPRESSIONS.length;
  debugUntil = performance.now() + DEBUG_PREVIEW_MS;
  ensureLoop(); // runs until the preview expires, then settles back
});

// Chapter 41: double-click starts/stops a Pomodoro session. main.js's
// toggle() owns the active/inactive decision — this just sends intent,
// same division of responsibility as every other click handler here.
// Known rough edge: the two single clicks a native dblclick fires before
// this handler runs still hit the click listener above (a resolve-nag or
// a debug-cycle flicker) before the toggle takes effect. Accepted for v1
// as the simplest implementation; a click/dblclick disambiguation timer
// would fix it at the cost of adding latency to the single-click nag
// resolve, which should stay instant since it's a real feature, not a
// dev affordance.
sprite.addEventListener('dblclick', () => {
  window.pochi.togglePomodoro();
});

// Click-through everywhere except directly over Pochi's sprite.
let lastIgnore = null;
window.addEventListener('mousemove', (event) => {
  const rect = sprite.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (inside !== lastIgnore) {
    lastIgnore = inside;
    window.pochi.setIgnoreMouse(!inside);
  }
});

// Manual drag: right-click-drag, or left-click-and-hold-drag, relocates
// Pochi anywhere on screen and overrides whatever the wander logic was
// doing. A plain quick left click still falls through to the click handler
// above — drag only engages once the pointer moves past a small threshold,
// or immediately for right-click, which has no competing click behavior.
let dragCandidate = null;

sprite.addEventListener('contextmenu', (event) => event.preventDefault());

sprite.addEventListener('mousedown', (event) => {
  if (dragCandidate) return;
  const rect = wrap.getBoundingClientRect();
  dragCandidate = {
    button: event.button,
    startX: event.clientX,
    startY: event.clientY,
    grabOffsetX: event.clientX - rect.left,
    grabOffsetY: event.clientY - rect.top,
    active: false,
    // Captured once, at gesture start -- a round transitioning mid-hold
    // (round -> catch/miss) shouldn't retroactively change how this
    // particular gesture is treated.
    isMinigameTap: latest.state === 'minigame_round',
    startTime: performance.now()
  };
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragUp);
  if (event.button === 2) event.preventDefault();
});

function beginDrag() {
  dragCandidate.active = true;
  stopMoving(false);
  sim.jumpY = 0;
  sim.jumpVelocity = 0;
  sim.landingTime = 0;
  dragging = true;
  debugUntil = 0;
  sprite.classList.add('is-dragging');
  window.pochi.setIgnoreMouse(false);
  window.pochi.dragStart();
  ensureLoop();
}

function onDragMove(event) {
  if (!dragCandidate) return;

  if (!dragCandidate.active) {
    if (dragCandidate.button !== 2 && dragCandidate.isMinigameTap &&
        performance.now() - dragCandidate.startTime < MINIGAME_DRAG_HOLD_MS) {
      // Too soon to be an intentional drag -- a real tap-click, synthetic
      // or human, is released well inside this window; any movement seen
      // this early is unrelated screen-wide mouse traffic riding along on
      // forward:true, not this gesture actually moving anywhere.
      return;
    }
    const dist = Math.hypot(event.clientX - dragCandidate.startX, event.clientY - dragCandidate.startY);
    if (dragCandidate.button === 2 || dist > DRAG_THRESHOLD_PX) {
      beginDrag();
    } else {
      return;
    }
  }

  // Written straight into the simulation; the loop renders it next frame.
  sim.x = event.clientX - dragCandidate.grabOffsetX;
  sim.y = event.clientY - dragCandidate.grabOffsetY;
}

function onDragUp() {
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragUp);

  if (dragCandidate && dragCandidate.active) {
    suppressNextClick = true;
    dragging = false;
    sprite.classList.remove('is-dragging');
    window.pochi.dragEnd({ x: sim.x, y: sim.y });
    scheduleIdleRefresh();
  }

  dragCandidate = null;
}
