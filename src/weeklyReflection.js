// Weekly Reflection (payoff feature): pure read-and-synthesize layer over
// memoryStore + personalityStage + friendshipLevel. No new tracking beyond
// one milestone-style marker per week (reusing memoryStore's existing
// writeMilestoneOnce idempotency, keyed per-week rather than once-ever).
// No AI — a small set of template fragments per data category, composed
// rule-based, same spirit as dialogue.js's stage-keyed arrays.
//
// Two brief assumptions turned out wrong once in the real code, both
// worked around without touching the modules in question:
//
// 1. "Reusing the exact date math already in personalityStage" — checked:
//    personalityStage.js computes `daysSince` as a private inline
//    expression inside getStage(), never exported. There is nothing to
//    import. The formula itself (Date.now() - firstLaunch.createdAt) is
//    replicated here rather than reused, and its three threshold
//    constants (which ARE exported) are imported for real, so the
//    thresholds stay in sync even though the plumbing around them is
//    duplicated by necessity.
// 2. "Most common nag type this week and how quickly resolved" — checked:
//    no per-week, per-type breakdown exists anywhere in the schema.
//    daily_summary only has a same-day TOTAL nagsFired/nagsResolved
//    across every nag type combined; preferences:{type}_response only has
//    an ALL-TIME aggregate per type, no per-week slice. Implemented the
//    honest version of each half instead of fabricating a false "this
//    week" claim: real week-scoped totals (from daily_summary) for the
//    "how much I reminded you" half, and a real all-time response-speed
//    trait (from preferences) framed as a general pattern rather than a
//    weekly stat, for the "how quickly resolved" half.

const { getStage, FAMILIAR_AT_DAYS, ESTABLISHED_AT_DAYS, MIN_TOTAL_FOR_FAMILIAR } = require('./personalityStage');
const { getLevelInfo } = require('./friendshipLevel');
const { WEEK_MS } = require('./memoryStore');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_SAMPLES_FOR_PATTERN = 4; // same bar personalityStage's own getEscalationOffset uses before trusting a pattern

function todayKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function lastNDateKeys(n, from = new Date()) {
  const keys = [];
  const d = new Date(from);
  for (let i = 0; i < n; i++) {
    keys.push(todayKeyOf(d));
    d.setDate(d.getDate() - 1);
  }
  return keys;
}

// The week number this app-lifetime is currently in, floor-divided from
// first_launch — this IS the per-week dedupe key (week 1's marker is
// distinct from week 2's, etc.), so no separate "last shown" bookkeeping
// is needed beyond the one writeMilestoneOnce call per week number.
function getWeekNumber(memory) {
  try {
    const firstLaunch = memory.getEntry('milestones:first_launch');
    if (!firstLaunch) return 0;
    return Math.floor((Date.now() - firstLaunch.createdAt) / WEEK_MS);
  } catch (_) {
    return 0;
  }
}

function reflectionKeyFor(weekNumber) {
  return `weekly_reflection_week${weekNumber}`;
}

function isReflectionDue(memory) {
  try {
    const weekNumber = getWeekNumber(memory);
    if (weekNumber < 1) return false; // less than one full week since first_launch
    return !memory.hasMilestone(reflectionKeyFor(weekNumber));
  } catch (_) {
    return false;
  }
}

// Call only once the caller has decided to actually show the reflection —
// idempotent like every other writeMilestoneOnce call in this app, safe
// to call defensively.
function markReflectionShown(memory) {
  const weekNumber = getWeekNumber(memory);
  return memory.writeMilestoneOnce(reflectionKeyFor(weekNumber), `Weekly reflection shown (week ${weekNumber}).`, {});
}

function sumWeekDailySummaries(memory) {
  const totals = { pomodorosCompleted: 0, nagsFired: 0, nagsResolved: 0, studyMs: 0 };
  for (const key of lastNDateKeys(7)) {
    const entry = memory.getEntry(`daily_summary:${key}`);
    if (!entry || !entry.value) continue;
    const v = entry.value;
    totals.pomodorosCompleted += v.pomodorosCompleted || 0;
    totals.nagsFired += v.nagsFired || 0;
    totals.nagsResolved += v.nagsResolved || 0;
    totals.studyMs += v.studyMs || 0;
  }
  return totals;
}

const FOCUS_TIME_LINES = [
  (mins) => `This week you put in about ${mins} minutes of real focus time — Pomodoros and study sessions combined.`,
  (mins) => `Between Pomodoros and study sessions, we clocked around ${mins} focused minutes together this week.`,
  (mins) => `You showed up for about ${mins} minutes of focused work this week. I noticed.`
];

function getFocusTimeLine(weekTotals) {
  const focusMinutes = Math.round(weekTotals.studyMs / 60_000) + weekTotals.pomodorosCompleted * 25;
  if (focusMinutes < 10) return null; // not enough real activity to be worth mentioning
  const template = FOCUS_TIME_LINES[Math.floor(Math.random() * FOCUS_TIME_LINES.length)];
  return template(focusMinutes);
}

