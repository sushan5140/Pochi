// Chapter 41: Pomodoro focus cycles, a long-coding-session support nudge,
// distraction-switch detection, and the shared threshold break management
// hangs off. One module because all of these read the same underlying
// signal — "how long / how often has coding been happening" — and
// splitting them apart would mean re-deriving it three times.
//
// Reads awareness.getSnapshot() (Phase 4, untouched) on its own poll timer
// and never reaches into appAwareness.js internals, per the brief's
// explicit "do not touch that module" instruction.
//
// Every public method is safe to call even if this module is broken or
// awareness is unavailable — main.js's single read-point wraps these in
// try/catch anyway (same pattern as isCodingMode()), but the defaults
// here are chosen so a thrown poll() never corrupts state history.

const POLL_MS = 5_000;

const WORK_MS = 25 * 60_000;
const BREAK_MS = 5 * 60_000;

// appAwareness reports `sustainedMs` as time since the category last
// CHANGED, with no grace period for 'coding' (only 'entertainment' gets
// one, via a separate mechanism entirely outside categorySince). Measured
// directly in Phase 4: a single YouTube sitting bounced to "New Tab" and
// back 3 times in 40 seconds. If brief app-focus flicker is that common,
// a literal unbroken-in-`coding` streak would rarely if ever reach 90
// minutes. This accumulates coding time the same way appAwareness
// accumulates entertainment time — a brief glance elsewhere doesn't reset
// the clock, only a sustained absence does.
const CODING_SESSION_GRACE_MS = 3 * 60_000;

// Shared by the debug-support nudge (#2) and the existing break nagDef's
// interval in main.js (#4) — the brief explicitly suggests reusing one
// constant for both rather than two numbers that can drift apart.
const LONG_CODING_SESSION_MS = 90 * 60_000;

// Distraction pattern: N coding<->entertainment transitions (either
// direction counts) within a window reads as bouncing, not one glance away.
const DISTRACTION_WINDOW_MS = 10 * 60_000;
const DISTRACTION_SWITCH_THRESHOLD = 3;

