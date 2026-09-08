// Chapter 46 (v1 core): rule-based personality-stage read, plus a small
// escalation-offset nudge — both pure functions of what Chapters 41/42
// already wrote to memoryStore. No AI/API calls; the brief's own framing
// is that this is the deterministic foundation a future AI-companion
// module will eventually extend, not that module itself.
//
// Takes a memoryStore instance as a parameter rather than creating its
// own — main.js already owns one, and a second Store instance pointed at
// the same file would be redundant. This also keeps memoryStore.js
// itself completely untouched, per the brief's explicit instruction.
//
// Every export degrades to the "brand new install" default (stage 'new',
// zero offset) if memory throws or has no data yet — a fresh install
// must behave exactly as it did before this file existed, and a broken
// memory layer must never block a nag from firing.

const DAY_MS = 24 * 60 * 60 * 1000;
const FAMILIAR_AT_DAYS = 3;
const ESTABLISHED_AT_DAYS = 14;
const MIN_TOTAL_FOR_FAMILIAR = 5;

// "milestones count + days-since-first_launch" per the brief — total here
// is milestones + daily_summary entries, a proxy for "has real history
// accumulated" that stays low for a sparse/on-and-off install even if the
// calendar date has moved on regardless of activity.
function getStage(memory) {
  try {
    const firstLaunch = memory.getEntry('milestones:first_launch');
    const daysSince = firstLaunch ? (Date.now() - firstLaunch.createdAt) / DAY_MS : 0;

    const entries = memory.listEntries();
    const total = entries.filter((e) => e.category === 'milestones' || e.category === 'daily_summary').length;

    if (daysSince < FAMILIAR_AT_DAYS || total < MIN_TOTAL_FOR_FAMILIAR) return 'new';
    if (daysSince < ESTABLISHED_AT_DAYS) return 'familiar';
    return 'established';
  } catch (_) {
    return 'new';
  }
}

// Reads preferences:{type}_response (written by resolveNag()'s
// recordNagResponsePattern) and returns how many escalation steps to
// start ahead for that nag type. Bounded to +1 — "start one step higher,"
// not "jump straight to angry" — and only kicks in once there's a real,
// lopsided sample size, not from one or two data points.
const MIN_SAMPLES_FOR_OFFSET = 4;
const DELAYED_RATIO_FOR_OFFSET = 0.6; // 60%+ of resolutions needed escalation

function getEscalationOffset(memory, nagType) {
  try {
    const entry = memory.getEntry(`preferences:${nagType}_response`);
    if (!entry || !entry.value) return 0;
    const { quickCount = 0, delayedCount = 0 } = entry.value;
    const total = quickCount + delayedCount;
    if (total < MIN_SAMPLES_FOR_OFFSET) return 0;
    return (delayedCount / total) >= DELAYED_RATIO_FOR_OFFSET ? 1 : 0;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  getStage,
  getEscalationOffset,
  FAMILIAR_AT_DAYS,
  ESTABLISHED_AT_DAYS,
  MIN_TOTAL_FOR_FAMILIAR,
  MIN_SAMPLES_FOR_OFFSET,
  DELAYED_RATIO_FOR_OFFSET
};
