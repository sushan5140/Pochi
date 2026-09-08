// Chapter 23: renderer-side playback. This is the half of the audio layer
// that can actually reach an output device — the main process has none.
// HTMLAudioElement is a standard Web API, unaffected by contextIsolation
// (that only blocks Node/Electron APIs, not the DOM), so no preload
// bridge is needed for playback itself — only for the tiny inbound
// volume-settings channel below.
//
// Every clip is preloaded once at load so the FIRST play of each has no
// decode-latency gap. Fails soft everywhere: an unknown clip name or a
// playback rejection (e.g. a codec/file issue) is logged and skipped,
// never thrown — per the brief, sound is enhancement, never a dependency.

const CLIP_NAMES = [
  'oh', 'hmm', 'aww', 'mmhm', 'exhausted_sigh', 'hmph', 'eep', 'yeh_celebration',
  'ui_click_pop', 'ui_pomodoro_complete', 'ui_milestone_sparkle'
];

const clips = {};
for (const name of CLIP_NAMES) {
  try {
    const el = new Audio(`../assets/audio/${name}.mp3`);
    el.preload = 'auto';
    clips[name] = el;
  } catch (e) {
    console.warn('[audio] failed to load clip:', name, e.message);
  }
}

// Effective volume as pushed from main (already folds in Do Not Disturb
// and the tray's Off/Low/Medium/High level — this file doesn't need to
// know about either, it just applies whatever number it's given).
let volume = 0.65;

function play(names) {
  if (!names || volume <= 0) return;
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const clip = clips[name];
    if (!clip) {
      console.warn('[audio] unknown clip requested:', name);
      continue;
    }
    try {
      clip.currentTime = 0;
      clip.volume = volume;
      const playResult = clip.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch((e) => console.warn('[audio] playback rejected:', name, e.message));
      }
    } catch (e) {
      console.warn('[audio] playback threw:', name, e.message);
    }
  }
}

function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v)));
  if (Number.isNaN(volume)) volume = 0;
}

window.pochiSound = { play, setVolume };

// Self-contained subscription: this file owns both halves of "how loud
// should I be" without renderer.js needing to know the channel exists.
window.pochi.onAudioSettings((settings) => {
  if (settings && typeof settings.volume === 'number') setVolume(settings.volume);
});