function createProductivityMode(options = {}) {
  const awareness = options.awareness || null;
  const onPomodoroPhaseChange = typeof options.onPomodoroPhaseChange === 'function'
    ? options.onPomodoroPhaseChange
    : () => {};

  // ---- Pomodoro ----
  let pomodoroActive = false;
  let pomodoroPhase = null; // 'work' | 'break'
  let pomodoroPhaseEndsAt = 0;
  let pomodoroTimer = null;

  function armPomodoroTimer(durationMs) {
    clearTimeout(pomodoroTimer);
    pomodoroTimer = setTimeout(advancePomodoroPhase, durationMs);
    if (pomodoroTimer.unref) pomodoroTimer.unref();
  }

  function advancePomodoroPhase() {
    pomodoroPhase = pomodoroPhase === 'work' ? 'break' : 'work';
    const duration = pomodoroPhase === 'work' ? WORK_MS : BREAK_MS;
    pomodoroPhaseEndsAt = Date.now() + duration;
    armPomodoroTimer(duration);
    notifyPomodoro();
  }

  function notifyPomodoro() {
    try { onPomodoroPhaseChange(getPomodoroSnapshot()); } catch (_) { /* a listener fault must not break the timer */ }
  }

  function getPomodoroSnapshot() {
    return {
      active: pomodoroActive,
      phase: pomodoroPhase,
      remainingMs: pomodoroActive ? Math.max(0, pomodoroPhaseEndsAt - Date.now()) : 0
    };
  }

  function startPomodoro() {
    if (pomodoroActive) return;
    pomodoroActive = true;
    pomodoroPhase = 'work';
    pomodoroPhaseEndsAt = Date.now() + WORK_MS;
    armPomodoroTimer(WORK_MS);
    notifyPomodoro();
  }

  function stopPomodoro() {
    if (!pomodoroActive) return;
    pomodoroActive = false;
    pomodoroPhase = null;
    clearTimeout(pomodoroTimer);
    pomodoroTimer = null;
    notifyPomodoro();
  }

  function togglePomodoro() {
    if (pomodoroActive) stopPomodoro(); else startPomodoro();
  }

  // ---- Coding-session accumulator (feeds the debug-support nudge) ----
  let codingMs = 0;
  let codingAwaySince = null;
  let debugSupportFired = false; // one-shot per continuous session, not a repeating nag
  let lastPollAt = null;

  // ---- Distraction-switch detector ----
  let switchTimestamps = [];
  let lastCategoryForDistraction = null;
  let distractionArmed = true; // false right after firing, until the burst cools off

  let pollTimer = null;

  function poll() {
    if (!awareness) return;
    let snap;
    try {
      snap = awareness.getSnapshot();
    } catch (_) {
      return;
    }
    if (!snap || !snap.available) return;

    const now = Date.now();
    const elapsed = lastPollAt === null ? 0 : Math.max(0, now - lastPollAt);
    lastPollAt = now;

    // Coding accumulation, same shape as appAwareness's own entertainment
    // accrual: only the grace-elapsed reset clears it, a brief switch away
    // just pauses the credit.
    if (snap.category === 'coding') {
      if (codingAwaySince === null) codingMs += elapsed;
      codingAwaySince = null;
    } else if (codingMs > 0) {
      if (codingAwaySince === null) {
        codingAwaySince = now;
      } else if (now - codingAwaySince >= CODING_SESSION_GRACE_MS) {
        codingMs = 0;
        codingAwaySince = null;
        debugSupportFired = false; // a genuine break happened; a future long session can nudge again
      }
    }

    // Distraction round-trip counting: a transition directly between
    // 'coding' and 'entertainment' (either direction) counts as one switch.
    if (lastCategoryForDistraction !== null && snap.category !== lastCategoryForDistraction) {
      const isCodingEntPair =
        (lastCategoryForDistraction === 'coding' && snap.category === 'entertainment') ||
        (lastCategoryForDistraction === 'entertainment' && snap.category === 'coding');
      if (isCodingEntPair) switchTimestamps.push(now);
    }
    lastCategoryForDistraction = snap.category;
    switchTimestamps = switchTimestamps.filter((t) => now - t <= DISTRACTION_WINDOW_MS);
    if (switchTimestamps.length < DISTRACTION_SWITCH_THRESHOLD) {
      distractionArmed = true; // burst has cooled off; a future one can fire again
    }
  }

  return {
    start() {
      if (pollTimer) return;
      poll();
      pollTimer = setInterval(poll, POLL_MS);
      if (pollTimer.unref) pollTimer.unref();
    },
    stop() {
      clearInterval(pollTimer);
      pollTimer = null;
      clearTimeout(pomodoroTimer);
      pomodoroTimer = null;
    },

    startPomodoro,
    stopPomodoro,
    togglePomodoro,
    getPomodoroSnapshot,

    getCodingSessionSnapshot() {
      return {
        codingMs,
        shouldFireDebugSupport: codingMs >= LONG_CODING_SESSION_MS && !debugSupportFired
      };
    },
    markDebugSupportFired() { debugSupportFired = true; },

    getDistractionSnapshot() {
      return {
        switchCount: switchTimestamps.length,
        shouldFireDistraction: switchTimestamps.length >= DISTRACTION_SWITCH_THRESHOLD && distractionArmed
      };
    },
    markDistractionFired() { distractionArmed = false; }
  };
}

function formatPomodoroCountdown(snap) {
  const mins = Math.max(1, Math.ceil(snap.remainingMs / 60_000));
  return snap.phase === 'work' ? `Focus: ${mins} min left` : `Break: ${mins} min left`;
}

module.exports = {
  createProductivityMode,
  formatPomodoroCountdown,
  WORK_MS,
  BREAK_MS,
  LONG_CODING_SESSION_MS,
  CODING_SESSION_GRACE_MS,
  DISTRACTION_WINDOW_MS,
  DISTRACTION_SWITCH_THRESHOLD
};
