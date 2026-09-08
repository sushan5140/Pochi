// Foreground-app awareness layer (Phase 4).
//
// Deliberately self-contained: it owns its own polling clock and exposes a
// read-only snapshot, so main.js asks "what category are we in" and nothing
// else. Nothing in here touches movement, animation, or the nag state
// machine. Deleting the two call sites in main.js disables the whole
// feature cleanly.
//
// Every failure path degrades to category 'unknown', which main.js treats
// exactly like 'other' (normal behaviour). Pochi must still walk and nag
// with this module completely broken.

const POLL_MS = 4_000; // brief asks 3-5s

// A category has to hold this long before coding mode engages. Without it,
// alt-tabbing into the editor for three seconds would yank her into the
// corner and back.
const CODING_SUSTAIN_MS = 30_000;

// Measured on this machine: a single YouTube sitting bounced to "New Tab"
// and back three times inside 40 seconds. Resetting the session clock on
// each of those would mean the threshold never fires, so leaving
// entertainment only PAUSES the clock — it takes a sustained absence to
// actually reset it.
const ENTERTAINMENT_GRACE_MS = 3 * 60_000;

// If the native binding is missing, active-win's windows-binding.js
// silently substitutes stubs that return undefined forever rather than
// throwing. That looks identical to "no foreground window", so a run of
// them is treated as the module being broken instead.
const MAX_CONSECUTIVE_EMPTY = 5;

const CODING_RE = new RegExp([
  'Visual Studio Code',
  '\\bCode\\.exe\\b',
  '\\bCursor\\b',
  'Windsurf',
  'Sublime Text',
  'JetBrains|IntelliJ|PyCharm|WebStorm|Rider|CLion|GoLand|PhpStorm|DataGrip',
  'Android Studio',
  'Eclipse',
  '\\bNeovim\\b|\\bnvim\\b',
  'Visual Studio\\b(?! Code)'
].join('|'), 'i');

const BROWSER_RE = /chrome\.exe|firefox\.exe|msedge\.exe|brave\.exe|opera\.exe|vivaldi\.exe|arc\.exe|Google Chrome|Mozilla Firefox|Microsoft.?Edge|Brave Browser|Opera|Vivaldi|Safari/i;

// Matched against the window TITLE only, never page content — the bible's
// privacy rule (Ch.47.8) is that Pochi needs to know "entertainment site
// detected", not read the page.
const ENTERTAINMENT_TITLE_RE = /YouTube|Netflix|Prime Video|Disney\+|Hotstar|Hulu|Twitch|HBO ?Max|Crunchyroll|JioCinema|Zee5|SonyLIV|Dailymotion/i;

// Standalone media apps, matched on process name rather than title.
const MEDIA_APP_RE = /Netflix|Spotify|VLC|Prime Video|Disney\+|Plex|MPC-HC|PotPlayer/i;

function normalisePath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

