# Pochi — v0.1 Build Brief

Give this file + the sprite folders (expressions/, poses/, turnaround/) to Claude Code
in a new project folder. Say: "Read BUILD_BRIEF.md and scaffold this."

## What Pochi is
A tiny (~1.5in tall on screen) always-on-top transparent desktop pet that walks
around the whole screen (not confined to one app), reacts with facial expressions,
and nags the user about water/food/sleep/battery with sarcasm. Full design spec
lives in the user's Notion ("The Pochi Bible", 30+ chapters) — this brief scopes
only the v0.1 slice that's actually buildable right now.

## Stack
- Electron (cross-platform: Windows/Mac/Linux from one codebase)
- Plain JS/TS + HTML/CSS for the renderer (no framework needed yet — keep it light)
- `electron-store` or a local JSON file for simple persistent memory (last drink time,
  friendship counters, etc.)
- Node's `os` / `systeminformation` package for battery status
- `active-win` npm package for detecting the frontmost application (VS Code, browser, etc.)

## Window setup
- Frameless, transparent, always-on-top `BrowserWindow`
- `setIgnoreMouseEvents` toggled so clicks pass through EXCEPT on Pochi's own
  bounding box (so the rest of the screen stays fully usable)
- Window covers the full screen (or spans all displays) so Pochi can walk edge to edge
- Pochi's actual sprite is a small positioned `<img>` inside that transparent window,
  not the whole window filled

## Assets provided
- `expressions/` — 8 PNGs, transparent bg: happy, smug, angry, tired, laughing,
  judging, worried, sleepy
- `poses/` — 8 PNGs, transparent bg: walking, reading, water_bottle, charger,
  laughing_pose, arms_crossed, sleeping_pillow, dancing
- `turnaround/` — front, three_quarter, back (reference only, not animated frames)

Treat each PNG as a single-frame "pose" for now (no walk-cycle in-betweens yet —
that's a v0.2 upgrade). Swapping the `<img src>` between expression/pose sprites
IS the animation for v0.1. Add a CSS transition/easing on position changes so
movement across the screen feels smooth even with a single walking sprite.

## Core behavior loop (state machine)
States: `idle`, `walking`, `nagging_water`, `nagging_food`, `nagging_sleep`,
`nagging_battery`, `celebrating`, `sleeping`.

Simple decision loop, checked every ~30-60s:
1. Read battery level (via systeminformation).
   - <20%: switch expression to `worried`, walk toward center, show charger pose.
   - Ignored 2+ checks: escalate to `angry` expression (red face), sprite = charger pose.
2. Track "last water reminder shown" timestamp in local store.
   - Every ~45-60 min of active use: show `water_bottle` pose + a sarcastic line.
   - If ignored past N reminders: escalate expression from `smug` → `judging` → `angry`.
3. Track time since app start / long session length for "break" nagging (same
   escalation pattern, using `tired` expression).
4. Late night (system clock, e.g. after 12:30am): switch to sleepy behavior,
   `sleepy` expression, `sleeping_pillow` pose, gentler tone.
5. On any "ignored" escalation resolving (user does the thing, however that's
   detected/assumed), return to `happy` expression briefly, then `idle`.

Keep all nagging text in one `dialogue.js` object keyed by state + escalation level,
so tone (sarcastic, caring, never insulting) is easy to edit centrally. Example lines
are in the Notion bible Ch.5, Ch.16.10 — pull the sarcasm examples from there if useful.

## App awareness (stretch for v0.1, core for v0.2)
Use `active-win` to detect frontmost app name:
- `Code.exe` / `Visual Studio Code` → coding mode: Pochi sits at a corner, uses
  `reading` pose more, quieter about nagging.
- Browser + YouTube/Netflix tab title (harder — needs a browser extension
  companion for true tab-level detection; for v0.1, just detect "browser is
  frontmost for >X minutes" as a proxy for entertainment time).

## Notion integration (stretch)
User has Notion connected elsewhere; for the Electron app itself, use the
Notion API with a personal integration token (user creates one at
notion.so/my-integrations) to read a task database and let Pochi react when
a task is marked done. Not required for v0.1 core loop — nice add-on.

## What NOT to build yet
Skip for v0.1: skeletal rigging, weather/seasons, mini-games, room/garden
economy, friendship leveling UI, multi-monitor travel, sound design. These are
all real parts of the full vision (see Notion bible) but are v0.3+ work.

## Definition of done for v0.1
- `npm start` launches a transparent overlay Pochi that idles/walks around the
  desktop over any app
- Battery and water/break nagging both work and visibly escalate (expression +
  pose changes) if ignored
- Clicking Pochi cycles/tests expressions (dev/debug affordance)
- Runs without visibly spiking CPU/RAM at idle
