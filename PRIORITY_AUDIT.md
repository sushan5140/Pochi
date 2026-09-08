# Pochi — State Priority Audit (Consolidation Pass)

Not a new chapter. This documents how the 9 systems built so far (v0.1
core, Phase 4 app awareness, Ch.41 productivity + Study/Project, Ch.42
memory, Ch.46 personality, Ch.21 friendship, Ch.22 privacy/DND, Ch.23
sound) actually interact inside `tick()` and the handful of places
outside it that can also change `currentState`. Triggered by a real bug
found live-testing Chapter 23: late-night mode silently overwrote an
active, unresolved water nag before the user could ever see or click it.

## The real, current priority order

See the comment block directly above `tick()` in `main.js` for the
canonical, always-in-sync version. Summary:

1. `dragging` (real user manual control)
2. Do Not Disturb (explicit user action)
3. battery-critical
4. **an already-active, user-resolvable nag — holds indefinitely** (the fix, see below)
4b. **an active mini-game session — same indefinite-hold treatment** (Ch.24/25, see below)
5. late-night/sleep wind-down
6. first_week / daily-greeting / became_helpful_friend milestones
7. water → food → break nags (fixed order among themselves)
8. entertainment nag
9. debug-support nag
10. distraction nag
11. Pomodoro countdown refresh (ambient)
12. nothing due → idle / wander

`nagging_battery` and `sleeping`/`nagging_sleep` are not "user-resolvable"
(no click clears them; they resolve on their own — battery by charging,
sleep by real time passing) so they aren't held by rule 4 and can still be
cleared by the bottom "nothing due" fallback once nothing above claims
them.

## Bug fixed: late-night silently overwriting an active nag

**Before:** `tick()`'s battery check ran, then immediately fell through to
late-night, then the water/food/break loop, with no check anywhere for
"is a nag already being shown that the user hasn't acted on yet." Any of
the following could silently replace an active `nagging_water` (etc.)
before the user ever saw or clicked it:
- late-night's own unconditional `currentState = ...` a few lines down
- a *different* nag type becoming due on a later tick while the first was
  still showing
- the "nothing due" fallback at the bottom of `tick()`, which reset
  *any* `nagging_*` state back to idle roughly one tick (~30s) after it
  first appeared, regardless of whether the user had interacted with it —
  the deeper version of the same bug: nags were never actually "waiting,"
  they were on a hidden 30-second timer.

**After:** one guard, placed right after the battery block:
```js
if (ACTIVE_NAG_STATES.includes(currentState)) return;
```
`ACTIVE_NAG_STATES` is the same six click-resolvable states as
`renderer.js`'s `RESOLVABLE` array. Once one of them is showing, `tick()`
does nothing else on every subsequent cycle — not late-night, not a
different nag, not the idle fallback — until `resolveNag()` /
`dismissSupportiveNudge()` (a real click) changes `currentState` away
from that list, or a battery emergency (checked earlier, unconditionally)
claims it instead.

Consequence worth naming: since `tick()` never re-enters the water/food/
break loop while one of them is already showing, escalation (smug →
judging → angry) effectively pauses while a nag is waiting to be seen —
it can't escalate to something she doesn't know you've noticed. This
seems like the right behavior, not a regression.

## Other collisions checked

For each pair, checked whether the code has an explicit answer or one
silently wins by accident of ordering.

| Pair | Verdict | Reasoning |
|---|---|---|
| DND vs. battery/late-night/any nag | **Designed.** | DND is checked first in `tick()`, and `fireCelebration()`/`wander()` both check it independently since they can be triggered from outside `tick()`. Explicitly documented in Ch.22 as "above even battery." No change. |
| DND vs. an already-active nag | **Designed.** | `toggleDoNotDisturb()` calls `parkForDoNotDisturb()` unconditionally, overwriting an active nag with no protection. Deliberately *not* given the same protection as late-night: DND is an explicit, deliberate user action taken *right then* ("go quiet now"), not a silent background mode transition — treating it differently from late-night is the correct reading of "Pochi never fights control." |
| Battery vs. an already-active nag | **Designed (accepted).** | Brief's own proposed order puts battery above the active-nag protection. A real emergency should interrupt a routine reminder. Trade-off: the interrupted nag is not resumed afterward — it only reappears when its own interval next elapses naturally. Building a resume/queue mechanism is new-feature scope, out of bounds for this pass. |
| Pomodoro phase-change vs. an already-active nag | **Already correct, pre-existing.** | `handlePomodoroPhaseChange()` already has `if (currentState.startsWith('nagging_')) return;` before touching anything. Confirmed working, no change. |
| Study/Project announcements vs. an already-active nag | **Already correct, pre-existing.** | `announceSessionEvent()` already has the identical guard. No change. |
| `fireCelebration()` (first_launch/first_week) vs. an already-active nag | **Fixed as a side effect.** | Both are checked further down in `tick()` than the new rule-4 guard, so they can no longer fire while a nag is showing — they'll fire on the first tick after the nag clears instead of being lost (their own "is this due" checks stay true across ticks). |
| `endStudySession()`'s first-time-milestone celebration vs. an already-active nag | **Accepted, not fixed.** | The only remaining unprotected `fireCelebration()` call site — reachable only via a deliberate tray click, not `tick()`. Requires a narrow coincidence (an unresolved nag showing *and* the user's very first study session ending at that exact moment) to ever collide. The achievement itself is still recorded in memory either way; only the celebration animation would visually overlap. Not worth adding a special case for this pass — flagged here instead of silently left unknown, per the brief's own instruction. |
| Sleepy wander vs. quiet-focus (coding/Pomodoro-work/study) wander corner | **Designed.** | `wander()` checks `sleepy` before `isQuietFocus()`; late-night sleepiness wins if both are somehow true at once (e.g. coding at 3am). Simple, deterministic, low-risk — no action needed. |
| Coding-mode / Pomodoro-work / Study-active quiet-focus, all three at once | **Designed, pre-existing.** | `isQuietFocus()` OR's all three together; already documented as "nothing to reconcile." Confirmed still true. |
| Water vs. food vs. break, multiple simultaneously overdue | **Designed.** | Fixed array order in the nagDefs loop, first match wins and returns; the others stay "due" and fire on a later tick once the winner is resolved. Not a silent accident — it's a deliberate, fixed priority list. |

