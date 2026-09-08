const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, dialog } = require('electron');
const si = require('systeminformation');
const store = require('./src/store');
const { pickLine } = require('./src/dialogue');
const { createAppAwareness } = require('./src/appAwareness');
const { createProductivityMode, formatPomodoroCountdown, LONG_CODING_SESSION_MS } = require('./src/productivityMode');
const { createMemoryStore } = require('./src/memoryStore');
const { getEscalationOffset } = require('./src/personalityStage');
const { createStudyMode } = require('./src/studyMode');
// Chapter 21: getGatedDialogueStage wraps personalityStage's getStage()
// with the friendship-level gate (see friendshipLevel.js) — every
// dialogue-stage call site below uses this instead of calling getStage()
// directly, per the brief's "merge the two systems" instruction.
// personalityStage.js itself is never imported into main.js anymore;
// friendshipLevel.js is the sole consumer of its getStage() export now.
const { getLevelInfo, getGatedDialogueStage } = require('./src/friendshipLevel');
// Chapter 22: Do Not Disturb state + the transparency-dashboard line
// generator. Both isolated in src/privacy.js — see that file for why the
// two live together despite being separate mechanisms.
const { createPrivacyMode, getTransparencyList } = require('./src/privacy');
// Chapter 23: audio decision layer — see src/audioPlayer.js for why
// playback itself lives in the renderer instead.
const { createAudioPlayer, SOUND_LEVELS } = require('./src/audioPlayer');
// Weekly Reflection (payoff feature): pure read-and-synthesize layer, see
// src/weeklyReflection.js's own header for the two brief assumptions that
// turned out wrong once checked against the real code.
const { isReflectionDue, markReflectionShown, buildReflection } = require('./src/weeklyReflection');
// First mini-game (Ch.24/25 slice): see src/miniGame.js's own header for
// why this module owns round timing but delegates every memoryStore/
// celebration decision back to main.js, mirroring studyMode.js's split.
const { createMiniGame, scoreLine } = require('./src/miniGame');

const SPRITE_SIZE = 144; // ~1.5in at 96dpi
const TICK_MS = 30_000; // decision loop cadence (brief: every ~30-60s)
// Gap between wander legs, timed from ARRIVAL rather than departure — a
// departure-timed gap meant faster walking silently produced longer
// standing-still periods, which reads as the app having frozen.
const WANDER_MIN_MS = 2_500;
const WANDER_MAX_MS = 6_000;
const CELEBRATE_MS = 4_000;
// Accumulated entertainment watch time before she says something.
const ENTERTAINMENT_NAG_MS = 45 * 60_000;
// Coding mode stretches the gap between wander legs rather than stopping
// her outright — a frozen sprite reads as a crashed app, a slow one reads
// as her leaving you alone.
const CODING_WANDER_MULTIPLIER = 2.5;

// Front/back walk-cycle art is parked (not at the quality bar side-view
// hit — see BUILD_BRIEF history) but the sprites/code stay in place as a
// fallback for the handful of spots that can't avoid verticality (the
// battery-nag walk to screen centre, a post-drag reposition landing near
// a screen edge). Normal open wandering is biased away from them instead:
// the renderer picks front/back the moment |dy| > |dx| (see
// updateViewSet() in renderer.js), so capping wander targets well under
// that — |dy| <= 0.7 * |dx| — keeps her on a side-view-coverable path
// with real margin, not a coin-flip at the exact boundary.
const SIDE_VIEW_SLOPE_CAP = 0.7;

let win = null;
let wanderTimeout = null;
let wanderPending = false;
let currentState = 'idle';
// Last position the renderer reported. The renderer owns her actual
// position frame to frame; main only needs to know where she came to rest
// so it can pick the next target on the right display.
let currentPos = { x: 200, y: 200 };
// True between dispatching a target and the renderer reporting it settled.
let awaitingArrival = false;
// What to switch to once the current leg completes, captured at departure.
let pendingArrival = null;

// Phase 4 awareness layer. Isolated on purpose: main.js only ever reads a
// snapshot off this, so it can be torn out without touching movement or
// the nag machine. If it fails to load, isCoding stays false and every
// behaviour below falls back to normal.
const awareness = createAppAwareness({
  onChange: (snap) => {
    if (!snap.available) return;
    const where = snap.raw ? `${snap.raw.name} — ${snap.raw.title}` : 'n/a';
    console.log(`[awareness] ${snap.category} (${where})`);
  }
});

// Chapter 41. Isolated the same way: main.js only ever reads a snapshot or
// calls start/stop/toggle, so a broken productivityMode.js degrades to
// "no Pomodoro, no support nudges" rather than crashing anything below.
const productivity = createProductivityMode({
  awareness,
  onPomodoroPhaseChange: (snap) => {
    console.log(`[pomodoro] ${snap.active ? snap.phase : 'stopped'}`);
    handlePomodoroPhaseChange(snap);
  }
});

// Chapter 42 (v1 core). Same isolation shape again: main.js only ever
// calls a handful of read/write methods, wrapped in try/catch at every
// call site, so a broken or hand-edited pochi-memory.json degrades to
// "nothing persists" rather than touching movement/nagging/productivity
// at all — those three must work identically with this file deleted.
const memory = createMemoryStore();

// Chapter 41 completion. Isolated the same way as everything else: main.js
// only ever calls a handful of start/end/snapshot methods, so a broken
// studyMode.js degrades to "no Study/Project mode" without touching
// Pomodoro, coding-mode, or memory at all.
const study = createStudyMode();

// Chapter 22. Same isolation shape again: main.js only ever calls
// isDoNotDisturb/toggleDoNotDisturb, so a bug here can't reach into
// movement/nagging/memory — worst case DND just doesn't toggle.
const privacy = createPrivacyMode();

// Chapter 23. Depends on store (for persistence) and privacy (so DND
// forces effective volume to 0) — both already exist above. Every other
// module here still only ever gets read via a handful of methods, so a
// bug in this file degrades to "no sound" rather than touching anything
// else.
const audio = createAudioPlayer({ store, privacy });

// First mini-game. canContinue() is re-read fresh by miniGame.js before
// every round transition (not just once at start) — this is what catches
// a mid-session interruption that doesn't call cancel() directly, like
// battery firing inside tick() and reassigning currentState away from
// 'playing_minigame'. handleMiniGameEnded is defined further down (this
// works via normal closure/hoisting, same as productivity's own
// onPomodoroPhaseChange reference above).
const miniGame = createMiniGame({
  sendUpdate,
  screen,
  spriteSize: SPRITE_SIZE,
  canContinue: () => !privacy.isDoNotDisturb() && currentState === 'playing_minigame',
  onEnded: (normalEnd, finalScore) => handleMiniGameEnded(normalEnd, finalScore)
});

let tray = null;
let memoryWin = null;
let projectPromptWin = null;
let aboutWin = null;

// Chapter 21: date key of the last day a level-1+ greeting was shown, so
// it fires at most once per calendar day. Not memoryStore-backed on
// purpose — this is a purely cosmetic, resettable-on-restart cue, not
// data worth persisting, same reasoning as Chapter 42's dailyDateKey
// pattern for the (also transient) daily-activity accumulator above.
let lastGreetingDateKey = null;

// Rough day-scoped accumulators, flushed into a memory entry at
// meaningful event boundaries (a nag firing/resolving, a Pomodoro
// completing) rather than on every 30s tick — daily_summary is meant to
// read as "one entry describing the day," not a write-per-tick log.
let dailyDateKey = todayKey();
let dailyActiveMsPending = 0;
let codingHabitPending = { morning: 0, afternoon: 0, evening: 0, night: 0 };
let codingHabitPendingCount = 0;
const HABIT_FLUSH_EVERY = 10; // ~5 minutes of coding-category ticks at TICK_MS=30s

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeBucketFor(hour) {
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  if (hour < 23) return 'evening';
  return 'night';
}

// Called once per tick() — cheap, in-memory only, no disk write. Tracks
// "was she seeing real foreground activity" as a rough proxy for active
// time, reusing appAwareness's existing category signal rather than any
// new detection.
function tickDailyActivity() {
  const key = todayKey();
  if (key !== dailyDateKey) {
    dailyDateKey = key;
    dailyActiveMsPending = 0; // any unflushed tail from the old day is lost — acceptable for "rough" active time
  }
  try {
    const cat = awareness.getSnapshot().category;
    if (cat && cat !== 'idle' && cat !== 'unknown') dailyActiveMsPending += TICK_MS;
  } catch (_) { /* memory/awareness being unavailable must not affect tick() itself */ }
}

function formatDailySummary(value) {
  const parts = [];
  if (value.pomodorosCompleted > 0) {
    parts.push(`${value.pomodorosCompleted} Pomodoro${value.pomodorosCompleted === 1 ? '' : 's'} completed`);
  }
  if (value.studyMs > 0) parts.push(`~${Math.round(value.studyMs / 60_000)} min studying`);
  parts.push(`${value.nagsFired} reminder${value.nagsFired === 1 ? '' : 's'} sent`);
  parts.push(`${value.nagsResolved} resolved`);
  if (value.activeMs > 0) parts.push(`~${Math.round(value.activeMs / 60_000)} min active`);
  if (value.gamesPlayed > 0) parts.push(`${value.gamesPlayed} mini-game${value.gamesPlayed === 1 ? '' : 's'} played (best catch: ${value.bestGameScore || 0})`);
  return parts.join(', ');
}

