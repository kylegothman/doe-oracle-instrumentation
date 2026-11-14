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
  electron-builder.yml      installer packaging (MSI); ships config/ as an extra resource
  config/questions.json     the 12 standard questions, read at startup by QuestionBank
  eslint.config.mjs         lint rules (the renderer may not import Electron or Node)
  vitest.config.ts          unit test settings
  tsconfig.node.json        TypeScript for main, preload, shared
  tsconfig.web.json         TypeScript for renderer, shared
  src/
    main/                   Electron main process (Node)
      index.ts              app lifecycle and window creation
      execution/            TrialController, FailureDetector, TimingService, SessionManager, QuestionBank, IpcRouter, IPC handlers
      adapters/             SubjectAdapter interface and one adapter per system under test (OracleAdapter, with its chat fixture under __fixtures__)
      browser/              BrowserManager: launches and owns the Playwright Chromium window
      config/               settings (Oracle URL, per-subject time limits)
      data/                 MetricsRepository (SQLite, versioned migrations) and the startup probe
    preload/                contextBridge script that exposes window.harness
    renderer/               React UI (browser only, no Node access)
    shared/                 types and enums shared by main, preload, and renderer (Subject, FailureType, Trial, TrialEvent)
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

`BrowserManager` (`src/main/browser`) launches headed Chromium through Playwright from the Electron main process, gives each system under test its own browser context and page, and closes everything when the harness quits. The windows are headed on purpose: the Tester watches the trial happen.

The Oracle runs in a throw-away context of a shared Chromium, gone when the harness quits. Copilot runs in its own Chromium on a persistent profile folder, `browser-profiles/copilot` under the per-user app data folder (the same place as `harness.db`, never the repository), so the Tester signs in once and later launches find the session. The harness only hands the folder's path to Playwright; it never reads cookies or tokens from it. Delete the folder to sign out for good.

**Open Copilot to sign in** in the window brings the Copilot window to the front on the chat page and reports what it shows: signed in (the question input is there), signed out (the sign-in landing page or a sign-in host), offline, or unknown. Signing in, including any second factor, is done by the Tester in that window; the harness never types credentials. A Copilot trial that finds the page signed out is aborted, not saved, with a message saying to sign in first.

The Oracle's address is a setting. The default, `http://localhost:5173`, is in `src/shared/harness-config.json`; set `HARNESS_ORACLE_URL` to point somewhere else, for example `HARNESS_ORACLE_URL=http://127.0.0.1:4173 npm run dev`. The chat page is `/chat` under that URL. If the Oracle is not running, the harness reports "Could not reach the DOE Oracle at ..." instead of failing silently.

