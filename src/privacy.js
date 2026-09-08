// Chapter 22 (v1 core): privacy/trust layer.
//
// Two genuinely separate concerns share this file because they're both
// small and both about the same theme, not because they're related in
// mechanism:
//
// 1. Do Not Disturb — the one real new piece of state this chapter adds.
//    A plain in-memory on/off flag, exactly like Study/Project mode's
//    active flags in studyMode.js: no persistence across restarts (the
//    brief only asks for "until toggled off", a session-scoped promise,
//    not a durable setting), so a factory function with closure state is
//    the same shape as every other isolated module in this app.
//
// 2. getTransparencyList() — a pure read of OTHER modules' live state
//    (awareness, memory), reused as-is rather than duplicated. This is
//    deliberately a plain function, not part of the factory above: it
//    owns no state of its own and main.js already has awareness/memory
//    instances to hand it, so there's nothing here worth wrapping.

function createPrivacyMode() {
  let doNotDisturb = false;

  return {
    isDoNotDisturb() {
      return doNotDisturb;
    },
    setDoNotDisturb(value) {
      doNotDisturb = !!value;
      return doNotDisturb;
    },
    toggleDoNotDisturb() {
      doNotDisturb = !doNotDisturb;
      return doNotDisturb;
    }
  };
}

// Ch.22.15 "What Pochi does today" — every line is conditioned on the real
// signal it describes being true right now (or, for the memory line,
// having ever actually stored something), so a disabled/broken module or a
// brand-new install with nothing stored yet correctly drops its own line
// instead of listing a capability that isn't actually in effect. The
// no-network-calls line has no such condition: it's a structural fact of
// this codebase (no fetch/http/net calls anywhere outside localhost IPC),
// true regardless of which optional modules are currently running.
function getTransparencyList({ awareness, memory }) {
  const lines = [];

  try {
    if (awareness && awareness.getSnapshot().available) {
      lines.push("Checks which app is active, so I know when you're coding or relaxing");
    }
  } catch (_) { /* awareness unavailable: its line is correctly omitted, not shown as broken */ }

  try {
    if (memory && memory.listEntries().length > 0) {
      lines.push('Remembers your habits locally on this computer');
    }
  } catch (_) { /* memory unavailable: its line is correctly omitted */ }

  lines.push('Nothing is ever sent to the internet');

  return lines;
}

module.exports = { createPrivacyMode, getTransparencyList };