// The single write path for daily_summary — every caller passes deltas
// (e.g. { nagsFired: 1 }), this reads today's existing totals, adds the
// delta, folds in whatever active-time has accumulated since the last
// flush, and upserts. Upserting the SAME day-keyed id all day is what
// keeps this "one entry per day" even though it's touched many times.
function bumpDailySummary(patch) {
  try {
    const key = todayKey();
    const existing = memory.getEntry(`daily_summary:${key}`);
    const value = Object.assign(
      { pomodorosCompleted: 0, nagsFired: 0, nagsResolved: 0, activeMs: 0, studyMs: 0, gamesPlayed: 0, bestGameScore: 0 },
      existing ? existing.value : null
    );
    for (const [k, delta] of Object.entries(patch)) value[k] = (value[k] || 0) + delta;
    value.activeMs += dailyActiveMsPending;
    dailyActiveMsPending = 0;
    memory.upsertDailySummary(key, formatDailySummary(value), value);
  } catch (_) { /* memory is optional; must never break the nag/productivity flow calling this */ }
}

// Called once per tick() when category is 'coding'. Buffers samples
// in-memory and only writes every HABIT_FLUSH_EVERY samples — "habits...
// persist, but can be overwritten as patterns update" reads as periodic
// refinement, not a disk write on literally every 30s sample.
function tickCodingHabit() {
  try {
    if (awareness.getSnapshot().category !== 'coding') return;
  } catch (_) { return; }
  const bucket = timeBucketFor(new Date().getHours());
  codingHabitPending[bucket]++;
  codingHabitPendingCount++;
  if (codingHabitPendingCount >= HABIT_FLUSH_EVERY) flushCodingHabit();
}

function flushCodingHabit() {
  if (codingHabitPendingCount === 0) return;
  try {
    const existing = memory.getEntry('habits:coding_time');
    const value = Object.assign({ morning: 0, afternoon: 0, evening: 0, night: 0 }, existing ? existing.value : null);
    for (const b of ['morning', 'afternoon', 'evening', 'night']) value[b] += codingHabitPending[b];
    const peak = Object.entries(value).sort((a, b) => b[1] - a[1])[0][0];
    const total = value.morning + value.afternoon + value.evening + value.night;
    const summary = total > 0 ? `Tends to code in the ${peak}` : 'Not enough coding activity yet to see a pattern';
    memory.upsertHabit('coding_time', summary, value);
  } catch (_) { /* best-effort; a failed flush just means the pattern is slightly stale */ }
  codingHabitPending = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  codingHabitPendingCount = 0;
}

// Captures the escalation level BEFORE resolveNag() resets it — that
// number is the existing in-memory signal the brief points at ("reading
// existing counters that likely already exist"), just persisted as a
// rolling pattern instead of only living in-session.
//
// Threshold is <=1, not ===0: the counter is bumped to 1 at the MOMENT a
// nag first fires (see the nagDefs loop), before the user could possibly
// have resolved it yet — so by the time any nag is even visible to click,
// the stored value is already >=1. escalationAtResolve===1 means "this
// was resolved the first time it was ever shown," which is the genuinely
// quick case; ===0 could never happen via this call path at all (fixed
// alongside the matching off-by-one in the nagDefs loop above).
function recordNagResponsePattern(type, escalationAtResolve) {
  try {
    const key = `${type}_response`;
    const existing = memory.getEntry(`preferences:${key}`);
    const value = Object.assign({ quickCount: 0, delayedCount: 0 }, existing ? existing.value : null);
    if (escalationAtResolve <= 1) value.quickCount++; else value.delayedCount++;
    const total = value.quickCount + value.delayedCount;
    const pct = total > 0 ? value.quickCount / total : 0;
    const summary = pct >= 0.6
      ? `Usually responds to ${type} reminders quickly (${value.quickCount}/${total} times)`
      : `Often needs 2+ reminders for ${type} (${value.delayedCount}/${total} times)`;
    memory.upsertPreference(key, summary, value);
  } catch (_) { /* best-effort */ }
}

// Chapter 46: shared celebrate-then-revert dispatch, reusing the exact
// pose/dialogue display machinery every other celebration in this file
// already uses — no new render path. Extracted here specifically because
// the Pomodoro-completion celebration (below) now needs to choose between
// its normal line and a one-time milestone line, so the dispatch/timeout
// logic is worth sharing between that branch and the milestone triggers.
// isMilestone defaults true: every existing call site (first_launch,
// first_week, first_study_session) is genuinely a milestone every time
// it's ever called. Only the Pomodoro-break branch below is sometimes
// routine (not the first Pomodoro ever) and passes false explicitly.
function fireCelebration(pose, dialogue, isMilestone = true) {
  // Chapter 22: the single shared celebration dispatch is also the single
  // choke point every celebration in this app goes through (milestones,
  // Pomodoro-break completion) — guarding here covers all of them with one
  // line, rather than needing a DND check at every call site individually.
  if (privacy.isDoNotDisturb()) return;
  currentState = 'celebrating';
  pendingArrival = null;
  // Chapter 23: a genuine milestone gets the celebration voice + sparkle
  // together (brief item 2/3); a routine Pomodoro-break completion gets
  // just the completion chime instead — always fresh, never deduped,
  // since fireCelebration is itself already a discrete one-shot event.
  const sound = isMilestone ? ['yeh_celebration', 'ui_milestone_sparkle'] : ['ui_pomodoro_complete'];
  sendUpdate({ state: 'celebrating', pose, expression: 'laughing', dialogue, sound });
  setTimeout(() => {
    if (currentState !== 'celebrating') return; // something more important already took over
    currentState = 'idle';
    sendUpdate({ state: 'idle', pose: null, expression: 'happy', dialogue: null });
    scheduleWander();
  }, CELEBRATE_MS);
}

// Shown once each, exactly when writeMilestoneOnce() confirms a genuinely
// new write (it returns null on every subsequent call for the same key,
// which is what keeps these one-time rather than repeating).
const MILESTONE_REACTION_LINES = {
  first_launch: "Hi! I'm Pochi. Nice to meet you — let's get through today together.",
  first_pomodoro: "Your first focus session, done! Look at you go.",
  first_week: "A whole week together already. Thanks for having me around.",
  first_study_session: "Your first study session, done! I'm proud of you."
};

// Study/Project session start & end acknowledgments: shows a brief line
// (Ch.46 stage-aware, per the brief) for ANNOUNCE_MS, then resumes the
// wander loop, which will already route to the quiet-focus corner if
// isQuietFocus() is true by that point. Shorter than CELEBRATE_MS — this
// is a spoken aside, not an achievement moment (that's fireCelebration's
// job, used separately for the first-time milestones below).
const ANNOUNCE_MS = 2_500;

// Chapter 21, level 0->1 unlock: a brief happy-pose greeting on the first
// tick() of a new calendar day, once friendship level has reached 1+.
// Reuses existing assets only — pose 'walking' (her upright, energetic
// full-body pose) paired with expression 'happy' so the idle sprite-
// alternation in renderer.js actually shows the happy expression bust at
// least half the time; pose:null would fall through to the IDLE_STANDING
// fallback (arms_crossed) instead and never show 'happy' at all, the same
// rendering-pipeline gotcha documented back in Chapter 41's debug-support
// nudge. Purely visual per the brief's own description — no dialogue line.
const GREETING_MS = 2_500;

function triggerGreeting() {
  if (currentState === 'dragging') return;
  currentState = 'idle';
  pendingArrival = null;
  // Chapter 23: 'happy' expression -> oh.mp3 (the brief's "pick one
  // primary" call — wander()'s idle/roam 'happy' is dispatched every few
  // seconds and would make either clip a constant loop, so only this
  // once-a-day greeting gets one; mmhm.mp3 later found its own discrete
  // home in the weekly reflection's quiet-week case below).
  sendUpdate({ state: 'idle', pose: 'walking', expression: 'happy', dialogue: null, sound: ['oh'] });
  setTimeout(() => {
    if (currentState !== 'idle') return; // something else already took over during the pause
    clearTimeout(wanderTimeout);
    wanderPending = false;
    wander();
  }, GREETING_MS);
}

// Weekly Reflection: a longer, warmer moment than a normal nag/greeting
// bubble, so it gets its own (longer) display duration rather than
// reusing GREETING_MS/ANNOUNCE_MS/CELEBRATE_MS. Not routed through
// fireCelebration() — that function's sound is a fixed binary choice
// (milestone bucket or ui_pomodoro_complete), neither of which fits the
// "quiet week" case here (mmhm.mp3), and its DND guard is redundant here
// anyway since the only call site is inside tick(), which already can't
// reach this point while DND is active (see the priority-order comment
// above tick()).
const REFLECTION_MS = 8_000;