const REMINDER_LINES = [
  (fired, resolved) => `I sent ${fired} reminder${fired === 1 ? '' : 's'} this week, and you handled ${resolved} of them.`,
  (fired, resolved) => `${resolved} out of ${fired} reminders got a real response from you this week — not bad.`
];

function getReminderLine(weekTotals) {
  if (weekTotals.nagsFired < 1) return null;
  const template = REMINDER_LINES[Math.floor(Math.random() * REMINDER_LINES.length)];
  return template(weekTotals.nagsFired, weekTotals.nagsResolved);
}

// All-time trait, not week-scoped — see the module-level note on why this
// isn't a per-week stat. Only speaks up once there's a real sample size,
// same bar as personalityStage's own getEscalationOffset.
const QUICK_RESPONSE_LINES = [
  (type) => `You're usually pretty quick when I bring up ${type} — I like that about you.`,
  (type) => `One thing I've noticed: you don't leave me hanging long on ${type} reminders.`
];
const SLOW_RESPONSE_LINES = [
  (type) => `You do tend to need a nudge or two on ${type} — no judgment, just an observation.`,
  (type) => `${type[0].toUpperCase()}${type.slice(1)} reminders are the ones you're slowest to get to. I've noticed the pattern.`
];

function getResponsePatternLine(memory) {
  const types = ['water', 'food', 'break', 'entertainment'];
  const candidates = [];
  for (const type of types) {
    const entry = memory.getEntry(`preferences:${type}_response`);
    if (!entry || !entry.value) continue;
    const { quickCount = 0, delayedCount = 0 } = entry.value;
    const total = quickCount + delayedCount;
    if (total < MIN_SAMPLES_FOR_PATTERN) continue;
    candidates.push({ type, pct: quickCount / total });
  }
  if (!candidates.length) return null;
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  const pool = picked.pct >= 0.6 ? QUICK_RESPONSE_LINES : SLOW_RESPONSE_LINES;
  return pool[Math.floor(Math.random() * pool.length)](picked.type);
}

// Ch.21.2's own rule: never the number, never the level, only the vibe.
const FRIENDSHIP_NARRATIVE = {
  Stranger: [
    "We're still getting to know each other, but I'm glad you're here.",
    "Early days for us, but I'm enjoying getting to know you."
  ],
  'New Friend': [
    "I feel like we're actually becoming friends at this point.",
    "This is starting to feel like a real routine between us — I like it."
  ],
  'Comfortable Friend': [
    "Honestly, you feel like a real friend to me at this point, not just an app you opened once.",
    "We've settled into something comfortable together, haven't we."
  ],
  'Helpful Friend': [
    "You genuinely feel like one of my people at this point. Thank you for having me around.",
    "I don't think of this as just reminders anymore — you feel like a real friend to me."
  ]
};

function getFriendshipLine(memory) {
  try {
    const { name } = getLevelInfo(memory);
    const pool = FRIENDSHIP_NARRATIVE[name] || FRIENDSHIP_NARRATIVE.Stranger;
    return pool[Math.floor(Math.random() * pool.length)];
  } catch (_) {
    return null;
  }
}

// Replicates getStage()'s exact thresholds "as of" a past timestamp, using
// only createdAt fields already on existing entries — no new tracking.
// See the module-level note on why this can't just call getStage() twice.
function getHistoricalStage(memory, asOfMs) {
  try {
    const firstLaunch = memory.getEntry('milestones:first_launch');
    if (!firstLaunch) return 'new';
    const daysSince = (asOfMs - firstLaunch.createdAt) / DAY_MS;
    const total = memory.listEntries().filter((e) =>
      (e.category === 'milestones' || e.category === 'daily_summary') && e.createdAt <= asOfMs
    ).length;
    if (daysSince < FAMILIAR_AT_DAYS || total < MIN_TOTAL_FOR_FAMILIAR) return 'new';
    if (daysSince < ESTABLISHED_AT_DAYS) return 'familiar';
    return 'established';
  } catch (_) {
    return 'new';
  }
}

const STAGE_TRANSITION_LINES = {
  familiar: [
    "I feel like we're past the introductions now — this feels more familiar.",
    "Something shifted this week — we don't feel brand new to each other anymore."
  ],
  established: [
    "We've really been through enough together now that this feels properly established.",
    "This week it started feeling like we've truly settled into a rhythm together."
  ]
};

