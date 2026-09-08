// Chapter 42 (v1 core): local-first persistence for the four practical
// memory categories the brief scopes in — preferences, habits,
// daily_summary, milestones. No AI evolution, no room visual, no
// emotional-moment memory — this is purely the storage/tier/control layer
// those later phases will eventually read from.
//
// Storage choice: a second electron-store (JSON) instance, not SQLite.
// electron-store is already a proven dependency in this project; adding
// something like better-sqlite3 would mean a new native module, and this
// project has already been burned once by a native binding (active-win)
// needing real verification before it could be trusted. Nothing in this
// schema needs relational queries — a flat array of tagged entries is a
// complete fit, and the schema section's spec of "four categories with an
// importance field" doesn't ask for anything a JSON array can't do.
//
// Entries are a flat array, not a keyed object — ids like
// "daily_summary:2026-07-28" contain a colon, and electron-store's
// dot-notation get/set paths use "." as a path separator, which would be
// a fragile thing to depend on being colon-safe. An array with a linear
// findIndex is simpler and has no such edge case, and this store is never
// going to hold enough entries for that to matter performance-wise.
//
// Every public method here is safe to call even if something upstream is
// broken — main.js's call sites additionally wrap these in try/catch, but
// the methods themselves never throw for "normal" bad input (missing ids,
// etc.), they just no-op, so a corrupted or hand-edited pochi-memory.json
// degrades to "memory not persisting" rather than crashing the app.

const Store = require('electron-store');

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // low-importance entries auto-expire after ~30 days
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const CATEGORY_LABELS = {
  preferences: 'Preference',
  habits: 'Habit',
  daily_summary: 'Daily summary',
  milestones: 'Milestone',
  // Chapter 41B: project_sessions added here only — every existing label
  // and every existing category's behavior is untouched.
  project_sessions: 'Project session'
};

function createMemoryStore(options = {}) {
  // cwd is only ever passed in tests — electron-store defaults to
  // app.getPath('userData') when omitted, which is exactly what production
  // wants and what requires no explicit wiring here.
  const storeOptions = { name: options.storeName || 'pochi-memory', defaults: { entries: [] } };
  if (options.cwd) storeOptions.cwd = options.cwd;
  const store = new Store(storeOptions);

  function getAll() {
    try {
      return store.get('entries', []);
    } catch (_) {
      return [];
    }
  }

  function saveAll(entries) {
    try {
      store.set('entries', entries);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Upsert by id: preferences/habits are meant to update in place as
  // patterns change (Ch.42.17's "medium" tier — persist, but overwritable),
  // daily_summary upserts the SAME day's entry as it accumulates through
  // the day rather than appending a new row per event, and milestones use
  // writeMilestoneOnce() below instead of this directly.
  function upsert({ id, category, importance, key, summary, value }) {
    const entries = getAll();
    const idx = entries.findIndex((e) => e.id === id);
    const now = Date.now();
    const entry = {
      id,
      category,
      importance,
      key,
      summary,
      value: value === undefined ? null : value,
      createdAt: idx >= 0 ? entries[idx].createdAt : now,
      updatedAt: now
    };
    if (idx >= 0) entries[idx] = entry; else entries.push(entry);
    saveAll(entries);
    return entry;
  }

  function upsertPreference(key, summary, value) {
    return upsert({ id: `preferences:${key}`, category: 'preferences', importance: 'medium', key, summary, value });
  }

  function upsertHabit(key, summary, value) {
    return upsert({ id: `habits:${key}`, category: 'habits', importance: 'medium', key, summary, value });
  }

  function upsertDailySummary(dateKey, summary, value) {
    return upsert({ id: `daily_summary:${dateKey}`, category: 'daily_summary', importance: 'low', key: dateKey, summary, value });
  }

  // Milestones are "written once each" per the brief — this is the only
  // write path for them, and it's a genuine no-op (not an overwrite) if
  // the milestone already exists, so callers can check "did this just get
  // recorded for the first time" from the return value.
  function writeMilestoneOnce(key, summary, value) {
    const entries = getAll();
    if (entries.some((e) => e.id === `milestones:${key}`)) return null;
    return upsert({ id: `milestones:${key}`, category: 'milestones', importance: 'high', key, summary, value });
  }

  function hasMilestone(key) {
    return getAll().some((e) => e.id === `milestones:${key}`);
  }

  // Chapter 41B: a small, purely-additive generic write path for
  // categories that don't fit the fixed upsert* helpers above — e.g.
  // project_sessions, a repeatable per-session record (unlike
  // preferences/habits, which upsert in place by a fixed key, and unlike
  // milestones, which are write-once). Reuses the exact same internal
  // upsert() every other write path here goes through, so this adds no
  // new storage logic — just a new id shape (category:key, caller-chosen
  // key) for categories that need one entry per event rather than one
  // entry per category or per day. Every existing exported function above
  // is untouched by this addition.
  function recordEntry(category, importance, key, summary, value) {
    return upsert({ id: `${category}:${key}`, category, importance, key, summary, value });
  }

  function getEntry(id) {
    return getAll().find((e) => e.id === id) || null;
  }

  function listEntries() {
    return getAll()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((e) => ({ ...e, categoryLabel: CATEGORY_LABELS[e.category] || e.category }));
  }

  function deleteEntry(id) {
    const entries = getAll();
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false; // nothing matched
    saveAll(next);
    return true;
  }

  function deleteAll() {
    saveAll([]);
  }

  // Ch.42.17: "low" (daily_summary) auto-expires after ~30 days. This is
  // the whole cleanup subsystem — a filter run once at startup, not a
  // background job. "medium" and "high" are never touched here.
  function runRetentionCleanup() {
    const entries = getAll();
    const now = Date.now();
    const kept = entries.filter((e) => {
      if (e.importance !== 'low') return true;
      return now - e.createdAt <= RETENTION_MS;
    });
    if (kept.length !== entries.length) saveAll(kept);
    return entries.length - kept.length; // count removed, for logging
  }

  function isFirstWeekDue() {
    const firstLaunch = getEntry('milestones:first_launch');
    if (!firstLaunch) return false;
    return Date.now() - firstLaunch.createdAt >= WEEK_MS;
  }

  function exportToPlainText() {
    const entries = listEntries();
    const order = ['milestones', 'preferences', 'habits', 'daily_summary', 'project_sessions'];
    const lines = [
      'Pochi — What I Remember',
      `Exported ${new Date().toLocaleString()}`,
      ''
    ];
    for (const cat of order) {
      const inCat = entries.filter((e) => e.category === cat);
      if (!inCat.length) continue;
      lines.push(`== ${CATEGORY_LABELS[cat]}s ==`);
      for (const e of inCat) {
        lines.push(`- [${new Date(e.updatedAt).toLocaleDateString()}] ${e.summary}`);
      }
      lines.push('');
    }
    if (entries.length === 0) lines.push('(Nothing stored yet.)');
    return lines.join('\n');
  }

  return {
    upsertPreference,
    upsertHabit,
    upsertDailySummary,
    writeMilestoneOnce,
    recordEntry,
    hasMilestone,
    getEntry,
    listEntries,
    deleteEntry,
    deleteAll,
    runRetentionCleanup,
    isFirstWeekDue,
    exportToPlainText,
    get filePath() { return store.path; }
  };
}

module.exports = { createMemoryStore, RETENTION_MS, WEEK_MS };