function triggerWeeklyReflection(reflection) {
  if (currentState === 'dragging') return;
  currentState = 'celebrating';
  pendingArrival = null;
  sendUpdate({
    state: 'celebrating',
    pose: reflection.pose,
    expression: reflection.expression,
    dialogue: reflection.dialogue,
    sound: reflection.sound
  });
  setTimeout(() => {
    if (currentState !== 'celebrating') return; // something more important already took over
    currentState = 'idle';
    sendUpdate({ state: 'idle', pose: null, expression: 'happy', dialogue: null });
    scheduleWander();
  }, REFLECTION_MS);
}

// Chapter 22.5-22.6 (simplified v1, per the brief): one combined, friendly
// first-launch notice, shown exactly once ever via the same
// writeMilestoneOnce() idempotency every other one-time moment in this app
// already uses (see MILESTONE_REACTION_LINES above) — no new "have I shown
// this" bookkeeping needed. Delivered as a short sequence of her normal
// speech-bubble lines rather than a native dialog box: the bubble is the
// only "voice" UI this app has, and a system dialog is explicitly what the
// brief says NOT to build here.
const PRIVACY_NOTICE_LINES = [
  'Oh — quick thing before we get going!',
  "I only check things like which app's open and its window title, so I know when you're coding, relaxing, or need a break.",
  "I can't see your screen, camera, mic, passwords, or files — and nothing I learn about you ever leaves this computer.",
  "That's it! Glad you're here."
];
const PRIVACY_NOTICE_LINE_MS = 4_200;

function triggerPrivacyNotice() {
  let i = 0;
  const showNext = () => {
    if (currentState === 'dragging') return; // user took control mid-sequence; stop talking over them
    currentState = 'idle';
    pendingArrival = null;
    sendUpdate({ state: 'idle', pose: null, expression: 'happy', dialogue: PRIVACY_NOTICE_LINES[i] });
    i++;
    if (i < PRIVACY_NOTICE_LINES.length) {
      setTimeout(showNext, PRIVACY_NOTICE_LINE_MS);
    } else {
      setTimeout(() => {
        if (currentState !== 'idle') return; // something else already took over during the pause
        clearTimeout(wanderTimeout);
        wanderPending = false;
        wander();
      }, PRIVACY_NOTICE_LINE_MS);
    }
  };
  showNext();
}

// Chapter 23: sound is optional and unused by most callers (study/project
// START, project END aren't "completion" moments per the brief) — only
// endStudySession()'s routine (non-first) branch passes one.
function announceSessionEvent(dialogue, sound = null) {
  if (currentState.startsWith('nagging_')) return; // a real nag keeps priority; the timer/memory write already happened regardless
  currentState = 'idle';
  pendingArrival = null;
  sendUpdate({ state: 'idle', pose: null, expression: 'happy', dialogue, sound });
  setTimeout(() => {
    if (currentState !== 'idle') return; // something else already took over during the pause
    clearTimeout(wanderTimeout);
    wanderPending = false;
    wander(); // isQuietFocus() reflects the new study/project state by now
  }, ANNOUNCE_MS);
}

// Chapter 22 (Ch.22.14): "Pochi is sleeping" — the one real new control.
// Highest priority in the whole decision loop, above even the battery nag,
// per Ch.22.12's "the user is always in charge" / "Pochi never fights
// control." DND_STATE is a currentState value distinct from every existing
// one (idle/walking/celebrating/nagging_*/sleeping/dragging), so none of
// the existing equality checks on currentState elsewhere in this file
// accidentally match it.
const DND_STATE = 'dnd';

// Consolidation pass: the six currentState values a real click can resolve
// (must match renderer.js's own RESOLVABLE array exactly — that one drives
// which click routes through window.pochi.resolveNag(), this one drives
// which states tick() must never silently overwrite; nagging_battery is
// deliberately excluded from both, since it isn't user-dismissable and
// battery is already the one thing allowed to interrupt these anyway).
const ACTIVE_NAG_STATES = [
  'nagging_water', 'nagging_food', 'nagging_break',
  'nagging_entertainment', 'nagging_debug_support', 'nagging_distraction'
];

// Walks her to a corner and settles into sleeping_pillow, reusing the exact
// target->pendingArrival->sendUpdate->settle plumbing every other
// destination-directed move in this file already uses — no new rendering
// path. Idempotent by design: safe to call every tick() while DND stays
// on, since it no-ops once she's already there or already headed there.
function parkForDoNotDisturb() {
  const alreadyParkedOrParking = currentState === DND_STATE ||
    (pendingArrival && pendingArrival.state === DND_STATE);
  if (alreadyParkedOrParking) return;

  clearTimeout(wanderTimeout);
  wanderPending = false;

  const area = workAreaFor(currentPos);
  const target = { x: area.x + 24, y: area.y + area.height - SPRITE_SIZE - 24 };
  currentState = 'walking';
  pendingArrival = { state: DND_STATE, pose: 'sleeping_pillow', expression: 'sleepy' };
  sendUpdate({ state: 'walking', target, gait: 'sleepy', pose: 'walking', expression: 'sleepy', dialogue: null });
}

// Chapter 23: the renderer owns actual playback and thus its own volume,
// but the SOURCE of "how loud" is main (DND state + the tray's sound
// level) — this is the one place that pushes the current effective
// number down, called once at startup and again whenever either input
// changes.
function pushAudioSettings() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('pochi:audio-settings', { volume: audio.getEffectiveVolume() });
}

function setSoundLevel(level) {
  audio.setLevel(level);
  refreshTrayMenu();
  pushAudioSettings();
}

function toggleDoNotDisturb() {
  const nowActive = privacy.toggleDoNotDisturb();
  refreshTrayMenu();
  pushAudioSettings();
  if (nowActive) {
    // Explicit, immediate cancel rather than relying solely on
    // miniGame.js's own defensive canContinue() poll — that only gets
    // rechecked at the next round transition (up to ~1.5s away), which
    // would otherwise leave her mid-game-round briefly on screen even
    // though DND just silenced everything else. cancel() is idempotent,
    // safe to call whether or not a game happens to be running.
    miniGame.cancel();
    if (currentState !== 'dragging') parkForDoNotDisturb();
  } else {
    // "On toggle-off: resume whatever normal behavior would otherwise be
    // happening, no special re-entry animation needed for v1" — same
    // idle-then-resume shape drag-end already uses below.
    if (currentState !== 'dragging') {
      currentState = 'idle';
      pendingArrival = null;
      scheduleWander();
      tick();
    }
  }
}

function getStudySnapshot() {
  try {
    return study.getStudySnapshot();
  } catch (_) {
    return { active: false, elapsedMs: 0 };
  }
}

function getProjectSnapshot() {
  try {
    return study.getProjectSnapshot();
  } catch (_) {
    return { active: false, label: '', elapsedMs: 0 };
  }
}

function formatElapsedShort(ms) {
  return `${Math.max(0, Math.round(ms / 60_000))}m`;
}

function truncateForMenu(label, max = 30) {
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
}

function toggleStudySession() {
  if (getStudySnapshot().active) {
    endStudySession();
    return;
  }
  study.startStudy();
  refreshTrayMenu();
  announceSessionEvent(pickLine('study_start', 'default', getGatedDialogueStage(memory)));
}

function endStudySession() {
  const elapsedMs = study.endStudy();
  if (elapsedMs === null) return; // nothing was active — tray menu shouldn't have offered this, but no-op safely regardless
  refreshTrayMenu();
  bumpDailySummary({ studyMs: elapsedMs });
  let wasFirst = false;
  try {
    wasFirst = !!memory.writeMilestoneOnce('first_study_session', 'Completed your first study session!', {});
  } catch (_) { /* best-effort */ }
  if (wasFirst) {
    // Same pattern as first_pomodoro: a full celebration for the
    // milestone, not just the lighter announcement a routine end gets.
    fireCelebration('laughing_pose', MILESTONE_REACTION_LINES.first_study_session);
    return;
  }
  announceSessionEvent(pickLine('study_end', 'default', getGatedDialogueStage(memory)), ['ui_pomodoro_complete']);
}

function startProjectSession(label) {
  const started = study.startProject(label);
  if (!started) return; // empty/whitespace label — the prompt window already required non-empty input, so this is just a safety net
  refreshTrayMenu();
  const line = pickLine('project_start', 'default', getGatedDialogueStage(memory)).replace('{label}', study.getProjectSnapshot().label);
  announceSessionEvent(line);
}

function endProjectSession() {
  const result = study.endProject(); // { elapsedMs, label } or null
  if (!result) return;
  refreshTrayMenu();
  const minutes = Math.max(1, Math.round(result.elapsedMs / 60_000));
  try {
    // recordEntry(), not one of the fixed upsert* helpers — project
    // sessions are repeatable per-session records (one entry per session,
    // keyed by timestamp), not upserted-in-place like preferences/habits.
    memory.recordEntry(
      'project_sessions',
      'low',
      String(Date.now()),
      `"${result.label}" — ${minutes} min`,
      { label: result.label, durationMs: result.elapsedMs }
    );
  } catch (_) { /* best-effort */ }
  const line = pickLine('project_end', 'default', getGatedDialogueStage(memory)).replace('{label}', result.label);
  announceSessionEvent(line);
}