## Bug fixed: entertainment nag escalation off-by-one

The brief called out that the `esc`/`newEsc` off-by-one (expression
computed from the *post-increment* value instead of the value as of this
message) had already been found and fixed in one place. Auditing every
place `Math.min(esc + 1, 2)` appears turned up a **second, still-broken
occurrence**: the entertainment nag (step 8) computed `expr` from
`newEsc` instead of `esc`, meaning the very first entertainment nag ever
shown always opened on `'judging'`, silently skipping `'smug'` — the
identical bug, just never ported over when entertainment nagging was
added. Fixed to match the water/food/break loop's pattern (minus the
Ch.46 escalation-offset mechanic, which entertainment was always
deliberately excluded from).

## Bug fixed: mini-game session silently hijacked by a stale wander timer (Ch.24/25)

Live-testing the first mini-game (a fast catch/reaction game that holds
`currentState = 'playing_minigame'` for its whole ~30s session, same
indefinite-hold treatment as rule 4) found a real collision this audit's
own `ACTIVE_NAG_STATES` guard didn't cover, because it's a *different*
mechanism than the nag-vs-late-night bug above: not `tick()` overwriting
`currentState` directly, but a **wander timer armed before the session
started, firing after it, and setting `currentState = 'walking'` on a
session `tick()` itself never touched.**

**Root cause:** `scheduleWander()` had no guard of its own — it's called
from three independent places (`tick()`'s own self-heal line, which runs
*before* the mini-game guard further down `tick()`; `pochi:settled`'s
unconditional last line; and the loop those two form, since every fired
timer resets `wanderPending`, which re-triggers the self-heal on the very
next `tick()`). `wander()` itself already had a guard for
`currentState === 'playing_minigame'`, but that only protects the moment
it *fires* — not the moment it's *armed*. A timer armed while the session
was running could still land at the exact instant `currentState` had only
momentarily drifted (e.g. right as the session legitimately ended and
handed control back), a pure race no fire-time guard alone can close.

**Fix:** moved the guard to the single choke point instead of chasing
every caller — `scheduleWander()` itself now returns immediately if
`currentState === 'playing_minigame'`, so no wander timer can exist at all
while a session is running. `handleMiniGameEnded()` is unaffected: it
flips `currentState` to `'idle'` *before* calling `scheduleWander()`.
Verified live via a 14+ second no-click observation window (zero drift)
and multiple full 30-second click-driven sessions completing cleanly with
the correct high-score celebration line.

## Bug fixed: mini-game rapid-tap clicks misread as a drag (Ch.24/25)

A second, unrelated collision surfaced only under real repeated clicking:
this window runs `setIgnoreMouseEvents(true, {forward: true})`, so the
renderer receives every `mousemove` across the whole screen (needed to
detect cursor re-entry for click-through), not just ones over the sprite.
A mini-game round's mousedown, held open even briefly, has a real chance
of unrelated on-screen mouse traffic landing inside that window and being
misread as drag movement of *that* click — confirmed live: even a
generous 40px distance threshold didn't help, since ordinary mouse travel
elsewhere on the screen routinely exceeds it. A real deliberate drag is
always held open noticeably longer than a tap before the user starts
moving to relocate her, so the actual fix gates on **hold time, not
distance**: `renderer.js`'s `onDragMove` now ignores all movement for the
first `MINIGAME_DRAG_HOLD_MS` (150ms) of any gesture that began as a
mini-game tap (`dragCandidate.isMinigameTap`, captured once at
`mousedown`). Gestures that don't start on a live round are completely
unaffected — this only changes how soon the pre-existing "grabbing her
mid-session cancels the game" escape hatch can arm, and only for the one
interaction pattern (fast repeat-clicking) fast enough to expose it.

## What was NOT touched

Per the brief's explicit scope: no new features, no refactor of anything
not part of an actual collision. `resolveNag()`, `dismissSupportiveNudge()`,
`wander()`'s existing nagging-state guard, `isQuietFocus()`, the
water/food/break priority list itself, and every module outside `main.js`
are unchanged.
