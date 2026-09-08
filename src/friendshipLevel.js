// Chapter 21 (v1 core): hidden friendship score + the first 4 bible
// levels' worth of behavior unlocks. Per Ch.21.2, this must stay hidden —
// no raw number/meter is ever shown to the user; only getLevelInfo().level
// feeds existing systems (dialogue-stage gating, a greeting trigger, one
// milestone write), never a UI surface of its own.
//
// Pure read/compute over memoryStore + personalityStage, exactly like
// personalityStage's own getStage() — nothing new is stored for the score
// itself. Degrades to level 0 (today's current behavior) if memory throws
// or has no data, same contract as every other module tonight.

const { getStage } = require('./personalityStage');

// ---- Score weights ------------------------------------------------------
// Deliberately simple, per the brief ("doesn't need to be sophisticated,
// just monotonically increasing with real engagement").
//
// Real caveat, found while implementing this against the actual schema:
// this is monotonic within any rolling ~30-day window, not forever.
// daily_summary entries are 'low' importance and auto-expire after
// RETENTION_MS (Ch.42, untouched) — daysActive/nagsResolved/pomodoros/
// studyMinutes are all summed FROM those entries, so a user who was very
// active 40+ days ago and has since gone quiet could see their score (and
// in principle their level) drift down as those old entries age out.
// milestones are 'high' importance and never expire, so they act as a
// permanent floor, but a level reached mostly through daily_summary-
// sourced activity isn't literally locked in forever. True permanent
// monotonicity would need new cumulative-total storage, which conflicts
// with this module's explicit "store nothing new, compute on read"
// contract — flagged rather than silently assumed away. In practice this
// needs a specific, fairly extreme usage pattern (cross a level almost
// entirely via daily activity, then ~30 days of total inactivity) to be
// observable at all.
const WEIGHT_MILESTONE = 15;
const WEIGHT_DAY_ACTIVE = 5;
const WEIGHT_NAG_RESOLVED = 2;
const WEIGHT_POMODORO_COMPLETED = 5;
const WEIGHT_STUDY_MINUTE = 0.5;

// ---- Level thresholds ----------------------------------------------------
// Ch.21.3's own level descriptions are qualitative, not numeric — these
// cutoffs are a reasonable, documented starting point, easy to retune:
//   0 Stranger             score 0   — a brand-new install stays here:
//                                      first_launch alone is 15 points,
//                                      under the level-1 cutoff.
//   1 New Friend            score 20  — reached after a little real use
//                                      beyond the initial launch (e.g.
//                                      one day of any activity at all).
//   2 Comfortable Friend    score 60  — a handful of days plus some real
//                                      interaction (nags resolved, a
//                                      Pomodoro or two).
//   3 Helpful Friend        score 150 — roughly a week+ of engaged,
//                                      regular use — same rough order of
//                                      magnitude as personalityStage's own
//                                      ESTABLISHED_AT_DAYS=14, intentionally,
//                                      since level 2 gates 'established'
//                                      dialogue too (see below).
// Levels 4-8 are explicitly out of scope for this pass.
const LEVELS = [
  { level: 0, name: 'Stranger', minScore: 0 },
  { level: 1, name: 'New Friend', minScore: 20 },
  { level: 2, name: 'Comfortable Friend', minScore: 60 },
  { level: 3, name: 'Helpful Friend', minScore: 150 }
];

// Brief says the score should use "days active (from personalityStage's
// existing day-tracking)" — checked against the real code, this doesn't
// exist. personalityStage.getStage() computes daysSince from
// milestones:first_launch's createdAt, which is CONTINUOUS CALENDAR TIME
// since install, not a count of days the user actually engaged (an
// install opened once and left running 60 days ago would show
// daysSince=60 off one day of real use). The signal that actually means
// "days active" already exists in memoryStore instead: a daily_summary
// entry is only created/upserted on a day something real happened (see
// bumpDailySummary()'s call sites in main.js — a nag firing or resolving,
// a Pomodoro or study session completing), so counting daily_summary
// entries is the correct proxy. Used directly here rather than routed
// through personalityStage, which has no such export and isn't modified
// to add one just for this (per the brief's own "don't touch
// personalityStage internals").
function getFriendshipScore(memory) {
  try {
    const entries = memory.listEntries();

    const milestoneCount = entries.filter((e) => e.category === 'milestones').length;
    const dailySummaries = entries.filter((e) => e.category === 'daily_summary');
    const daysActive = dailySummaries.length;

    // Brief also names "Pomodoro/study sessions completed" as an input.
    // Pomodoro has a real per-day count (pomodorosCompleted). Study does
    // not — only cumulative time (studyMs) is tracked anywhere in the
    // existing schema, there is no session-count field to sum. Using
    // total study minutes instead of a session count: still a genuine,
    // monotonically-accumulating engagement signal, and doesn't require
    // adding a new counter to main.js's daily-summary shape (which would
    // reach outside this module's read-only-consumer role).
    let nagsResolved = 0;
    let pomodorosCompleted = 0;
    let studyMinutes = 0;
    for (const e of dailySummaries) {
      const v = e.value || {};
      nagsResolved += v.nagsResolved || 0;
      pomodorosCompleted += v.pomodorosCompleted || 0;
      studyMinutes += (v.studyMs || 0) / 60_000;
    }

    return Math.round(
      milestoneCount * WEIGHT_MILESTONE +
      daysActive * WEIGHT_DAY_ACTIVE +
      nagsResolved * WEIGHT_NAG_RESOLVED +
      pomodorosCompleted * WEIGHT_POMODORO_COMPLETED +
      studyMinutes * WEIGHT_STUDY_MINUTE
    );
  } catch (_) {
    return 0;
  }
}

function getLevelInfo(memory) {
  const score = getFriendshipScore(memory);
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (score >= LEVELS[i].minScore) return { level: LEVELS[i].level, name: LEVELS[i].name, score };
  }
  return { level: LEVELS[0].level, name: LEVELS[0].name, score };
}

// Ch.46 dialogue stages, gated by friendship level per this brief's
// section 3 (level 1->2 transition): familiar/established require BOTH
// personalityStage's existing time-based criteria AND friendship level
// 2+, so the two systems reinforce each other instead of running as two
// parallel tracks the user has no way to tell apart. personalityStage.js
// itself is untouched — this wraps its output, never alters it, and
// degrades to its plain time-based stage if friendshipLevel's own read
// fails for any reason (getLevelInfo already defaults to level 0 via
// getFriendshipScore's try/catch, so "level < 2" is the safe fallback).
function getGatedDialogueStage(memory) {
  const timeBasedStage = getStage(memory);
  if (timeBasedStage === 'new') return 'new'; // already the floor, nothing to gate
  const level = getLevelInfo(memory).level;
  return level >= 2 ? timeBasedStage : 'new';
}

module.exports = {
  getFriendshipScore,
  getLevelInfo,
  getGatedDialogueStage,
  LEVELS,
  WEIGHT_MILESTONE,
  WEIGHT_DAY_ACTIVE,
  WEIGHT_NAG_RESOLVED,
  WEIGHT_POMODORO_COMPLETED,
  WEIGHT_STUDY_MINUTE
};