// Tray entry point for the mini-game. Blocking conditions (DND, an active
// resolvable nag, already playing, mid-drag) are handled by graying out
// the tray item itself in buildTrayMenu() — a disabled menu item never
// fires this at all, which is a gentler "decline" than a spoken bubble
// would be: showing EVEN a "can't play right now" message would itself
// violate DND's "fully silent" contract, or clobber an active nag's own
// display, the exact thing the consolidation pass exists to prevent. The
// checks are repeated here too, defensively, matching every other tray
// action in this file.
function startMiniGame() {
  if (privacy.isDoNotDisturb()) return;
  if (ACTIVE_NAG_STATES.includes(currentState)) return;
  if (currentState === 'dragging') return;
  if (miniGame.isActive()) return;

  clearTimeout(wanderTimeout);
  wanderPending = false;
  pendingArrival = null;
  currentState = 'playing_minigame';
  miniGame.start();
}

// normalEnd=false (DND/battery/drag interrupted the session, or the tray
// item's own guards somehow let a blocked start through): stop silently,
// no bubble, no stats/milestone write — an abandoned few-seconds session
// isn't a fair "game played" data point, and announcing anything here
// would fight whatever just preempted it (matching the same reasoning
// fireCelebration's own DND guard already established tonight).
function handleMiniGameEnded(normalEnd, finalScore) {
  currentState = 'idle';
  if (!normalEnd) {
    scheduleWander();
    return;
  }

  bumpDailySummary({ gamesPlayed: 1 });
  try {
    // bestGameScore needs a MAX, not bumpDailySummary's additive-delta
    // model (that's built for counters, not high-water marks) — handled
    // here as one extra, explicit read-modify-write on the same entry
    // bumpDailySummary just touched, rather than teaching that shared
    // helper a second update semantic every other caller doesn't need.
    const key = todayKey();
    const existing = memory.getEntry(`daily_summary:${key}`);
    if (existing) {
      const value = existing.value;
      value.bestGameScore = Math.max(value.bestGameScore || 0, finalScore);
      memory.upsertDailySummary(key, formatDailySummary(value), value);
    }
  } catch (_) { /* best-effort */ }

  let isFirst = false;
  try {
    isFirst = !!memory.writeMilestoneOnce('first_minigame', 'Played your first mini-game with Pochi!', {});
  } catch (_) { /* best-effort */ }

  const line = scoreLine(finalScore);
  if (isFirst) {
    // Real score stays in the line either way — the milestone just adds
    // the celebration voice/sparkle/pose on top, same "first-time gets
    // the bigger treatment" pattern as every other milestone tonight.
    fireCelebration('laughing_pose', line, true);
  } else {
    announceSessionEvent(line);
  }
}

function getVirtualBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function createWindow() {
  const bounds = getVirtualBounds();

  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    // start roughly in the middle of the primary display
    const primary = screen.getPrimaryDisplay().workArea;
    currentPos = {
      x: primary.x + primary.width / 2 - SPRITE_SIZE / 2,
      y: primary.y + primary.height / 2 - SPRITE_SIZE / 2
    };
    sendUpdate({
      state: 'idle',
      pose: null,
      expression: 'happy',
      dialogue: null,
      place: { x: currentPos.x, y: currentPos.y }
    });
    pushAudioSettings();
    awareness.start();
    productivity.start();
    try {
      memory.runRetentionCleanup();
      const flEntry = memory.writeMilestoneOnce('first_launch', 'The first time Pochi was ever opened.', {});
      if (flEntry) fireCelebration('laughing_pose', MILESTONE_REACTION_LINES.first_launch);
      // Chapter 22: one-time privacy notice, gated the same idempotent way.
      // Delayed past the first_launch celebration (when both are new on the
      // same very-first run) so the two don't fight over the one bubble.
      const noticeEntry = memory.writeMilestoneOnce('privacy_notice_shown', 'Shown the one-time friendly privacy introduction.', {});
      if (noticeEntry) setTimeout(triggerPrivacyNotice, flEntry ? CELEBRATE_MS + 800 : 800);
    } catch (_) { /* memory is optional; startup must not depend on it */ }
    scheduleWander();
    setInterval(tick, TICK_MS);
    tick();
  });
}

// Chapter 42's entry point. A tray icon, not another sprite gesture — she
// already carries single-click (resolve-nag/debug-cycle), double-click
// (Pomodoro toggle), and right-click-drag (reposition); a 5th click
// pattern on the character for "open my stored data" would be both
// undiscoverable and easy to trigger by accident. The tray is also where
// this app's only quit path lives — the overlay window has no frame or
// close button, so there was previously no clean way to exit at all
// short of killing the process.
// Chapter 41 completion: the Study/Project items' labels need to reflect
// CURRENT state (Start vs. End, plus elapsed time) at the moment the menu
// is shown, not whatever they were at app startup — so the menu is built
// fresh on demand rather than once and cached, unlike a static menu.
function buildTrayMenu() {
  const studySnap = getStudySnapshot();
  const projectSnap = getProjectSnapshot();

  const studyLabel = studySnap.active
    ? `End Study Session (${formatElapsedShort(studySnap.elapsedMs)})`
    : 'Start Study Session';

  const projectLabel = projectSnap.active
    ? `End Project Session: ${truncateForMenu(projectSnap.label)} (${formatElapsedShort(projectSnap.elapsedMs)})`
    : 'Start Project Session…';

  const miniGameActive = miniGame.isActive();
  const miniGameLabel = miniGameActive ? `Playing… (Score: ${miniGame.getScore()})` : 'Play with Pochi';
  const canPlayMiniGame = !miniGameActive && !privacy.isDoNotDisturb() &&
    !ACTIVE_NAG_STATES.includes(currentState) && currentState !== 'dragging';

  return Menu.buildFromTemplate([
    { label: 'View My Data…', click: () => openMemoryWindow() },
    { type: 'separator' },
    {
      label: 'Pochi is Sleeping (Do Not Disturb)',
      type: 'checkbox',
      checked: privacy.isDoNotDisturb(),
      click: () => toggleDoNotDisturb()
    },
    {
      label: 'Sound',
      submenu: SOUND_LEVELS.map((level) => ({
        label: level.charAt(0).toUpperCase() + level.slice(1),
        type: 'radio',
        checked: audio.getLevel() === level,
        click: () => setSoundLevel(level)
      }))
    },
    { type: 'separator' },
    { label: studyLabel, click: () => toggleStudySession() },
    { label: projectLabel, click: () => (projectSnap.active ? endProjectSession() : openProjectPromptWindow()) },
    { type: 'separator' },
    // Disabled (rather than a spoken decline) while DND/an active nag/an
    // in-progress game/a drag blocks it — a greyed-out item is feedback
    // enough, and never risks clobbering an active nag's own display or
    // breaking DND's "fully silent" contract the way a bubble message
    // would. See startMiniGame()'s own comment for the fuller reasoning.
    { label: miniGameLabel, enabled: canPlayMiniGame, click: () => startMiniGame() },
    { type: 'separator' },
    { label: 'About Pochi…', click: () => openAboutWindow() },
    { label: 'Quit Pochi', click: () => app.quit() }
  ]);
}

// Keeps the OS-native right-click-shows-menu association (setContextMenu)
// pointed at a current menu too, for setups where that path does work —
// see the click-routing note below for why this app's own tray icon
// can't rely on it alone.
function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'icon_tray.png'));
  tray.setToolTip('Pochi');
  refreshTrayMenu();
  // Left-click shows the menu too, not just right-click. Live-tested:
  // Menu.buildFromTemplate() itself is correct (independently verified —
  // 3 items, right labels/types), but with this icon sitting in Windows'
  // notification-area overflow flyout, right-click never delivered a
  // 'right-click' event at all — not to setContextMenu()'s automatic
  // handling, not to an explicit tray.on('right-click', ...) fallback,
  // not even to a direct tray.popUpContextMenu() call, which accepted the
  // call and rendered nothing. Left-click was the one interaction that
  // consistently, reliably fired on this icon across every test. Rather
  // than keep fighting an OS-level right-click limitation for overflow
  // icons (dragging the icon out to the visible taskbar to sidestep it
  // wasn't available either — Windows refused the drop), both menu items
  // now live behind the click type that's actually proven to work.
  // Opening the memory window is one extra click instead of instant, but
  // it's no longer gated on a click type this icon can't reliably deliver.
  tray.on('click', () => tray.popUpContextMenu(buildTrayMenu()));
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu())); // free to keep — harmless if it does fire for other setups
}