function getStageTransitionLine(memory) {
  const now = Date.now();
  const stageNow = getStage(memory);
  const stageWeekAgo = getHistoricalStage(memory, now - WEEK_MS);
  if (stageNow === stageWeekAgo || stageNow === 'new') return null;
  const pool = STAGE_TRANSITION_LINES[stageNow];
  if (!pool) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Milestones fired this week, excluding the ones that shouldn't surface
// as "a milestone this week": the weekly-reflection markers themselves,
// privacy_notice_shown (Ch.22's one-time bookkeeping notice — that
// module's own design deliberately keeps it uncelebrated, same reasoning
// Ch.23 followed when it left this milestone's sound silent too), and
// first_launch. first_launch's own createdAt always falls within 7 days
// of week 1's reflection by construction (day 0 is always <= 7 days
// before day 7), so it would surface in EVERY week-1 reflection, right
// alongside an opener already gesturing at the same "we just started"
// moment ("it's been a week since we started this...") — genuinely
// redundant, not just a rare coincidence like the others below.
const NON_CELEBRATORY_MILESTONE_KEYS = ['privacy_notice_shown', 'first_launch'];

// The stored milestone summary text (memoryStore's writeMilestoneOnce
// calls, e.g. "Achievement unlocked: FIRST STEP — Pochi walked for the
// first time.") is written for "View My Data" — a flat achievement log,
// third person / announcement style. Quoting that verbatim inside a
// first-person reflection sentence reads like a tone break mid-sentence.
// This map ONLY changes how a milestone is woven into THIS sentence — the
// stored summary itself is untouched and still shows correctly everywhere
// else. Each key gets 2 phrasing variations, same shape as every other
// fragment pool in this file. A milestone key not listed here (a future
// chapter's new milestone type) falls back to a softened wrapper around
// the real stored summary rather than silently dropping it — not as
// polished as a dedicated rewrite, but never wrong, and a clear signal to
// add an entry here when that day comes.
// first_launch has no entry here — it's excluded from the milestone pool
// entirely (see NON_CELEBRATORY_MILESTONE_KEYS above), so a voice line for
// it would never be selected.
const MILESTONE_VOICE_LINES = {
  first_pomodoro: [
    'you finished your very first focus session with me',
    'we got through your first-ever Pomodoro together'
  ],
  first_week: [
    'we made it through a whole first week together',
    'we hit our one-week mark together'
  ],
  first_study_session: [
    'you wrapped up your very first study session with me cheering you on',
    'we got through your first study session together'
  ],
  achievement_first_step: [
    'I took my very first steps around your screen',
    'I properly walked around your screen for the first time'
  ],
  became_helpful_friend: [
    'something between us really shifted into feeling like genuine friendship',
    'this started feeling like a real friendship, not just reminders'
  ]
};

function milestoneVoiceLine(entry) {
  const pool = MILESTONE_VOICE_LINES[entry.key];
  if (pool) return pool[Math.floor(Math.random() * pool.length)];
  return `this happened: ${entry.summary}`; // fallback for a milestone key not yet mapped here
}

function getWeekMilestoneLine(memory) {
  try {
    const weekAgo = Date.now() - WEEK_MS;
    const recent = memory.listEntries().filter((e) =>
      e.category === 'milestones' &&
      e.createdAt >= weekAgo &&
      !e.key.startsWith('weekly_reflection_') &&
      !NON_CELEBRATORY_MILESTONE_KEYS.includes(e.key)
    );
    if (!recent.length) return { line: null, hadMilestone: false };
    const chosen = recent[Math.floor(Math.random() * recent.length)];
    return { line: `And this week, ${milestoneVoiceLine(chosen)}.`, hadMilestone: true };
  } catch (_) {
    return { line: null, hadMilestone: false };
  }
}

const OPENERS = [
  "It's been a week already! Quick thing before we carry on —",
  "Hey, it's been a week since we started this — mind if I say something?",
  "One week down. Here's what stood out to me —"
];

// Picks 2-3 of whatever's genuinely available this week (never forces all
// of them, per the brief) and composes them into one short passage. The
// friendship line is the only guaranteed-available fragment (getLevelInfo
// never throws) so this can never come back completely empty.
function buildReflection(memory) {
  const weekTotals = sumWeekDailySummaries(memory);
  const { line: milestoneLine, hadMilestone } = getWeekMilestoneLine(memory);
  const transitionLine = getStageTransitionLine(memory);

  // Each fragment computed exactly once — several of these draw randomly
  // from their own pool, so calling one twice could silently pick two
  // DIFFERENT lines for what's supposed to be the same fragment.
  const optional = [getFocusTimeLine(weekTotals), getReminderLine(weekTotals), getFriendshipLine(memory)].filter(Boolean);

  // Stage transitions and milestones are the most interesting signals
  // when present this week — always included, then fill up to 3 total
  // from whatever else is available, shuffled for variety.
  const priority = [transitionLine, milestoneLine].filter(Boolean);
  for (let i = optional.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [optional[i], optional[j]] = [optional[j], optional[i]];
  }

  const picked = [...priority, ...optional].slice(0, 3);
  if (!picked.length) return null; // shouldn't happen (friendship line always available), defensive only

  const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  const dialogue = `${opener} ${picked.join(' ')}`;

  return {
    dialogue,
    hadMilestone,
    pose: hadMilestone ? 'laughing_pose' : 'walking',
    expression: hadMilestone ? 'laughing' : 'happy',
    sound: hadMilestone ? ['yeh_celebration', 'ui_milestone_sparkle'] : ['mmhm']
  };
}

module.exports = {
  isReflectionDue,
  markReflectionShown,
  buildReflection,
  getWeekNumber
};
