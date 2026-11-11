# DOE Oracle Test Harness

Windows 11 desktop app that measures the DOE Oracle, Microsoft Copilot, and Google Search by asking each the same set of questions. This folder holds the harness only. The sponsor's DOE Oracle code lives at the repository root and is never modified by harness work.

Stack: Electron, React + TypeScript built by Vite through electron-vite, SQLite through better-sqlite3, ExcelJS for exports, Playwright for driving browsers, electron-builder for the MSI installer, Vitest and ESLint.

## Prerequisites

- Node.js 26 LTS. The exact version is in `.nvmrc`.
- npm 11 (bundled with Node 26).
- Git.

No C++ build tools are needed. Native modules used by the harness ship prebuilt binaries.

The harness drives the systems under test through Playwright's Chromium, which is downloaded separately from npm (see Setup).

### Windows 11

1. Install Node 26 LTS with one of:
   - the installer from https://nodejs.org (pick the LTS download), or
   - a version manager, for example [fnm](https://github.com/Schniz/fnm) (`winget install Schniz.fnm`) or [nvm-windows](https://github.com/coreybutler/nvm-windows). With fnm, run `fnm use` inside `harness` to pick up `.nvmrc`.
2. Open a terminal (PowerShell or Windows Terminal) and check `node -v` prints `v26.x`.
3. If PowerShell refuses to run `npm` because scripts are disabled, run it from Command Prompt instead, or ask an admin about the execution policy.

### macOS

1. Install Node 26 LTS with one of:
   - [fnm](https://github.com/Schniz/fnm): `brew install fnm`, then `fnm install` and `fnm use` inside `harness`, or
   - [nvm](https://github.com/nvm-sh/nvm): `nvm install` and `nvm use` inside `harness`, or
   - Homebrew: `brew install node@26`.
2. Check `node -v` prints `v26.x`.

## Setup

```bash
cd harness
npm install
npm run setup:browser
npm run dev
```

`npm run setup:browser` downloads the Chromium build that matches the pinned Playwright version (about 250 MB) into Playwright's browser cache: `~/Library/Caches/ms-playwright` on macOS, `%LOCALAPPDATA%\ms-playwright` on Windows. Run it once per Playwright upgrade. Without it, launching a trial fails with a message that names this script.

`npm run dev` opens the harness window. It reloads the UI as you edit renderer files and restarts the main process when main or preload files change.

The first `npm install` downloads the Electron runtime (about 100 MB). Behind a proxy, set `HTTPS_PROXY` before installing.

## Scripts

Run these from the `harness` folder.

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts electron-vite in watch mode and launches the Electron window. |
| `npm run build` | Bundles main, preload, and renderer into `out/`. This is what packaging consumes. |
| `npm run preview` | Launches Electron against the last `out/` build, without watch mode. |
| `npm run lint` | Runs ESLint over the harness. Fails on any error. |
| `npm run typecheck` | Runs the TypeScript compiler over the Node-side code (main, preload, shared) and the browser-side code (renderer, shared) without emitting files. |
| `npm test` | Runs the Vitest unit tests once. The adapter tests drive a real headless Chromium, so run `npm run setup:browser` first. |
| `npm run setup:browser` | Downloads Playwright's Chromium (headed and headless builds) for this machine. |
| `npm run dist:win` | Builds and packages the Windows MSI installer into `release/`. Windows only. |
| `npm run dist:dir` | Builds and packages an unpacked app for the current OS into `release/`, for a quick local check of the packaged app without an installer. |

Run `lint`, `typecheck`, `test`, and `build` before opening a pull request. Continuous integration runs the same four on Ubuntu and Windows, installing Playwright's Chromium headless shell (cached per Playwright version) before the tests.

## Project layout

```
harness/
  electron.vite.config.ts   bundling for main, preload, and renderer
  electron-builder.yml      installer packaging (MSI)
  eslint.config.mjs         lint rules (the renderer may not import Electron or Node)
  vitest.config.ts          unit test settings
  tsconfig.node.json        TypeScript for main, preload, shared
  tsconfig.web.json         TypeScript for renderer, shared
  src/
    main/                   Electron main process (Node)
      index.ts              app lifecycle and window creation
      execution/            IPC routing, TimingService, and (next) trial orchestration
      adapters/             one adapter per system under test (OracleAdapter, with its chat fixture under __fixtures__)
      browser/              BrowserManager: launches and owns the Playwright Chromium window
      config/               settings (Oracle URL) and config defaults
      data/                 SQLite storage and exports
    preload/                contextBridge script that exposes window.harness
    renderer/               React UI (browser only, no Node access)
    shared/                 types shared by main, preload, and renderer
  out/                      build output (ignored by git)
  release/                  packaged installers (ignored by git)
```

## Security baseline

Every window is created with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. The renderer talks to the main process only through the typed bridge the preload script exposes on `window`. ESLint rejects any `electron` or Node built-in import under `src/renderer`.

## Talking to the main process

The renderer never imports Electron. It calls `window.harness`, a small typed object the preload script exposes with `contextBridge`. Each call is forwarded over `ipcRenderer.invoke` to a handler the main process registered through the `IpcRouter` in `src/main/execution`.

The contract lives in `src/shared/ipc.ts` and is imported by all three sides, so a change there is checked by the compiler everywhere. To add a request:

1. Add the channel and its `args` and `result` types to `IpcContracts` in `src/shared/ipc.ts`, a constant for it in `IpcChannels`, and a method on `HarnessApi`.
2. Write the handler in `src/main/execution/handlers/` as a plain function that takes what it needs as parameters, and give it a Vitest test next to it.
3. Register it in `src/main/index.ts` with `router.register(IpcChannels.yourChannel, handler)`.
4. Forward it in `src/preload/index.ts` by adding the method to `harnessApi`.

Only plain data that survives `structuredClone` may cross the bridge.

## Browser automation

`BrowserManager` (`src/main/browser`) launches one headed Chromium window through Playwright from the Electron main process, gives each system under test its own browser context and page, and closes the browser when the harness quits. The window is headed on purpose: the Tester watches the trial happen.

The Oracle's address is a setting. The default, `http://localhost:5173`, is in `src/shared/harness-config.json`; set `HARNESS_ORACLE_URL` to point somewhere else, for example `HARNESS_ORACLE_URL=http://127.0.0.1:4173 npm run dev`. The chat page is `/chat` under that URL. If the Oracle is not running, the harness reports "Could not reach the DOE Oracle at ..." instead of failing silently.

Until the trial button exists, `HARNESS_DEV_OPEN_BROWSER=1 npm run dev` launches Chromium and opens the Oracle chat page at startup, which is the quickest way to see the browser story on its own.

Playwright's Chromium lives in the user's cache, not in the app, so the MSI does not include it yet (tracked in #44).

## Driving the Oracle

`OracleAdapter` (`src/main/adapters/oracle-adapter.ts`) opens the Oracle chat page, types the question into the input (found by its placeholder), checks the typed text matches exactly, and submits with Enter, which runs the same handler as the icon-only Send button. It then waits for a new answer bubble, found through the per-answer "Copy" button, and reads the answer text without citation lines and buttons, plus the citation lines. The selectors live in `ORACLE_SELECTORS` with a note on why each one was chosen; the Oracle's own code is never changed.

Trials are timed from the browser's own events, not from the Oracle's code:

| Event | When | Clock |
| --- | --- | --- |
| begin | the POST to `/api/search` leaves the page (Playwright `request` event; the CORS preflight is not a POST) | main process |
| first response | that request's response arrives (`response` event) | main process |
| end | the answer text is on the page | the page's own `Date.now()` |

`TimingService` (`src/main/execution/timing-service.ts`) records these marks per trial and converts them for storage: `toIso()` gives ISO 8601 UTC with milliseconds and `durationMs()` whole milliseconds. Both clocks are the same system clock on the same machine, so the marks are directly comparable.

The adapter test serves a small copy of the chat page from `src/main/adapters/__fixtures__/oracle-chat.html` and fakes `/api/search` with a delay through `page.route`, so it needs no Oracle and no Ollama, only Playwright's Chromium.

## Storage check at startup

At startup the main process opens an in-memory SQLite database through better-sqlite3 and reads the SQLite version. The result is logged (`[sqlite] better-sqlite3 loaded, SQLite version 3.x.y`) and shown in the window under "Storage". If the native module cannot be loaded, the window shows a red "SQLite failed to load" box with the error text instead, so a broken install is obvious. No tables are created and nothing is stored.

better-sqlite3 13 uses Node-API and ships prebuilt binaries inside the npm package (Windows x64 and arm64, macOS, Linux). Nothing compiles on `npm install` and nothing is rebuilt for Electron.

## Packaging the Windows installer

`npm run dist:win` on Windows builds the app and produces `release/DOE Oracle Test Harness-<version>-x64.msi` with electron-builder. The first run downloads the WiX toolset into electron-builder's cache. The installer is per-user (no administrator rights needed) and shows a short wizard.

The app icon lives in `build-resources/`: `icon.png` (512 px) is the source and `icon.ico` (16 to 256 px frames) is what Windows uses. The MSI cannot be built without an icon, because electron-builder's installer template always references one for the shortcuts. To rebrand, replace both files.

Continuous integration does the same on `windows-latest` in the `harness-msi` workflow: on every push to `main` that touches the harness, on pull requests that change the packaging setup, and on manual dispatch from the Actions tab. The MSI is attached to the run as the artifact `doe-oracle-test-harness-msi`.

To try a CI build on Windows 11:

1. Open the repository's Actions tab, pick the latest `harness-msi` run, and download the `doe-oracle-test-harness-msi` artifact.
2. Extract the zip and run the `.msi` inside. Windows SmartScreen may warn because the installer is unsigned; choose "More info" and "Run anyway".
3. Launch "DOE Oracle Test Harness" from the Start menu or the desktop shortcut.
4. Check that the window shows the app name and version under "App info" and a green "SQLite ... loaded" line under "Storage". A red "SQLite failed to load" box means the native module did not survive packaging; copy its text into an issue.

To remove it, uninstall "DOE Oracle Test Harness" from Settings, Apps.

On macOS, `npm run dist:dir` produces an unpacked `.app` under `release/` for a quick check of the packaged build. It is unsigned and only for local testing.

## Troubleshooting

- `npm run dev` opens no window: check the terminal for a bundling error, then confirm `node -v` matches `.nvmrc`.
- Electron failed to download during `npm install`: re-run `npm install`; if you are behind a proxy, set `HTTPS_PROXY`.
- macOS shows a blank window on first launch: wait a moment, the window is shown once the renderer is ready.