function openProjectPromptWindow() {
  if (projectPromptWin && !projectPromptWin.isDestroyed()) {
    projectPromptWin.show();
    projectPromptWin.focus();
    return;
  }
  projectPromptWin = new BrowserWindow({
    width: 360,
    height: 150,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Start Project Session',
    webPreferences: {
      preload: path.join(__dirname, 'projectPromptPreload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  projectPromptWin.setMenuBarVisibility(false);
  projectPromptWin.loadFile(path.join(__dirname, 'renderer', 'projectPrompt.html'));
  projectPromptWin.on('closed', () => { projectPromptWin = null; });
}

function openMemoryWindow() {
  if (memoryWin && !memoryWin.isDestroyed()) {
    memoryWin.show();
    memoryWin.focus();
    return;
  }
  memoryWin = new BrowserWindow({
    width: 640,
    height: 720,
    title: 'Pochi — What I Remember',
    webPreferences: {
      preload: path.join(__dirname, 'memoryPreload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  memoryWin.setMenuBarVisibility(false);
  memoryWin.loadFile(path.join(__dirname, 'renderer', 'memory.html'));
  memoryWin.on('closed', () => { memoryWin = null; });
}

// About/Credits coda feature: same window-creation pattern as
// openMemoryWindow() above, minus a preload — this window is fully
// static (hardcoded content, no dynamic data, no IPC), so there is
// nothing for a preload/contextBridge to expose.
function openAboutWindow() {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.show();
    aboutWin.focus();
    return;
  }
  aboutWin = new BrowserWindow({
    width: 480,
    height: 620,
    title: 'About Pochi',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  aboutWin.setMenuBarVisibility(false);
  aboutWin.loadFile(path.join(__dirname, 'renderer', 'about.html'));
  aboutWin.on('closed', () => { aboutWin = null; });
}

function sendUpdate(payload) {
  // Any update without a target ends whatever leg was in flight, so the
  // arrival expectation is derived here rather than tracked by hand at
  // every call site.
  awaitingArrival = !!payload.target;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('pochi:state', payload);
}

// Single read point for the awareness layer, so a broken/absent module is
// handled in exactly one place.
function isCodingMode() {
  try {
    return awareness.getSnapshot().isCoding;
  } catch (_) {
    return false;
  }
}

// Same single-read-point pattern for the Chapter 41 module: every call
// site below goes through these three, so a broken productivityMode.js
// can never throw into tick()/wander() — it just reports "nothing due".
function getPomodoroSnapshot() {
  try {
    return productivity.getPomodoroSnapshot();
  } catch (_) {
    return { active: false, phase: null, remainingMs: 0 };
  }
}
function getCodingSessionSnapshot() {
  try {
    return productivity.getCodingSessionSnapshot();
  } catch (_) {
    return { codingMs: 0, shouldFireDebugSupport: false };
  }
}
function getDistractionSnapshot() {
  try {
    return productivity.getDistractionSnapshot();
  } catch (_) {
    return { switchCount: 0, shouldFireDistraction: false };
  }
}

// Pomodoro work and an active Study session count as the same "sit
// quietly" condition coding mode already gets — they all converge on
// identical corner+reading behaviour, so there is nothing to reconcile
// when more than one happens to be true at once. Project Mode is
// deliberately NOT included here — per the brief, it's plain labeled
// time-tracking with no visual behavior of its own; whatever she's doing
// (roaming, or parked because something else here is true) continues
// unaffected by a project session being active.
function isQuietFocus() {
  return isCodingMode() || getPomodoroSnapshot().phase === 'work' || getStudySnapshot().active;
}

function workAreaFor(pos) {
  const display = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y });
  return display.workArea;
}

// Varied paths — straight lines, zigzags, diagonal criss-crossing — but
// each leg individually kept horizontal-dominant enough that the renderer
// always renders it in side view. Tries a handful of random draws first
// (keeps the distribution natural rather than skewed toward one slope);
// if none land in the allowed band — most likely on a tall/narrow work
// area where a random y rarely qualifies — falls back to constructing a
// target that satisfies the cap directly, so this never has to retry
// forever or silently hand back a vertical leg.
function pickSideViewTarget(area) {
  const minX = area.x + 24;
  const maxX = area.x + area.width - SPRITE_SIZE - 24;
  const minY = area.y + 24;
  const maxY = area.y + area.height - SPRITE_SIZE - 24;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);

  for (let attempt = 0; attempt < 12; attempt++) {
    const x = minX + Math.random() * spanX;
    const y = minY + Math.random() * spanY;
    const dx = x - currentPos.x;
    const dy = y - currentPos.y;
    if (Math.abs(dx) > 4 && Math.abs(dy) <= SIDE_VIEW_SLOPE_CAP * Math.abs(dx)) {
      return { x, y };
    }
  }

  const x = minX + Math.random() * spanX;
  const dx = x - currentPos.x;
  const maxDy = Math.max(20, SIDE_VIEW_SLOPE_CAP * Math.abs(dx || spanX));
  const y = Math.min(maxY, Math.max(minY, currentPos.y + (Math.random() * 2 - 1) * maxDy));
  return { x, y };
}

function scheduleWander() {
  // Real bug found live-testing the mini-game past the first wander() fix:
  // wander()'s own guard only protects the moment it FIRES, not the moment
  // it's ARMED. Three independent callers reach this function without
  // checking currentState first — tick()'s self-heal (runs before the
  // mini-game guard further down tick()), pochi:settled's unconditional
  // last line, and the loop those two form together (each fired timer
  // resets wanderPending, which re-triggers tick()'s self-heal on the very
  // next tick). Every one of those re-arms produced a fresh timer whose
  // eventual fire time could land at the exact instant currentState had
  // only *momentarily* drifted off 'playing_minigame' — a pure race that
  // wander()'s fire-time guard alone couldn't close. Blocking the ARM here
  // instead means no wander timer exists at all while a session is
  // running, so there's nothing left to race. handleMiniGameEnded() is
  // unaffected: it flips currentState to 'idle' before calling this.
  if (currentState === 'playing_minigame') return;
  clearTimeout(wanderTimeout);
  wanderPending = true;
  const spread = WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS);
  const delay = spread * (isQuietFocus() ? CODING_WANDER_MULTIPLIER : 1);
  wanderTimeout = setTimeout(() => {
    wanderPending = false;
    wander();
  }, delay);
}

async function wander() {
  // Chapter 22: while Do Not Disturb is active, tick()'s early return is
  // what actually parks her (see parkForDoNotDisturb()) — this guard exists
  // for the OTHER paths that call wander() directly outside of tick():
  // handlePomodoroPhaseChange()'s work-phase branch, and the scheduleWander
  // timers armed before DND was switched on. Without it those would fight
  // the override and send her wandering again mid-DND.
  if (privacy.isDoNotDisturb()) return;

  // Mini-game bug found live-testing this chapter: ipcMain's 'pochi:settled'
  // handler unconditionally calls scheduleWander() whenever a walk leg
  // reaches its target, regardless of what currentState has become since
  // that leg departed. If a NORMAL wander leg was already in flight the
  // instant startMiniGame() ran, its eventual arrival (mid-session) would
  // arm a wander timer that — without this guard — fires later and
  // silently hijacks currentState back to 'walking', killing the session
  // with no announcement (miniGame.js's own canContinue() check correctly
  // notices the drift on its next round transition and aborts cleanly,
  // but the damage of interrupting the game is already done by then).
  // Same defensive shape as the DND guard just above.
  if (currentState === 'playing_minigame') return;

  // Nagging (water/food/break/battery) and celebrating hold her in place —
  // those are deliberate "stopped to make a point" moments. Late-night
  // sleepiness is not: she should still putter around, just slower and
  // sleepy-looking, rather than freezing wherever she happened to be.
  if (currentState === 'dragging') return; // user has manual control right now

  const sleepy = currentState === 'nagging_sleep' || currentState === 'sleeping';
  if (!sleepy && (currentState.startsWith('nagging_') || currentState === 'celebrating')) {
    scheduleWander();
    return;
  }

  const area = workAreaFor(currentPos);
  let target;
  let settlePose;
  let expression;
  let gait = 'normal';

  if (sleepy) {
    target = pickSideViewTarget(area);
    settlePose = 'sleeping_pillow';
    expression = currentState === 'sleeping' ? 'tired' : 'sleepy';
    gait = 'sleepy';
  } else {
    expression = 'happy';
    if (isQuietFocus()) {
      // Sit quietly in a corner instead of roaming across the editor —
      // coding mode and an active Pomodoro work phase both want this,
      // independently or together.
      target = {
        x: area.x + area.width - SPRITE_SIZE - 24,
        y: area.y + area.height - SPRITE_SIZE - 24
      };
      settlePose = 'reading';
    } else {
      target = pickSideViewTarget(area);
      settlePose = null;
    }
  }

  if (!sleepy) currentState = 'walking';
  // Captured now, applied when the renderer reports she got there. No
  // duration math and no arrival timeout: the leg ends when she actually
  // arrives, so two legs can't race to settle each other.
  pendingArrival = { state: sleepy ? currentState : 'idle', pose: settlePose, expression };

  // Chapter 21, achievement proof-of-concept: "FIRST STEP" — the first
  // time wander()'s walk logic actually dispatches a real target. Per the
  // brief this is trivially true on every install (fires within seconds
  // of the very first scheduleWander() call at startup) — it exists to
  // validate the achievement -> milestone write path works, not as a
  // meaningful gate. writeMilestoneOnce() is idempotent, so calling it on
  // every single wander leg forever is harmless; no separate "already
  // achieved" guard needed, same as first_week/became_helpful_friend above.
  // Chapter 23: sparkle only (no voice line, no visual takeover) — a full
  // fireCelebration() here would fight whatever this exact wander leg is
  // already doing, unlike the OTHER milestones which each own their own
  // dedicated moment. A light audio cue is the achievable middle ground
  // that still honors "milestone writes get the sparkle."
  let firstStepSound = null;
  try {
    const firstStepEntry = memory.writeMilestoneOnce('achievement_first_step', 'Achievement unlocked: FIRST STEP — Pochi walked for the first time.', {});
    if (firstStepEntry) firstStepSound = ['ui_milestone_sparkle'];
  } catch (_) { /* best-effort */ }

  sendUpdate({ state: currentState, target, gait, pose: 'walking', expression, dialogue: null, sound: firstStepSound });
}

function centerOfPrimaryDisplay() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width / 2 - SPRITE_SIZE / 2,
    y: area.y + area.height / 2 - SPRITE_SIZE / 2
  };
}

// Consolidation pass: the actual, current priority order of everything
// that can claim currentState, top to bottom, exactly as the code below
// evaluates it (see PRIORITY_AUDIT.md for the full collision-by-collision
// reasoning behind this ordering, including what was found accidental vs.
// deliberate). Keep this list in sync if the order below ever changes.
//
//  0. dragging               — real user manual control, always wins, checked first everywhere
//  1. Do Not Disturb         — explicit user action ("Pochi never fights control"), above even battery
//  2. battery-critical       — a real emergency; may interrupt an active nag (accepted, see audit)
//  3. an already-active, user-resolvable nag (water/food/break/entertainment/
//     debug-support/distraction) — HOLDS INDEFINITELY, untouched by anything
//     below, until resolveNag()/dismissSupportiveNudge() (a real click) or a
//     higher battery emergency claims it. This is the fix for the late-night
//     collision: previously nothing stopped late-night (or a different nag
//     type, or a celebration) from silently overwriting a nag the user
//     hadn't seen or clicked yet.
//  3b. an active mini-game session — same "holds indefinitely, only
//     battery/DND/a real click preempt it" treatment, checked right after
//     rule 3 (see src/miniGame.js's own header for the currentState split
//     this relies on)
//  4. late-night/sleep wind-down
//  5. first_week / weekly reflection / daily-greeting / became_helpful_friend
//     milestones (weekly reflection checked before the daily greeting,
//     per its own brief's "instead of, or before, normal greeting
//     behavior" — both inherit late-night/active-nag protection for free
//     just by being checked below rule 3 and rule 4)
//  6. water/food/break nags (fixed priority order among themselves)
//  7. entertainment nag
//  8. debug-support nag
//  9. distraction nag
// 10. Pomodoro countdown refresh (ambient, idle-only)
// 11. nothing due — settle to idle / wander
//
// Outside tick(): Pomodoro phase changes and study/project session
// announcements already independently check "is a nag currently showing"
// before displaying anything (pre-existing, confirmed correct); DND is
// also checked inside wander() and fireCelebration() directly, since those
// can be triggered from outside tick() too.
async function tick() {
  if (currentState === 'dragging') return; // user has manual control right now

  // Chapter 22: Do Not Disturb hard override — checked before anything
  // else in this loop, including battery, per the brief's explicit
  // priority ordering. Returns immediately, so no nag/celebration/wander
  // logic below this point ever runs while it's active.
  if (privacy.isDoNotDisturb()) {
    parkForDoNotDisturb();
    return;
  }

  // Self-heal: if nothing is walking and no wander is queued (a nag
  // interrupted a leg, say), restart the loop rather than going quiet.
  if (!wanderPending && !awaitingArrival) scheduleWander();

  // Chapter 42 bookkeeping — cheap, in-memory, runs every tick regardless
  // of what else fires below (these never return early).
  tickDailyActivity();
  tickCodingHabit();

  // Chapter 46: computed fresh every tick, not stored — cheap (a handful
  // of array entries at most) and it must never go stale mid-session.
  const stage = getGatedDialogueStage(memory);

  const data = store.store;
  const now = Date.now();

  // 1. Battery takes priority over everything else.
  let battery = null;
  try { battery = await si.battery(); } catch (_) { battery = null; }

  if (battery && typeof battery.percent === 'number' && battery.percent < 20 && !battery.acOnline) {
    const isFirstBatteryCrossing = !data.batteryLowSince;
    if (isFirstBatteryCrossing) {
      store.set('batteryLowSince', now);
      store.set('batteryIgnoredChecks', 0);
    } else {
      store.set('batteryIgnoredChecks', (data.batteryIgnoredChecks || 0) + 1);
    }
    const ignored = store.get('batteryIgnoredChecks');
    // Only counted on the first crossing into low-battery, not every 30s
    // re-dispatch while it stays low (a known pattern — see the battery/
    // Pomodoro priority conversation) — counting every repeat would wildly
    // inflate "reminders sent today" for one continuous emergency.
    if (isFirstBatteryCrossing) bumpDailySummary({ nagsFired: 1 });
    currentState = 'nagging_battery';
    pendingArrival = {
      state: 'nagging_battery',
      pose: 'charger',
      expression: ignored >= 2 ? 'angry' : 'worried'
    };
    // Chapter 23: 'first' plays the startled alarm exactly once per
    // low-battery episode; a later escalation into 'angry' plays once more
    // when it happens. The brief-mapped "worried, not first, not yet
    // angry" middle tick gets no sound at all — with ignored incrementing
    // every tick, that window is a single ~30s beat anyway.
    let batterySound = null;
    if (isFirstBatteryCrossing) batterySound = audio.pickIfNew('battery', 'first', ['eep']);
    else if (ignored >= 2) batterySound = audio.pickIfNew('battery', 'angry', ['hmph']);
    sendUpdate({
      state: 'nagging_battery',
      target: centerOfPrimaryDisplay(),
      gait: 'normal',
      pose: 'walking',
      expression: ignored >= 2 ? 'angry' : 'worried',
      dialogue: pickLine('battery', ignored >= 2 ? 'angry' : 'warn', stage),
      sound: batterySound
    });
    return;
  }
  store.set('batteryLowSince', null);
  store.set('batteryIgnoredChecks', 0);
  audio.resetCategory('battery'); // recovered above 20% — a future low crossing should alarm again

  // Consolidation pass fix: an already-active, user-resolvable nag holds
  // indefinitely from here on — nothing below this point (late-night,
  // milestones, a DIFFERENT nag type, the Pomodoro ambient refresh) may
  // silently replace it. Only battery-critical (above) and a real click
  // (resolveNag()/dismissSupportiveNudge(), which run outside tick() and
  // change currentState away from these values) can end it now. This is
  // the fix for the collision found testing Chapter 23: late-night used to
  // overwrite an in-progress water nag the instant the clock crossed into
  // its window, before the user ever got a chance to see or click it — the
  // same accident could happen with any nag type or the routine "nothing
  // due" idle-reset that used to run at the bottom of this function. See
  // PRIORITY_AUDIT.md for why battery is deliberately still allowed through.
  if (ACTIVE_NAG_STATES.includes(currentState)) return;

  // Mini-game: same treatment as the active-nag guard just above — while
  // a session is running, tick() does nothing else at all (no late-night,
  // no milestones, no nags) until it ends. miniGame.js paces the whole
  // session itself on its own much-faster timers; tick()'s only job here
  // is to get out of the way. Battery (already checked above this point)
  // and DND (checked at the very top of this function) still both
  // preempt it — miniGame.js's own canContinue() check notices the
  // currentState change on its very next round transition and stops
  // itself cleanly.
  if (currentState === 'playing_minigame') return;

  // 2. Late night wind-down.
  const nowDate = new Date(now);
  const hour = nowDate.getHours();
  const minute = nowDate.getMinutes();
  const isLateNight = (hour === 0 && minute >= 30) || (hour >= 1 && hour < 6);

  if (isLateNight) {
    if (!data.lateNightStart) store.set('lateNightStart', now);
    const minutesInto = (now - store.get('lateNightStart')) / 60000;
    currentState = minutesInto > 45 ? 'sleeping' : 'nagging_sleep';
    // Let an in-flight leg finish rather than cutting it short every 30s.
    if (awaitingArrival) return;
    // Chapter 23: deduped per currentState so the sigh plays once on entry
    // into sleepiness and once more on the deeper sleeping transition, not
    // every 30s resend for as long as late-night lasts.
    const sleepSound = audio.pickIfNew('sleep', currentState, ['exhausted_sigh']);
    if (currentState === 'sleeping') {
      sendUpdate({ state: 'sleeping', pose: 'sleeping_pillow', expression: 'tired', dialogue: pickLine('sleep', 'deep', stage), sound: sleepSound });
    } else {
      sendUpdate({ state: 'nagging_sleep', pose: 'sleeping_pillow', expression: 'sleepy', dialogue: pickLine('sleep', 'late', stage), sound: sleepSound });
    }
    return;
  }
  store.set('lateNightStart', null);
  audio.resetCategory('sleep'); // late-night window ended — a future night should sigh again

  // Ch.46 milestone-reactive moment for first_week — checked here, after
  // battery/late-night (a real emergency or wind-down still outranks a
  // celebration) but before routine nags, and returns immediately so
  // nothing later in this same tick() overwrites it before it's ever
  // visible (celebrating state set here would otherwise get clobbered
  // within the same synchronous pass the instant a nag below happened to
  // also be due).
  try {
    if (memory.isFirstWeekDue()) {
      const fwEntry = memory.writeMilestoneOnce('first_week', 'A full week of using Pochi — hope she has been good company.', {});
      if (fwEntry) {
        fireCelebration('laughing_pose', MILESTONE_REACTION_LINES.first_week);
        return;
      }
    }
  } catch (_) { /* best-effort */ }

  // Weekly Reflection: same priority slot as first_week above (after
  // battery/late-night/active-nag, so an emergency, wind-down, or a nag
  // the user hasn't seen yet still all outrank it) and checked BEFORE the
  // daily greeting below, per the brief's "instead of, or before, normal
  // greeting behavior." isReflectionDue()'s week-number-keyed milestone
  // is the entire dedupe mechanism — no separate "last shown" date key
  // needed, unlike the greeting below.
  try {
    if (isReflectionDue(memory)) {
      const reflection = buildReflection(memory);
      if (reflection) {
        const written = markReflectionShown(memory);
        if (written) {
          triggerWeeklyReflection(reflection);
          return;
        }
      }
    }
  } catch (_) { /* best-effort */ }

  // Chapter 21, level 0->1 unlock: once per calendar day, on the first
  // tick() that notices the date has changed, if friendship level is 1+.
  // Same priority slot as first_week above (after battery/late-night, so
  // a real emergency or wind-down still outranks it) and the same
  // "override + return" shape, so nothing later in this tick() pass can
  // immediately clobber it before it's ever visible.
  try {
    const today = todayKey();
    if (lastGreetingDateKey !== today && getLevelInfo(memory).level >= 1) {
      lastGreetingDateKey = today;
      triggerGreeting();
      return;
    }
  } catch (_) { /* best-effort */ }

  // Chapter 21, level 2->3: per the brief, this transition needs no new
  // behavior of its own beyond being visible in "View My Data" — a silent
  // milestone write, no celebration, no return (nothing was dispatched,
  // so the rest of tick() proceeds normally).
  try {
    if (getLevelInfo(memory).level >= 3) {
      memory.writeMilestoneOnce('became_helpful_friend', 'Became a Helpful Friend.', {});
    }
  } catch (_) { /* best-effort */ }

  // 3. Water / food / break nags, in priority order, each on its own clock.
  const codingMode = isCodingMode();
  const quietMultiplier = codingMode ? 1.6 : 1;

  const nagDefs = [
    { type: 'water', baseMs: 50 * 60_000, pose: 'water_bottle', atKey: 'lastWaterReminderAt', escKey: 'waterEscalation' },
    { type: 'food', baseMs: 150 * 60_000, pose: 'arms_crossed', atKey: 'lastFoodReminderAt', escKey: 'foodEscalation' },
    // baseMs shared with LONG_CODING_SESSION_MS (Ch.41 break-management
    // threshold) rather than its own literal — verified below that
    // quietMultiplier only stretches this to 144min during coding, never
    // fully suppresses it, so this nag doubles as break-management as-is.
    { type: 'break', baseMs: LONG_CODING_SESSION_MS, pose: 'arms_crossed', atKey: 'lastBreakReminderAt', escKey: 'breakEscalation' }
  ];

  for (const def of nagDefs) {
    const lastAt = data[def.atKey] || data.sessionStart;
    const esc = data[def.escKey] || 0;
    const interval = (def.baseMs * quietMultiplier) / (1 + 0.3 * esc);
    if (now - lastAt >= interval) {
      const newEsc = Math.min(esc + 1, 2);
      store.set(def.escKey, newEsc);
      store.set(def.atKey, now);
      // Fixed a pre-existing off-by-one: this used to pick the expression
      // from newEsc (the value being stored for NEXT time) rather than
      // esc (how many times it's already escalated as of THIS message),
      // which meant the very first nag of any cycle always opened on
      // newEsc=1 -> 'judging', skipping 'smug' entirely — it was dead
      // code. Fixing it was necessary for Ch.46's escalation-offset
      // feature to mean anything (there's nowhere to "start one step
      // higher" if the first message is already past the first step),
      // and it also fixes resolveNag()'s quick/delayed classification
      // below, which depended on the same counter.
      const offset = esc === 0 ? getEscalationOffset(memory, def.type) : 0;
      const effectiveEsc = Math.min(esc + offset, 2);
      const expr = effectiveEsc === 0 ? 'smug' : effectiveEsc === 1 ? 'judging' : 'angry';
      bumpDailySummary({ nagsFired: 1 });
      currentState = 'nagging_' + def.type;
      // Chapter 23: no dedup needed — this loop only ever fires on a real
      // interval-elapsed transition (store.set(atKey, now) above always
      // moves the clock forward), never a same-state resend.
      const voiceClip = expr === 'angry' ? 'hmph' : 'hmm';
      sendUpdate({
        state: currentState,
        pose: def.pose,
        expression: expr,
        dialogue: pickLine(def.type, expr, stage),
        sound: [voiceClip]
      });
      return;
    }
  }

  // 4. Long entertainment session. Sits below water/food/break so basic
  // needs win a tie; the accumulated clock keeps running until it fires, so
  // losing a tick here only delays it by one tick rather than dropping it.
  const snap = awareness.getSnapshot();
  if (snap.available && snap.entertainmentMs >= ENTERTAINMENT_NAG_MS) {
    const esc = data.entertainmentEscalation || 0;
    const newEsc = Math.min(esc + 1, 2);
    store.set('entertainmentEscalation', newEsc);
    store.set('lastEntertainmentReminderAt', now);
    awareness.resetEntertainmentSession();
    // Consolidation pass: the same esc/newEsc off-by-one already fixed in
    // the water/food/break loop above (see its comment) was still present
    // here — expr must read the escalation as of THIS message (esc), not
    // the value being stored for next time (newEsc), or the very first
    // entertainment nag ever shown always opens on 'judging', skipping
    // 'smug' entirely. No escalation-offset here (unlike water/food/break)
    // since entertainment was deliberately left unstaged by Ch.46.
    const expr = esc === 0 ? 'smug' : esc === 1 ? 'judging' : 'angry';
    bumpDailySummary({ nagsFired: 1 });
    currentState = 'nagging_entertainment';
    sendUpdate({
      state: currentState,
      pose: 'arms_crossed',
      expression: expr,
      dialogue: pickLine('entertainment', expr),
      sound: [expr === 'angry' ? 'hmph' : 'hmm']
    });
    return;
  }

  // 5. Long coding session with no break — one supportive check-in, not a
  // repeating nag (repeating "still struggling?" would read as needling,
  // not support). Paired with sleeping_pillow rather than pose:null: the
  // idle-render path falls back to IDLE_STANDING whenever pose is falsy,
  // which would have silently overridden the worried expression with the
  // arms_crossed idle sprite instead of showing it at all.
  const codingSession = getCodingSessionSnapshot();
  if (codingSession.shouldFireDebugSupport) {
    productivity.markDebugSupportFired();
    bumpDailySummary({ nagsFired: 1 });
    currentState = 'nagging_debug_support';
    sendUpdate({
      state: currentState,
      pose: 'sleeping_pillow',
      expression: 'worried',
      dialogue: pickLine('debugSupport', 'worried'),
      sound: ['aww']
    });
    return;
  }

  // 6. Distraction pattern: repeated coding<->entertainment bouncing.
  // Friendly tone only — this never escalates past 'smug', deliberately,
  // per the bible's "not punishment" instruction for this specific nudge.
  const distraction = getDistractionSnapshot();
  if (distraction.shouldFireDistraction) {
    productivity.markDistractionFired();
    bumpDailySummary({ nagsFired: 1 });
    currentState = 'nagging_distraction';
    sendUpdate({
      state: currentState,
      pose: 'arms_crossed',
      expression: 'smug',
      dialogue: pickLine('distraction', 'smug'),
      sound: ['hmm']
    });
    return;
  }

  // 7. Pomodoro countdown refresh — lowest priority, purely ambient. Only
  // while genuinely idle (never mid-stride, never over a nag), so it can
  // never clobber a walking target or interrupt something that matters
  // more. Updates whenever tick() runs (30s), but the displayed minute
  // value itself only changes once a minute, satisfying "not every
  // second" without needing a separate timer.
  const pomodoro = getPomodoroSnapshot();
  if (pomodoro.active && currentState === 'idle' && !awaitingArrival) {
    sendUpdate({
      state: 'idle',
      pose: isQuietFocus() ? 'reading' : null,
      expression: 'happy',
      dialogue: formatPomodoroCountdown(pomodoro)
    });
  }

  // 8. Nothing due — let the wander loop keep driving idle/walking.
  // Consolidation pass: the six user-resolvable nagging_ states in
  // ACTIVE_NAG_STATES never reach this point anymore (they return above,
  // near the battery check) — only nagging_battery can still land here
  // once it's no longer critical, which is correct: it isn't something a
  // click resolves, so once the emergency passes there's nothing left
  // "waiting" on it the way a water/food/break nag is.
  if (currentState.startsWith('nagging_') || currentState === 'sleeping') {
    if (awaitingArrival) return; // don't cut a leg short mid-stride
    currentState = 'idle';
    sendUpdate({ state: 'idle', pose: isQuietFocus() ? 'reading' : null, expression: 'happy', dialogue: null });
  }
}

const NAG_KEYS = {
  water: { esc: 'waterEscalation', at: 'lastWaterReminderAt' },
  food: { esc: 'foodEscalation', at: 'lastFoodReminderAt' },
  break: { esc: 'breakEscalation', at: 'lastBreakReminderAt' },
  entertainment: { esc: 'entertainmentEscalation', at: 'lastEntertainmentReminderAt' }
};

// debug_support and distraction are one-off supportive check-ins, not
// repeating/escalating nags like water/food/break — there is no store
// bookkeeping to do, just a direct dismissal. Also deliberately skips the
// celebrating/friendship-point treatment other nags get on resolve:
// celebrating over "you've been struggling with a bug for 90 minutes"
// reads as tonally wrong for what's meant to be a supportive moment.
function dismissSupportiveNudge() {
  bumpDailySummary({ nagsResolved: 1 });
  currentState = 'idle';
  sendUpdate({ state: 'idle', pose: isQuietFocus() ? 'reading' : null, expression: 'happy', dialogue: null, sound: ['ui_click_pop'] });
  scheduleWander();
}

function resolveNag(type) {
  if (type === 'debug_support' || type === 'distraction') {
    dismissSupportiveNudge();
    return;
  }
  const keys = NAG_KEYS[type];
  if (!keys) return;
  const now = Date.now();
  // Captured before the reset below — this is the "existing in-memory
  // counter" the Ch.42 brief points at: 0 means she asked once and got a
  // response, 1-2 means it took escalation. recordNagResponsePattern()
  // persists the aggregate pattern; the raw counter itself still resets
  // per-nag exactly as it always did (unrelated to Chapter 42).
  const escalationAtResolve = store.get(keys.esc) || 0;
  recordNagResponsePattern(type, escalationAtResolve);
  bumpDailySummary({ nagsResolved: 1 });
  store.set(keys.esc, 0);
  store.set(keys.at, now);
  // Acknowledging the watch-session nag also clears the accumulated clock,
  // so agreeing with her doesn't leave it primed to fire again immediately.
  if (type === 'entertainment') awareness.resetEntertainmentSession();
  store.set('friendship', (store.get('friendship') || 0) + 1);

  currentState = 'celebrating';
  sendUpdate({ state: 'celebrating', pose: 'laughing_pose', expression: 'laughing', dialogue: pickLine('resolved'), sound: ['ui_click_pop'] });

  setTimeout(() => {
    if (currentState !== 'celebrating') return;
    currentState = 'idle';
    sendUpdate({ state: 'idle', pose: null, expression: 'happy', dialogue: null });
    scheduleWander();
  }, CELEBRATE_MS);
}

// Reacts to Pomodoro start/stop/phase-advance. The countdown text itself
// is refreshed by tick() (step 7) on its normal 30s cadence — this only
// handles the two moments that need an immediate visual response rather
// than waiting for the next tick: a break starting (celebration burst)
// and a work phase starting or resuming (head to the corner right away
// instead of waiting up to ~15s for the next scheduled wander leg under
// the coding-mode wander-gap multiplier).
function handlePomodoroPhaseChange(snap) {
  if (currentState === 'dragging') return; // user has manual control right now

  if (!snap.active) {
    // Stopped. If she was parked for Pomodoro specifically — not also for
    // coding mode, which independently still wants the corner — let her
    // resume roaming immediately rather than waiting for the next leg.
    if (currentState === 'idle' && !isCodingMode()) {
      clearTimeout(wanderTimeout);
      wanderPending = false;
      wander();
    }
    return;
  }

  if (currentState.startsWith('nagging_')) return; // a real nag outranks a phase transition

  if (snap.phase === 'break') {
    // A work phase just completed — read-only integration with
    // productivityMode.js via the same onPomodoroPhaseChange callback
    // main.js already used before Chapter 42 existed, per the brief's
    // "wire-in points, don't modify their internals" instruction.
    bumpDailySummary({ pomodorosCompleted: 1 });
    let isFirstPomodoro = false;
    try {
      isFirstPomodoro = !!memory.writeMilestoneOnce('first_pomodoro', 'Completed your first Pomodoro focus session!', {});
    } catch (_) { /* best-effort */ }
    // Ch.46: the milestone line replaces the routine break_start line on
    // this one occasion rather than showing alongside it — only one
    // dialogue bubble can be visible at a time, and a first-ever moment
    // is worth prioritizing over the normal "break time" message.
    const dialogueLine = isFirstPomodoro ? MILESTONE_REACTION_LINES.first_pomodoro : pickLine('pomodoro', 'break_start');
    fireCelebration('dancing', dialogueLine, isFirstPomodoro);
  } else if (snap.phase === 'work') {
    clearTimeout(wanderTimeout);
    wanderPending = false;
    wander(); // isQuietFocus() now sees the work phase and routes to the corner
  }
}

ipcMain.on('pochi:toggle-pomodoro', () => {
  productivity.togglePomodoro();
});

ipcMain.on('pochi:project-prompt-submit', (_event, label) => {
  if (projectPromptWin && !projectPromptWin.isDestroyed()) projectPromptWin.close();
  startProjectSession(label);
});
ipcMain.on('pochi:project-prompt-cancel', () => {
  if (projectPromptWin && !projectPromptWin.isDestroyed()) projectPromptWin.close();
});

// Paired with ipcRenderer.sendSync on the preload side — event.returnValue
// must be set even though the renderer doesn't use it, or sendSync blocks
// forever waiting for a reply that never comes.
ipcMain.on('pochi:set-ignore-mouse', (event, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true });
  event.returnValue = null;
});

ipcMain.on('pochi:resolve-nag', (_event, type) => {
  resolveNag(type);
});

ipcMain.on('pochi:game-click', () => {
  miniGame.handleClick();
});

ipcMain.on('pochi:drag-start', () => {
  // Cancelled BEFORE setting currentState='dragging' below, not after —
  // cancel()'s onEnded callback sets currentState back to 'idle' as part
  // of its own cleanup, which would silently overwrite 'dragging' if this
  // ran in the other order. Idempotent, harmless if no game is active.
  miniGame.cancel();
  currentState = 'dragging';
  pendingArrival = null;
  awaitingArrival = false;
  clearTimeout(wanderTimeout);
  wanderPending = false;
});

ipcMain.on('pochi:drag-end', (_event, pos) => {
  if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
    currentPos = { x: pos.x, y: pos.y };
  }
  currentState = 'idle';
  scheduleWander();
  tick();
});