Playwright's Chromium lives in the user's cache, not in the app, so the MSI does not include it yet (tracked in #44).

## Running a trial

1. Start the Oracle: its Flask backend and its Vite frontend (see the repository README). The harness only needs the frontend URL, `http://localhost:5173` by default; set `HARNESS_ORACLE_URL` to point somewhere else.
2. From `harness/`, run `npm run dev`. The window shows this launch's session ID in the bar at the top; every trial saved during the launch carries it.
3. Click **Run Oracle trial (Q1)**. A Chromium window opens on the Oracle chat page. The harness types "What is combinatorial testing?", presses Enter, and waits for the answer. Status events (`started`, `first response`, `completed`, or `failed`) appear under the button as they happen.
4. The result panel shows the status, begin, first response, and end (ISO 8601 UTC with milliseconds), the response time and time to first response in milliseconds, the citations, and a preview of the answer. A failed trial shows its failure type and message instead. The saved-trials table below reads back from the database, so a trial from an earlier launch is still listed.

### What happens underneath

`TrialController` (`src/main/execution/trial-controller.ts`) is the Test Execution core: every subject runs through it the same way. It holds one adapter per subject (`SubjectAdapter`, `src/main/adapters/subject-adapter.ts`), runs one trial at a time, and drives the adapter through `start`, `waitForFirstResponse`, `waitForCompletion`, and `captureAnswer`, recording the three timing marks with `TimingService` and saving the trial through `MetricsRepository`. `SessionManager` starts one session per launch (saved in the `sessions` table) and builds the data set name as subject code plus local date, for example `DOE_ORACLE-2026-11-12`. `QuestionBank` reads the 12 standard questions from `config/questions.json`.

Each subject has a time limit, 60 seconds by default (`trialTimeoutMs` in `src/shared/harness-config.json`, or `HARNESS_TRIAL_TIMEOUT_MS` to override it for a run). When the clock starts is also per subject: for the Oracle it starts as the trial starts, before the page is opened, so a hang anywhere ends within the limit; for Copilot and Google it will start at the Tester's submit. It stops when completion is reached. A trial that runs out of time is saved as a `TIMEOUT` failure.

### Failures

`FailureDetector` (`src/main/execution/failure-detector.ts`) classifies what the adapter or the clock observed into one of four types, in this order of precedence:

| Type | Rule | How the Oracle adapter sees it |
| --- | --- | --- |
| `TIMEOUT` | the subject's clock ran out | the controller's timer |
| `ERROR_RESPONSE` | the subject's endpoint answered with HTTP 400 or higher | the `response` event's status for the POST to `/api/search` |
| `UNREACHABLE` | a connection or navigation error, including the Flask backend being down while the frontend loads | `page.goto` failing, the POST's `requestfailed` event, or the page showing "Error searching for … Failed to fetch" before any request left |
| `EMPTY_ANSWER` | the answer is empty or only whitespace | an answer bubble that stays empty once the page is idle; the controller also checks every captured answer |

A refusal to answer is an answer, not a failure. On a failure the controller disposes the adapter (bounded by 3 seconds), stops the clock, saves the trial as `FAILED` with whichever marks it reached plus a `failed_requests` row (type, message, elapsed milliseconds), sends a `failed` event, and returns the failed trial to the UI. The harness is ready for the next trial as soon as that returns, within 5 seconds of the failure (NFR-3).

Two outcomes are never saved: a trial the Tester cancels (`cancelTrial`, not yet wired to a button) and a trial the harness itself could not run, for example because Playwright's Chromium is missing or the page was closed under the adapter. Those report `cancelled` or `aborted` with the reason.

## Driving the Oracle

`OracleAdapter` (`src/main/adapters/oracle-adapter.ts`) implements `SubjectAdapter` for the Oracle. Its `start()` opens the chat page, types the question into the input (found by its placeholder), checks the typed text matches exactly, and submits with Enter, which runs the same handler as the icon-only Send button. It then waits for a new answer bubble, found through the per-answer "Copy" button, and reads the answer text without citation lines and buttons, plus the citation lines. `dispose()` drops the trial's listeners and pending waits; the next `start()` loads the page afresh. The selectors live in `ORACLE_SELECTORS` with a note on why each one was chosen; the Oracle's own code is never changed.

Trials are timed from the browser's own events, not from the Oracle's code:

| Event | When | Clock |
| --- | --- | --- |
| begin | the POST to `/api/search` leaves the page (Playwright `request` event; the CORS preflight is not a POST) | main process |
| first response | that request's response arrives (`response` event), whatever its status | main process |
| end | the answer text is on the page | the page's own `Date.now()` |

`TimingService` (`src/main/execution/timing-service.ts`) records these marks per trial and converts them for storage: `toIso()` gives ISO 8601 UTC with milliseconds and `durationMs()` whole milliseconds. Both clocks are the same system clock on the same machine, so the marks are directly comparable.

The adapter test serves a small copy of the chat page from `src/main/adapters/__fixtures__/oracle-chat.html` and fakes `/api/search` through `page.route`, with a delay, an error status, an aborted request, or an empty answer, so it needs no Oracle and no Ollama, only Playwright's Chromium.

## Storage

The database is `harness.db` in Electron's per-user app data folder (`app.getPath('userData')`): `~/Library/Application Support/DOE Oracle Test Harness/` on macOS and `%APPDATA%\DOE Oracle Test Harness\` on Windows. The main log prints the exact path at startup. Delete the file to start over.

The schema is versioned in `MetricsRepository` (`src/main/data/metrics-repository.ts`) and migrations run in order when the database is opened, on a fresh file or one from an earlier version:

| Version | Change |
| --- | --- |
| 1 | `trials`: `trial_id`, `test_number`, `session_id`, `data_set_name`, `subject`, `question_number`, `status`, `begin_ts`, `first_response_ts`, `end_ts`, `response_ms`, `first_response_ms`, `answer_text`, `citations` (a JSON array) |
| 2 | subject codes (`DOE_ORACLE`, `COPILOT`, `GOOGLE`) and status values (`SUCCESS`, `FAILED`, `NO_ANSWER_FOUND`) |
| 3 | `sessions`: `session_id`, `started_at`, `app_version` |
| 4 | `failed_requests`: `trial_id` (references `trials`), `failure_type`, `error_message`, `elapsed_ms` |
| 5 | `trials` gains `page_load_ms`, `time_to_answer_ms`, `source_url` (Google only, null otherwise), `size_bytes` (UTF-8 bytes of the answer, computed on save and backfilled), and `keywords` |
| 6 | `experts`: `expert_id`, `name`, `source` (`EMAIL` or `INTERVIEW`), `outreach_ts`, `first_answer_ts`, `turnaround_ms` (stored once per expert). `expert_responses`: `response_id`, `test_number`, `expert_id` (references `experts`), `session_id`, `question_number`, `answer_text`, `size_bytes`, `keywords`, `recorded_at`, `superseded_by` (references `expert_responses`; null for the active answer) |

Trials and expert answers share one Test # sequence (`nextTestNumber()`), so every exported row has a unique Test #. Expert answers are never overwritten: replacing one keeps the old row, points its `superseded_by` at the new row, and moves its Test # to the new row, so a revised answer keeps its number. Only one active answer per expert and question is allowed.

### Startup check

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
