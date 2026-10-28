# Pochi M1 — Release readiness

## Automated gates

- [ ] GitHub Actions Renderer regression is green for the final PR head.
- [ ] Node syntax check and all `tests/locomotion.test.js` tests pass.
- [ ] Review normal merge behavior and author attribution; do not squash distinct commits unless intended.

## Manual Windows Electron checks (required before release)

- [ ] Walking: normal/sleepy acceleration, gradual braking, short/long distance, repeated sharp turns.
- [ ] Jump with Ctrl+click while idle; no double jump, no jump during throw/drag.
- [ ] Landing squash completes and returns to neutral, no stuck pose.
- [ ] Left/right drag and fast release; gentle glide, throw, single edge rebound, final resting position.
- [ ] Minigame clicks, nag resolution, double-click Pomodoro, context menu and click-through still work.
- [ ] Screen resize, secondary monitor, negative desktop coordinates and monitor gaps do not hide Pochi.
- [ ] Idle breathing and micro-movements do not override expressions or prevent sleep.
- [ ] 10-minute idle CPU/RAM measurement and 5-minute motion CPU/RAM measurement on Windows 8 GB RAM laptop, compared with baseline.
- [ ] Confirm Pochi closes cleanly; no runaway rAF/idle timers or stale drag state.

## Current boundaries

The overlay uses virtual desktop rectangular bounds. Individual monitor geometry/gaps are not independently modeled. L11 blink/eye movement and L12 head movement are whole-sprite approximations, not independent anatomical animation. Windows visual checks and actual resource measurements are required; green Node tests alone do not establish release readiness.