// The renderer owns her position and tells us where she came to rest —
// whether she reached the target or was stopped early by a state change.
ipcMain.on('pochi:settled', (_event, info) => {
  if (info && typeof info.x === 'number' && typeof info.y === 'number') {
    currentPos = { x: info.x, y: info.y };
  }
  awaitingArrival = false;

  if (!info || !info.reachedTarget) return;

  if (pendingArrival) {
    // Only settle into the leg's intended end state if nothing more
    // important claimed her mid-walk.
    const stillOurs = currentState === 'walking' ||
      currentState === 'nagging_sleep' ||
      currentState === 'sleeping' ||
      currentState === pendingArrival.state;
    if (stillOurs) {
      currentState = pendingArrival.state;
      sendUpdate({
        state: currentState,
        pose: pendingArrival.pose,
        expression: pendingArrival.expression,
        dialogue: null
      });
    }
    pendingArrival = null;
  }

  if (currentState !== 'dragging') scheduleWander();
});

ipcMain.handle('pochi:get-state', () => currentState);

// Memory window's IPC surface. Deliberately narrow — list/delete/export
// only, nothing that lets the renderer write arbitrary entries, since the
// only writers should be the read-only integration points below.
ipcMain.handle('pochi:memory-list', () => {
  try { return memory.listEntries(); } catch (_) { return []; }
});
// Chapter 22.15: read-only, built fresh from live module state on every
// call rather than cached — the memory window can be left open while
// awareness availability or stored-entry count changes underneath it.
ipcMain.handle('pochi:transparency-list', () => {
  try { return getTransparencyList({ awareness, memory }); } catch (_) { return ['Nothing is ever sent to the internet']; }
});
ipcMain.handle('pochi:memory-delete', (_event, id) => {
  try { return memory.deleteEntry(id); } catch (_) { return false; }
});
ipcMain.handle('pochi:memory-delete-all', () => {
  try { memory.deleteAll(); return true; } catch (_) { return false; }
});
ipcMain.handle('pochi:memory-export', async () => {
  try {
    const result = await dialog.showSaveDialog(memoryWin, {
      title: 'Export Pochi Memory',
      defaultPath: 'pochi-memory.txt',
      filters: [{ name: 'Text file', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    fs.writeFileSync(result.filePath, memory.exportToPlainText(), 'utf8');
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  app.quit();
});

// Flushes whatever's still buffered (a partial habit-flush window, any
// pending active-time) so a quit right before the next natural flush
// point doesn't lose that tail. Best-effort — "rough" active time and
// habit data was never meant to be exact.
app.on('before-quit', () => {
  try { flushCodingHabit(); } catch (_) {}
  try { bumpDailySummary({}); } catch (_) {}
});