function createAppAwareness(options = {}) {
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  let activeWinFn = null;
  let loadAttempted = false;
  let available = false;
  let timer = null;
  let polling = false;
  let consecutiveEmpty = 0;

  let category = 'unknown';
  let categorySince = Date.now();
  let lastRaw = null;

  // Accumulated entertainment time for the CURRENT session, plus when we
  // last left it (null while actively in entertainment).
  let entertainmentMs = 0;
  let entertainmentAwaySince = null;
  let lastPollAt = null;

  const selfPath = normalisePath(process.execPath);

  async function ensureLoaded() {
    if (loadAttempted) return activeWinFn;
    loadAttempted = true;
    // Installed active-win 8.2.1 is CommonJS despite the version number, so
    // require() is the direct path; the dynamic import is kept as a fallback
    // in case the dependency is ever upgraded to the ESM-only line.
    try {
      activeWinFn = require('active-win');
      available = true;
      return activeWinFn;
    } catch (_) { /* fall through */ }
    try {
      const mod = await import('active-win');
      activeWinFn = mod.default || mod.activeWindow || mod;
      available = typeof activeWinFn === 'function';
      return activeWinFn;
    } catch (_) {
      activeWinFn = null;
      available = false;
      return null;
    }
  }

  function classify(info) {
    if (!info) return 'idle';
    const name = (info.owner && info.owner.name) || '';
    const exePath = (info.owner && info.owner.path) || '';
    const title = info.title || '';

    if (CODING_RE.test(name) || CODING_RE.test(exePath) || CODING_RE.test(title)) {
      return 'coding';
    }
    if (BROWSER_RE.test(name) || BROWSER_RE.test(exePath)) {
      return ENTERTAINMENT_TITLE_RE.test(title) ? 'entertainment' : 'browsing';
    }
    if (MEDIA_APP_RE.test(name) || MEDIA_APP_RE.test(exePath)) {
      return 'entertainment';
    }
    return 'other';
  }

  // Pochi's own overlay is focusable and periodically becomes the
  // foreground window (measured at 43% of samples while the desktop was
  // otherwise idle). Reporting that as a category change would corrupt both
  // the coding sustain clock and the entertainment session clock, so these
  // samples are dropped and the previous category is held instead.
  function isSelf(info) {
    if (!info || !info.owner) return false;
    if (info.owner.processId === process.pid) return true;
    return normalisePath(info.owner.path) === selfPath;
  }

  function accrueEntertainment(next, now) {
    const elapsed = lastPollAt === null ? 0 : Math.max(0, now - lastPollAt);

    if (next === 'entertainment') {
      // Only credit time that was itself spent in entertainment.
      if (entertainmentAwaySince === null) entertainmentMs += elapsed;
      entertainmentAwaySince = null;
      return;
    }

    if (entertainmentMs > 0) {
      if (entertainmentAwaySince === null) {
        entertainmentAwaySince = now;
      } else if (now - entertainmentAwaySince >= ENTERTAINMENT_GRACE_MS) {
        entertainmentMs = 0;
        entertainmentAwaySince = null;
      }
    }
  }

  async function poll() {
    if (polling) return; // a slow native call must not stack up
    polling = true;
    try {
      const fn = await ensureLoaded();
      if (!fn) {
        setCategory('unknown', null);
        return;
      }

      let info = null;
      try {
        info = await fn();
      } catch (_) {
        info = null;
      }

      if (info === undefined || info === null) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
          available = false;
          setCategory('unknown', null);
          return;
        }
      } else {
        consecutiveEmpty = 0;
        available = true;
      }

      if (isSelf(info)) return; // hold previous category, don't touch clocks

      const now = Date.now();
      const next = classify(info);
      accrueEntertainment(next, now);
      lastPollAt = now;
      setCategory(next, info);
    } finally {
      polling = false;
    }
  }

  function setCategory(next, info) {
    lastRaw = info
      ? { name: (info.owner && info.owner.name) || '', title: info.title || '' }
      : null;
    if (next === category) return;
    category = next;
    categorySince = Date.now();
    try {
      onChange(getSnapshot());
    } catch (_) { /* a listener fault must not kill the poll loop */ }
  }

  function getSnapshot() {
    const sustainedMs = Date.now() - categorySince;
    return {
      available,
      category,
      sustainedMs,
      // The debounced flag main.js actually acts on.
      isCoding: category === 'coding' && sustainedMs >= CODING_SUSTAIN_MS,
      isEntertainment: category === 'entertainment',
      entertainmentMs,
      raw: lastRaw
    };
  }

  return {
    start() {
      if (timer) return;
      poll();
      timer = setInterval(poll, POLL_MS);
      if (timer.unref) timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    getSnapshot,
    // Called when the entertainment nag fires, so the next session starts clean.
    resetEntertainmentSession() {
      entertainmentMs = 0;
      entertainmentAwaySince = null;
    }
  };
}

module.exports = { createAppAwareness, CODING_SUSTAIN_MS, ENTERTAINMENT_GRACE_MS };
