# Pochi

Pochi is an experimental Electron desktop companion: a small, transparent, always-on-top pet that moves around your desktop, reacts to activity, and can nudge you about breaks and other daily routines.

> **Status:** Active prototype, not a packaged release. The renderer regression suite does not replace hands-on Electron testing. The documented release checks are currently aimed at Windows.

## Getting started

You need [Node.js](https://nodejs.org/) and npm. Development CI currently uses Node.js 22.

```powershell
git clone https://github.com/sushan5140/Pochi.git
cd Pochi
npm ci
npm start
```

`npm start` launches the local Electron app. No account or external service is required for the renderer regression tests.

## Verify changes

```powershell
npm test
npm run check
```

- `npm test` runs `tests/locomotion.test.js` using Node's built-in test runner. It exercises renderer behavior with a simulated DOM, animation frames, and IPC.
- `npm run check` syntax-checks the Electron main process, preload, and renderer entry points, then runs the same regression tests.
- These commands do **not** launch a real desktop window, measure resource use, or verify OS-level interaction.

The GitHub Actions workflow in `.github/workflows/renderer-regression.yml` runs the automated checks on pushes to `main` and on pull requests.

## Project layout

| Path | Role |
| --- | --- |
| `main.js` | Electron main process and desktop-companion orchestration |
| `preload.js` | Restricted IPC bridge exposed to the renderer |
| `renderer/` | Desktop UI, sprite rendering, locomotion, and animation |
| `src/` | Supporting behavior, state, dialogue, and memory modules |
| `assets/` | Character graphics and other local assets |
| `tests/locomotion.test.js` | Automated locomotion and animation regressions |
| `PRIORITY_AUDIT.md` | State priority and conflict-resolution design notes |
| `docs/M1-RELEASE-CHECKLIST.md` | Automated and hands-on release gates |

## Known limitations

- The current motion tests use a small simulated renderer environment, not a full Electron instance.
- Multi-monitor geometry and gaps are not fully modeled; refer to the release checklist for manual coverage.
- Windows visual checks, interactions, battery behavior, and CPU/RAM measurements must be completed before declaring a release ready.
- Linux and macOS behavior has not been validated by this repository's current automated workflow.
- Local state and personal data should stay out of commits; the project includes a `.gitignore` for common runtime artifacts.

## Contributing

Keep changes focused, add a regression case for motion or renderer behavior changes, and run `npm run check` before opening a pull request. When changing desktop interaction, complete relevant manual checks in [the M1 checklist](docs/M1-RELEASE-CHECKLIST.md).

See [the build brief](BUILD_BRIEF.md) for the prototype's goals and [the state priority audit](PRIORITY_AUDIT.md) for behavior rules.
