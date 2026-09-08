// Chapter 23: main-process half of sound integration.
//
// Actual playback happens in the renderer (renderer/audioPlayer.js) — the
// main process has no audio output of its own, and the renderer is
// already a Chromium page with full Web Audio support, reached via the
// same pochi:state channel every other visual update already goes
// through. This module owns the DECISION side: which clip(s) a given
// moment should play, and what the current effective volume is, so
// main.js's call sites stay one-liners.
//
// Volume/mute persistence reuses store.js's existing electron-store
// instance via its public get/set API — a new key (soundLevel), not
// declared in store.js's `defaults` block, since this chapter's brief
// says not to touch existing module internals. electron-store's
// get(key, fallback) works fine for a key that was never declared there;
// the fallback IS the default until the first real setLevel() call.

const SOUND_LEVELS = ['off', 'low', 'medium', 'high'];
const VOLUME_FOR_LEVEL = { off: 0, low: 0.3, medium: 0.65, high: 1.0 };
const DEFAULT_LEVEL = 'medium';

function createAudioPlayer({ store, privacy }) {
  // Per-category "what did we last play" memory, keyed by category (e.g.
  // 'battery', 'sleep') rather than one single global slot — a single
  // slot would falsely "forget" an ongoing battery alarm the instant an
  // unrelated water nag played in between, replaying the battery sound on
  // the very next tick even though nothing about it had actually changed.
  const activeKeys = new Map();

  function getLevel() {
    const level = store.get('soundLevel', DEFAULT_LEVEL);
    return SOUND_LEVELS.includes(level) ? level : DEFAULT_LEVEL;
  }

  function setLevel(level) {
    if (!SOUND_LEVELS.includes(level)) return;
    store.set('soundLevel', level);
  }

  function getEffectiveVolume() {
    if (privacy && privacy.isDoNotDisturb()) return 0;
    return VOLUME_FOR_LEVEL[getLevel()];
  }

  // Returns `sounds` only the first time a category is asked to play this
  // exact subKey in a row — a call with the SAME (category, subKey) pair
  // as last time (a battery/sleep nag resent on every 30s tick while the
  // underlying condition just sits there) returns null instead, so the
  // clip doesn't loop for as long as the condition persists. A genuinely
  // different subKey within the same category (an escalation change) or a
  // resetCategory() call (the condition cleared, see below) makes it play
  // again normally.
  function pickIfNew(category, subKey, sounds) {
    if (activeKeys.get(category) === subKey) return null;
    activeKeys.set(category, subKey);
    return sounds;
  }

  // Called from the call sites that already detect "this condition just
  // ended" (battery back above 20%, late-night window over) so a FUTURE
  // recurrence of the same subKey plays fresh instead of staying
  // permanently suppressed after the first time.
  function resetCategory(category) {
    activeKeys.delete(category);
  }

  return { getLevel, setLevel, getEffectiveVolume, pickIfNew, resetCategory };
}

module.exports = { createAudioPlayer, SOUND_LEVELS, VOLUME_FOR_LEVEL, DEFAULT_LEVEL };
