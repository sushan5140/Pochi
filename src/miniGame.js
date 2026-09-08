// First mini-game (Ch.24/25 slice): a simple catch/reaction game. Uses
// only existing sprites/sound/click machinery, no new rendering system.
//
// Isolated the same way as every other module tonight: main.js only ever
// calls start/handleClick/cancel/isActive/getScore, so a bug here
// degrades to "the game doesn't work" without touching movement/nagging/
// memory. Unlike studyMode.js (a passive timer main.js drives entirely),
// this module drives its OWN round timers independently of tick()'s 30s
// cadence — rounds last ~1-1.5s, far faster than tick() could ever pace.
// While a session is active, main.js's tick() simply gets out of the way
// entirely (the same treatment an active nag or DND already gets), and
// this module alone paces the whole 30s session.
//
// No memoryStore access here at all, on purpose — mirrors studyMode.js's
// own precedent exactly (that module doesn't touch memoryStore either;
// main.js's endStudySession() does all the writes after calling
// study.endStudy()). This module only reports back via onEnded(normalEnd,
// finalScore); main.js owns every daily_summary/milestone/celebration
// decision, reusing its own existing bumpDailySummary/writeMilestoneOnce/
// fireCelebration exactly like every other session type.
//
// currentState decoupling (read this before touching the state strings
// below): main.js's own currentState stays fixed at 'playing_minigame'
// for the WHOLE session — that's the only thing tick()/drag/DND-toggle
// need to know. The finer per-round labels sent via sendUpdate's `state`
// field ('minigame_round'/'minigame_miss'/'minigame_catch') exist purely
// for the renderer's click-routing (is THIS click a catch?) and are never
// mirrored back into main.js's currentState. Every other feature tonight
// keeps currentState and the dispatched state field equal by convention —
// this is the one deliberate exception, documented here since it isn't.

const SESSION_MS = 30_000;
const ROUND_MIN_MS = 1_000;
const ROUND_MAX_MS = 1_500;
const CATCH_PAUSE_MS = 700;
const MISS_PAUSE_MS = 500;

const SCORE_LINES = {
  zero: [
    () => "You caught me zero times! I'm a little too quick for you, huh?",
    () => "Zero catches — I win this round. Rematch sometime?"
  ],
  low: [
    (n) => `You caught me ${n} time${n === 1 ? '' : 's'}! Not bad for a start.`,
    (n) => `${n} catch${n === 1 ? '' : 'es'}! I'll give you that one.`
  ],
  mid: [
    (n) => `You caught me ${n} times! Pretty good reflexes.`,
    (n) => `${n} catches — okay, I'm actually impressed.`
  ],
  high: [
    (n) => `You caught me ${n} times?! Okay, you're genuinely fast.`,
    (n) => `${n} catches! I barely stood a chance out there.`
  ]
};

// Simple, fixed tiers — no difficulty scaling per the brief, this is just
// picking which reaction-line pool fits the final number.
function scoreLine(score) {
  let pool;
  if (score === 0) pool = SCORE_LINES.zero;
  else if (score <= 5) pool = SCORE_LINES.low;
  else if (score <= 12) pool = SCORE_LINES.mid;
  else pool = SCORE_LINES.high;
  const template = pool[Math.floor(Math.random() * pool.length)];
  return template(score);
}

// spriteSize passed in rather than duplicated as a literal — main.js
// already owns SPRITE_SIZE and doesn't export it; taking it as a
// dependency avoids two copies of the same number silently drifting.
function createMiniGame({ sendUpdate, screen, spriteSize, canContinue, onEnded }) {
  let active = false;
  let score = 0;
  let sessionEndAt = 0;
  let roundActive = false;
  let roundTimer = null;
  let pauseTimer = null;

  function randomPosition() {
    const area = screen.getPrimaryDisplay().workArea;
    const minX = area.x + 24;
    const maxX = area.x + area.width - spriteSize - 24;
    const minY = area.y + 24;
    const maxY = area.y + area.height - spriteSize - 24;
    return {
      x: minX + Math.random() * Math.max(1, maxX - minX),
      y: minY + Math.random() * Math.max(1, maxY - minY)
    };
  }

  function isActive() {
    return active;
  }

  function getScore() {
    return score;
  }

  function start() {
    if (active) return false;
    active = true;
    score = 0;
    sessionEndAt = Date.now() + SESSION_MS;
    playRound();
    return true;
  }

  function playRound() {
    if (!active) return;
    // Re-checked before EVERY round, not just at start() — this is what
    // catches a mid-session interruption that doesn't go through
    // cancel() directly (battery firing inside tick(), for instance,
    // reassigns main.js's currentState away from 'playing_minigame',
    // which canContinue() reads fresh each call).
    if (!canContinue()) {
      stop(false);
      return;
    }
    if (Date.now() >= sessionEndAt) {
      stop(true);
      return;
    }

    roundActive = true;
    const pos = randomPosition();
    const expression = Math.random() < 0.5 ? 'happy' : 'laughing';
    sendUpdate({ state: 'minigame_round', place: pos, pose: 'laughing_pose', expression, dialogue: null });
    const duration = ROUND_MIN_MS + Math.random() * (ROUND_MAX_MS - ROUND_MIN_MS);
    roundTimer = setTimeout(onRoundExpired, duration);
  }

  function onRoundExpired() {
    if (!active || !roundActive) return;
    roundActive = false;
    const expression = Math.random() < 0.5 ? 'judging' : 'smug';
    sendUpdate({ state: 'minigame_miss', pose: 'arms_crossed', expression, dialogue: null });
    pauseTimer = setTimeout(playRound, MISS_PAUSE_MS);
  }

  // Called from the renderer's click handler via IPC. Returns whether the
  // click actually counted, purely so callers/tests can assert on it —
  // main.js doesn't need the return value for anything.
  function handleClick() {
    if (!active || !roundActive) return false;
    roundActive = false;
    clearTimeout(roundTimer);
    score++;
    sendUpdate({ state: 'minigame_catch', pose: 'dancing', expression: 'laughing', dialogue: null, sound: ['yeh_celebration'] });
    pauseTimer = setTimeout(playRound, CATCH_PAUSE_MS);
    return true;
  }

  // normalEnd=true: the full 30s elapsed — a real, complete session.
  // normalEnd=false: cut short by DND/battery/dragging/anything else that
  // made canContinue() false, or an explicit cancel(). Stops silently —
  // no bubble (would fight whatever preempted it) and main.js's onEnded
  // callback is expected to skip stats/milestone writes for this case, so
  // an abandoned few-seconds session doesn't count as "a game played."
  function stop(normalEnd) {
    if (!active) return;
    active = false;
    roundActive = false;
    clearTimeout(roundTimer);
    clearTimeout(pauseTimer);
    roundTimer = null;
    pauseTimer = null;
    const finalScore = score;
    if (typeof onEnded === 'function') {
      try { onEnded(normalEnd, finalScore); } catch (_) { /* a broken callback must not leave timers dangling */ }
    }
  }

  // Idempotent — safe to call unconditionally from DND-toggle/drag-start
  // regardless of whether a game happens to be running.
  function cancel() {
    stop(false);
  }

  return { start, handleClick, cancel, isActive, getScore };
}

module.exports = { createMiniGame, scoreLine, SESSION_MS, ROUND_MIN_MS, ROUND_MAX_MS };
