# Pochi 🐾

A tiny desktop companion that walks around your screen, reacts to activity, and nudges you about breaks and everyday routines.

## Download Pochi — Windows (64-bit)

**You do not need Git, Node.js, npm, a terminal, or the source ZIP.**

### Option 1 — Install Pochi (recommended)

**[Download Pochi for Windows — Setup.exe](https://github.com/sushan5140/Pochi/releases/download/v0.1.0-preview.1/Pochi-Setup-0.1.0-x64.exe)**

1. Download the `Pochi-Setup-0.1.0-x64.exe` file.
2. Open the installer. It is configured to install for your Windows user and create Desktop and Start Menu shortcuts.
3. When installation finishes, Pochi is configured to launch. Use the **Pochi** desktop shortcut the next time.

### Option 2 — Just run Pochi (no install)

**[Download Pochi Portable — Portable.exe](https://github.com/sushan5140/Pochi/releases/download/v0.1.0-preview.1/Pochi-Portable-0.1.0-x64.exe)**

Open the downloaded `Pochi-Portable-0.1.0-x64.exe` directly. There is no setup process, and it does not create a desktop shortcut automatically.

**Important:** These are early, **unsigned Windows preview** builds. Windows SmartScreen or antivirus software may show an unknown-publisher warning. Only run files you trust; check that the download comes from this GitHub repository and verify against [the release's SHA-256 checksums](https://github.com/sushan5140/Pochi/releases/tag/v0.1.0-preview.1) if you want extra assurance. This is not yet a fully desktop-tested stable release.

**Do not use GitHub's green “Code → Download ZIP” button or the automatic “Source code (ZIP)” links.** Those contain development files, not an installable Pochi app.

[See the Windows preview release and all download files](https://github.com/sushan5140/Pochi/releases/tag/v0.1.0-preview.1).

## For developers

Pochi is an experimental Electron app. The existing automated renderer regression suite does not replace hands-on desktop testing. The documented release checks currently focus on Windows.

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
