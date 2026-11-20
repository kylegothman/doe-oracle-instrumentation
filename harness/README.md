# DOE Oracle Test Harness

Windows 11 desktop app that measures the DOE Oracle, Microsoft Copilot, and Google Search by asking each the same set of questions. This folder holds the harness only. The sponsor's DOE Oracle code lives at the repository root and is never modified by harness work.

Stack: Electron, React + TypeScript built by Vite through electron-vite, SQLite through better-sqlite3, ExcelJS for exports, Playwright for driving browsers, electron-builder for the MSI installer, Vitest and ESLint.

## Prerequisites

- Node.js 26 LTS. The exact version is in `.nvmrc`.
- npm 11 (bundled with Node 26).
- Git.

No C++ build tools are needed. Native modules used by the harness ship prebuilt binaries.

The harness drives the systems under test through Playwright's Chromium, which is downloaded separately from npm (see Setup). This is for development only: the installed app carries its own copy (see "Packaging the Windows installer").

To test the installer on Windows 11, follow `docs/install-test.md`. To set up the Oracle on the reference machine, follow `docs/run-the-oracle.md`. The reference machine itself is described in `docs/reference-machine.md`.

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

`npm run setup:browser` downloads the Chromium build that matches the pinned Playwright version (about 250 MB) into Playwright's browser cache: `~/Library/Caches/ms-playwright` on macOS, `%LOCALAPPDATA%\ms-playwright` on Windows. Run it once per Playwright upgrade. Without it, launching a trial under `npm run dev` fails with a message that names this script.

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
| `npm run setup:browser` | Downloads Playwright's Chromium (headed and headless builds) for this machine, for development and tests. |
| `npm run bundle:browser` | Downloads the pinned headed Chromium into `.browser-bundle/` for the installer and writes its manifest, `browser.json`. `dist:win` and `dist:dir` run it for you. |
| `npm run dist:win` | Builds the app, bundles Chromium, and packages the Windows MSI installer into `release/`. Windows only. |
| `npm run dist:dir` | Builds the app, bundles Chromium, and packages an unpacked app for the current OS into `release/`, for a quick local check of the packaged app without an installer. |

Run `lint`, `typecheck`, `test`, and `build` before opening a pull request. Continuous integration runs the same four on Ubuntu and Windows, installing Playwright's Chromium headless shell (cached per Playwright version) before the tests.

## Project layout

```
harness/
  electron.vite.config.ts   bundling for main, preload, and renderer
  electron-builder.yml      installer packaging (MSI); ships config/ and the bundled Chromium as extra resources
  config/questions.json     the 12 standard questions, read at startup by QuestionBank
  scripts/                  bundle-browser.mjs (Chromium for the installer), msi-smoke-test.ps1 (install, self-check, uninstall), reference-machine-spec.ps1
  docs/                     install-test.md, reference-machine.md, run-the-oracle.md, copilot-spike.md
  eslint.config.mjs         lint rules (the renderer may not import Electron or Node)
  vitest.config.ts          unit test settings
  tsconfig.node.json        TypeScript for main, preload, shared
  tsconfig.web.json         TypeScript for renderer, shared
  src/
    main/                   Electron main process (Node)
      index.ts              app lifecycle and window creation
      execution/            TrialController, FailureDetector, TimingService, SessionManager, QuestionBank, IpcRouter, IPC handlers
      adapters/             SubjectAdapter interface and one adapter per system under test (OracleAdapter, with its chat fixture under __fixtures__)
      browser/              BrowserManager: launches and owns the Playwright Chromium window; browser-location picks the bundled copy or the cache
      self-check/           the --self-check mode: start-up checks that write a report and exit
      config/               settings (Oracle URL, per-subject time limits)
      data/                 MetricsRepository (SQLite, versioned migrations), ErrorLog (failed saves kept for retry), and the startup probe
    preload/                contextBridge script that exposes window.harness
    renderer/               React UI (browser only, no Node access)
      src/App.tsx           the shell: header, tabs, one page per tab
      src/pages/            Test Console, Expert Responses, Export, with each page's logic in a tested .ts file
      src/components/       the design's building blocks in ui.tsx (Card, Field, Segmented, RadioOption, Banner, Badge) and the StatusBar
      src/status-bar.ts     what the status bar shows, worked out from the trial events
      src/styles.css        the design's colors, spacing, and text styles as CSS variables
    shared/                 types and enums shared by main, preload, and renderer (Subject, FailureType, Trial, TrialEvent; Expert, ExpertResponse, ResponseSource; RecordFilter, ExportFormat, ExportRequest, ExportResult, ExportPreview; FailedWriteSummary)
  .browser-bundle/          Chromium fetched for the installer (ignored by git)
  out/                      build output (ignored by git)
  release/                  packaged installers (ignored by git)
```

## The window

The window follows the team's Figma mockups (E6): a dark theme, a header with three tabs (Test Console, Expert Responses, Export), and one page per tab. Every color, space, radius, and text style in the design is a CSS variable at the top of `src/renderer/src/styles.css`, named after the design's variable (`color/bg/surface` is `--bg-surface`). The fonts, Inter and JetBrains Mono, ship inside the app (`@fontsource`, OFL license), so the window looks the same with no network.

All three pages stay mounted and only the active one is shown, so switching tabs during a trial does not interrupt it. Expert Responses is a placeholder until E7 builds it.

The Test Console (story #38) follows the design's screens 01, 02, and 04:

- **New trial.** The subject (Google Search is offered once E5 adds its adapter) and one of the standard questions, which come from `config/questions.json` through `questions:list`, never from the code. The exact text that will be sent is shown before the trial starts. For Copilot, **Open Copilot to sign in** is in this card.
- **The running trial.** A timer, a checklist of the trial's steps as its events arrive, and the buttons that apply: **Cancel Trial** always, and for Copilot, once the answer stops changing, **Confirm Completion** or **Adjust** (the end in seconds after your Enter). While the answer streams, the timer counts from the trial start; the bar against the limit is drawn when the limit counts from the same moment (the Oracle). Copilot's limit counts from your Enter, which the harness only learns when the end is detected, so from then on the timer shows the measured response, Enter to end, against the limit. The limits come from `trials:limits`.
- **The result.** A saved trial shows its test number, response and first-response times, begin and end, an answer preview with its citations, and its size. A failed trial shows its failure type, elapsed time, and first response, with **Retry** for the same question. A trial that ended without being saved (aborted, for example Copilot signed out) says why. **New Trial** goes back to the first card, on the next question after a success.
- **This session.** Every trial of this launch's session, newest first, with its status badge and response time (for a failed trial, the time it failed at). Trials from earlier sessions are on the Export tab.
- **App info.** The app's name and version and whether SQLite loaded, for install checks and bug reports. If SQLite or the questions file could not be loaded, a red banner at the top says so.

Google's **Answer Found** and **No Answer Found** arrive with E5 (#37).

The session status bar (story #39) runs along the bottom of every page. It shows the first 8 characters of this launch's session ID (hover for the full ID and start time), the running trial's subject and question, the time since the trial started, and a badge: **Idle** before the first trial, **Running** during one, **Ready** once it has ended, however it ended. The time counts while the answer streams. Once the answer is complete it shows the measured response, begin to end, and holds still while the harness waits for the Tester to confirm. The bar follows the `trial:event` stream itself, so it is right whichever tab is open. If the session could not be started, it says so in red, since trials cannot be saved without one.

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

The Oracle runs in a throw-away context of a shared Chromium, gone when the harness quits. Copilot runs in its own Chromium on a persistent profile folder, `browser-profiles/copilot` under the per-user app data folder (the same place as `harness.db`, never the repository), so whatever Microsoft lets the browser keep survives a relaunch. How much that is depends on the account's sign-in policy: the work tenant tested never offered "Stay signed in?", and its sign-in lasted only until the harness quit, so the Tester signed in again at each launch (three restarts on 2026-11-14, one through the normal quit path). The harness only hands the folder's path to Playwright; it never reads cookies or tokens from it, and it does nothing to keep a session that the sign-in policy ends. Delete the folder to sign out for good.

**Open Copilot to sign in** in the window brings the Copilot window to the front on the chat page and reports what it shows: signed in (the question input is there), signed out (the sign-in landing page or a sign-in host), offline, or unknown. Signing in, including any second factor, is done by the Tester in that window; the harness never types credentials. A Copilot trial that finds the page signed out is aborted, not saved, with a message saying to sign in first.

The Oracle's address is a setting. The default, `http://localhost:5173`, is in `src/shared/harness-config.json`; set `HARNESS_ORACLE_URL` to point somewhere else, for example `HARNESS_ORACLE_URL=http://127.0.0.1:4173 npm run dev`. The chat page is `/chat` under that URL. If the Oracle is not running, the harness reports "Could not reach the DOE Oracle at ..." instead of failing silently.

Which Chromium is launched depends on how the harness runs (`src/main/browser/browser-location.ts`):

- Under `npm run dev`, Playwright finds the browser in its own cache, where `npm run setup:browser` put it.
- The packaged app launches the copy the installer shipped in `resources/browser/`, found through `browser.json` in that folder. It never falls back to the cache or to a browser installed on the machine, so every installed harness of the same version drives the same Chromium build.

`browser.json` also records the platform and architecture the browser was fetched for. The packaged app compares them with what the app itself was built for (`process.platform` and `process.arch`, so an x64 build running on Windows on ARM matches its x64 browser).

When a launch fails, the trial is not run, and the message gives the fix that can work for what failed:

| What failed | What the message says |
| --- | --- |
| The bundled browser is missing, damaged, or does not start | Reinstall the harness from its installer. |
| The bundled browser was built for another platform, or `browser.json` does not say which | It names both sides, for example "built for macOS (arm64), but this harness is the Windows (x64) build", and says reinstalling will not fix it: ask the team for the right installer. |
| A subject's profile is in use by another Chromium | Close that window and try again. |
| A subject's profile fails to open for any other reason | It names the profile folder and says to close the harness, rename or delete the folder, and start again. The harness creates a new profile, so the Tester signs in to Copilot again. Reinstalling would not help: uninstall keeps the profile. |

## Running a trial

1. For the Oracle, start it: Ollama, its Flask backend, and its Vite frontend (see `docs/run-the-oracle.md`). The harness only needs the frontend URL, `http://localhost:5173` by default; set `HARNESS_ORACLE_URL` to point somewhere else. For Copilot, sign in with **Open Copilot to sign in** after launching the harness, unless the window already shows the chat (see "Driving Copilot").
2. From `harness/`, run `npm run dev`. The status bar at the bottom of the window shows this launch's session ID; every trial saved during the launch carries it.
3. On the Test Console, pick the subject and the question and click **Start Trial**. For the Oracle, a Chromium window opens on the chat page, the harness types the question, presses Enter, and waits for the answer. For Copilot, the harness types the question in the Copilot window and the console says **Press Enter in the Microsoft Copilot window**; you press Enter, and when the answer has finished it gives the detected response time with **Confirm Completion**, **Adjust** (an end in seconds after your Enter), and **Cancel Trial**. The trial's steps are checked off as its status events (`started`, `awaiting submit`, `first response`, `awaiting confirmation`, then `completed`, `failed`, `cancelled`, or `aborted`) arrive.
4. The result panel shows the status, begin, first response, and end (ISO 8601 UTC with milliseconds), the response time and time to first response in milliseconds, the citations, and a preview of the answer. A failed trial shows its failure type and message instead. The saved-trials table below reads back from the database, so a trial from an earlier launch is still listed.

### What happens underneath

`TrialController` (`src/main/execution/trial-controller.ts`) is the Test Execution core: every subject runs through it the same way. It holds one adapter per subject (`SubjectAdapter`, `src/main/adapters/subject-adapter.ts`), runs one trial at a time, and drives the adapter through `start`, `waitForFirstResponse`, `waitForCompletion`, and `captureAnswer`, recording the three timing marks with `TimingService` and saving the trial through `MetricsRepository`. `SessionManager` starts one session per launch (saved in the `sessions` table) and builds the data set name as subject code plus local date, for example `DOE_ORACLE-2026-11-12`. `QuestionBank` reads the 12 standard questions from `config/questions.json`.

Each subject has a time limit, 60 seconds by default (`trialTimeoutMs` in `src/shared/harness-config.json`, or `HARNESS_TRIAL_TIMEOUT_MS` to override it for a run). When the clock starts is also per subject (`timerStartsAt`): for the Oracle it starts as the trial starts, before the page is opened, so a hang anywhere ends within the limit; for Copilot it starts at the Tester's Enter, so a slow Tester cannot cause a false timeout; Google will work like Copilot. It stops when completion is reached. A trial that runs out of time is saved as a `TIMEOUT` failure.

A subject can also require the Tester to confirm the end (`confirmEnd`, on for Copilot): once the adapter reports completion and the clock has stopped, the controller sends `awaiting_confirmation` with the detected begin and end and waits, for as long as it takes, for `confirmCompletion(trialId, endMs?)` through the `trial:confirm` channel. Without `endMs` the detected end stands; with it the end is replaced and the response time recomputed. Only then is the answer captured and the trial saved. `trial:cancel` (`cancelTrial`) ends a running trial at any point, including while waiting for the Tester's Enter or confirmation, and saves nothing.

### Failures

`FailureDetector` (`src/main/execution/failure-detector.ts`) classifies what the adapter or the clock observed into one of four types, in this order of precedence:

| Type | Rule | How the Oracle adapter sees it | How the Copilot adapter sees it |
| --- | --- | --- | --- |
| `TIMEOUT` | the subject's clock ran out | the controller's timer | the controller's timer, running from the Tester's Enter |
| `ERROR_RESPONSE` | the subject's endpoint answered with HTTP 400 or higher, or the subject showed an error in place of an answer | the `response` event's status for the POST to `/api/search` | an alert shown instead of the answer, an error completion on the ChatHub socket, or a socket handshake refused with a status |
| `UNREACHABLE` | a connection or navigation error, including the Flask backend being down while the frontend loads | `page.goto` failing, the POST's `requestfailed` event, or the page showing "Error searching for … Failed to fetch" before any request left | `page.goto` failing, the "No internet connection" screen, or the socket failing or closing before the stream completed with no finished marker following |
| `EMPTY_ANSWER` | the answer is empty or only whitespace | an answer bubble that stays empty once the page is idle; the controller also checks every captured answer | a message marked finished with no answer text |

A refusal to answer is an answer, not a failure. On a failure the controller disposes the adapter (bounded by 3 seconds), stops the clock, saves the trial as `FAILED` with whichever marks it reached plus a `failed_requests` row (type, message, elapsed milliseconds), sends a `failed` event, and returns the failed trial to the UI. The harness is ready for the next trial as soon as that returns, within 5 seconds of the failure (NFR-3).

Two outcomes are never saved: a trial the Tester cancels (the **Cancel** button, `cancelTrial`) and a trial the harness itself could not run, for example because Playwright's Chromium is missing, the page was closed under the adapter, Copilot is signed out, the typed question was changed before it was sent, or the Tester never pressed Enter within the submit wait (`copilot.submitWaitMs`, 5 minutes). Those report `cancelled` or `aborted` with the reason.

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

## Driving Copilot

`CopilotAdapter` (`src/main/adapters/copilot-adapter.ts`) implements `SubjectAdapter` for Microsoft Copilot with the Tester in the loop (Architecture decision AD-3: the harness never presses Enter or clicks Send for Copilot). Which Copilot it drives is a setting: `copilot.product` in `src/shared/harness-config.json`, `m365` (Microsoft 365 Copilot Chat, a work or school account, at `copilot.cloud.microsoft/chat`) or `consumer` (a personal account, at `copilot.com/chat`), overridable for a run with `HARNESS_COPILOT_PRODUCT`. Each product carries its own chat URL, sign-in hosts, ChatHub path, and selectors, so switching needs no code change. The default is `m365`: the spike (`docs/copilot-spike.md`) found consumer Copilot gates every send behind a Cloudflare Turnstile check that Playwright's browser fails, and the harness does nothing to pass or hide from such checks.

A trial goes like this. `start()` opens a new chat on the signed-in profile (so questions never share a conversation), checks the page is the chat and not the sign-in page or the offline screen, types the question into the editor, and checks it read back exactly (the editor appends zero-width characters, which are stripped). It then reports `awaiting_submit` and waits. A `MutationObserver` in the page stamps, with the page's clock, the editor clearing: Copilot clears it as it sends, 14 ms before its own request stamp in the spike. That is **begin**, once a send signal confirms it within `copilot.submitConfirmMs`: the Send button turning into "Stop generating", the new message, or the request frame on the ChatHub WebSocket. An editor that clears with none of those is the Tester deleting the text, and the trial is aborted; so is a question edited before it was sent, and no Enter within `copilot.submitWaitMs`.

| Event | When | Clock |
| --- | --- | --- |
| begin | the editor cleared, confirmed by a send signal | the page's own `Date.now()` |
| first response | the first text in the new answer | the page's |
| end | the last change to the answer text before the message was marked finished | the page's |

The stream is over when the Stop button reverts to Send or the message's actions toolbar appears, or, failing both, when the text has been quiet for `copilot.quietPeriodMs` (2 seconds). The quiet period is never part of the response time, and the page's re-render of the finished message changes no text, so it does not move the end. The Tester then confirms or corrects the end before anything is saved (see "What happens underneath"). `captureAnswer()` reads the answer text without the inline citation buttons, and the citations as `title · url`: titles from the citation buttons' labels, URLs from the `references` the final message carries on the socket. An answer without web grounding has no citations.

The ChatHub socket is read for three things only: the request frame (the submit cross-check), the completion record (so a socket closing early is told apart from one closing after the answer), and the citation URLs. Its frames are parsed in memory and never logged or stored, and the harness never reads cookies or tokens.

The adapter test serves a fixture page, `src/main/adapters/__fixtures__/copilot-chat.html`, with Copilot's editor, Send/Stop button, message articles, loading state, chunked streaming, citation buttons, and actions toolbar, from a small real WebSocket server (`__fixtures__/fake-chathub.ts`) that stands in for the ChatHub, since Playwright reports frames only for real sockets. The tests press Enter themselves; the adapter never does.

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

### What an export reads

`listExportRecords(filter)` returns everything an export includes, in Test # order: every matching trial, successful or failed (with its failure), and every matching active expert answer with its expert. Superseded answers are never exported. The `RecordFilter` (`src/shared/export.ts`) narrows it; a null field means no limit:

| Field | Keeps |
| --- | --- |
| `sessionId` | trials from that session, and expert answers entered during it |
| `from`, `to` | records from `from` (inclusive) up to `to` (exclusive), as ISO 8601 UTC. A trial is placed by its begin time, or by its session's start if it failed before beginning; an expert answer by when it was entered |
| `subject` | one subject's trials, or `'EXPERT'` for only the expert's answers |

### Exporting

The Export Page calls `window.harness.exportLog(request)` on the `export:run` channel. An `ExportRequest` (`src/shared/export.ts`) is a `RecordFilter` plus a format: `TESTLOG_V3_XLSX` or `CSV`. `ExportService` (`src/main/data/export-service.ts`) then, following SD-6:

1. reads the matching records with `listExportRecords`;
2. if there are none, stops with `NOTHING_TO_EXPORT` before asking for a location (UC-6 E1);
3. opens the save dialog, suggesting `TestLog-<local date>.xlsx` (or `.csv`) in Documents, and stops with `CANCELLED` if the Tester closes it;
4. maps the records to rows and hands them to the writer for the format;
5. returns `EXPORTED` with the files written and the row count, or `WRITE_FAILED` with a message to show when the file cannot be written, for example because it is open in Excel (UC-6 E2). The Tester can export again and choose another location.

An export only reads the database, so no outcome changes a stored record. The `ExportResult` carries `ok`, `status`, `filePaths`, `rowCount`, and `error`.

Two more channels serve the Export Page before it exports:

- `sessions:list` (`window.harness.listSessions()`) returns every saved session, newest first, for the Session dropdown.
- `export:preview` (`window.harness.previewExport(filter)`) returns how many trials and expert answers the filter matches (`ExportPreview`). `ExportService.preview` counts with the same `listExportRecords` query the export runs, so the count on the page always equals the rows written, superseded answers left out.

### The Export Page

The Export tab (story #40) follows the design's "06 Export Page":

- **Records to export.** Filter by **Session** (the running session is chosen until the Tester picks another) or by **Date range** (whole local days, both included), and optionally one subject or only the expert's answers. The line below gives the count from `export:preview`. Export is disabled when nothing matches or the range is backwards.
- **Format.** The TestLogV3 workbook or CSV. **Export…** opens the save dialog.
- **Result.** "Exported N rows" with every file written (both files for CSV), or the reason nothing was written. Closing the save dialog shows nothing.
- **Saves waiting for a retry.** When the error log holds failed saves, a warning above the filters lists them and offers Retry, because those records are not in any export until they reach the database.

The sessions, the count, and the waiting saves are read again each time the tab is opened, so trials saved since the last visit are included.

### Export rows

`toExportRows(records)` (`src/main/data/export-rows.ts`) turns each record into a row of the TestLogV3 sheet (`TestLogRow`, Tom's 11 columns in order) and a row of the supplementary sheet (`SupplementaryRow`, keyed by the same Test #). An empty cell is `null`.

| Column | Trial | Expert answer |
| --- | --- | --- |
| Test # | its Test # | its Test # |
| Question Number | the question | the question |
| Test Subject | the subject's UI label: `DOE Oracle`, `Microsoft Copilot`, `Google Search` | `Expert` |
| log data set name | as saved, for example `DOE_ORACLE-2026-11-14` | `EXPERT-` plus the UTC date of the first answer, or `EXPERT` until it is entered |
| Answer Text | the answer, empty if none | the answer |
| Response Milliseconds | total response time; **page-load time for Google** | the turnaround, on one row only (below) |
| User Email | the session ID (NFR-7) | the session the answer was entered in |
| Begin / End Timestamp | as captured; a failed trial keeps whatever it reached | outreach sent / first answer received, on one row only |
| Keywords | empty until the questions have keywords | the same |
| Size Kbytes | bytes / 1024, rounded to 2 decimals | the same |

The expert's turnaround goes on the row of their **lowest question number** in the export; their other rows leave Response Milliseconds and both timestamps empty. The supplementary row holds what TestLogV3 has no column for: time to first response, Google's page-load time and time to answer, the source URL, the citations joined with `; `, a failed trial's failure type, and the expert's response source (`EMAIL` or `INTERVIEW`).

### The TestLogV3 workbook

Each export format is a `LogWriter` (`src/main/data/log-writer.ts`): `write(main, extra, filePath)` writes the rows and returns the files it wrote. `TestLogV3Writer` (`src/main/data/testlog-v3-writer.ts`) writes an `.xlsx` with ExcelJS that matches Tom's `TestLogV3.xlsx`:

- The first sheet is named `Sheet1`, as in Tom's file. Row 1 and column A are empty, the 11 headers are in `B2:L2` exactly as Tom wrote them (including the trailing spaces in `Question Number ` and `Test Subject `), and data starts in row 3.
- Numbers stay numbers, timestamps are ISO 8601 UTC text, and empty values leave the cell empty. Size Kbytes is formatted with 2 decimals.
- The second sheet, `Supplementary`, uses the same `B2` layout with Test # first.

The headers live in one place, `TESTLOG_V3_HEADERS`, so the workbook and the CSV cannot drift apart.

### The CSV export

`CsvWriter` (`src/main/data/csv-writer.ts`) writes the same 11 columns, in the same order and with the same headers, to the chosen file (for example `TestLog-2026-11-14.csv`), and the supplementary columns to `TestLog-2026-11-14-supplementary.csv` beside it.

- Fields follow RFC 4180: a value with a comma, a double quote, or a line break is wrapped in double quotes, with its quotes doubled, so a long multi-line answer stays in one field. Empty values are empty fields.
- Text that starts with `-`, `=`, `+`, or `@` gets a `'` in front, so Excel keeps it as text instead of reading it as a formula (an answer starting with "- " would otherwise show as `#NAME?`). Numbers are never prefixed. The workbook needs no prefix: its cells are stored as text.
- Files are UTF-8 with a byte order mark, so Excel shows characters such as `·` and `é` correctly, and lines end with CRLF.
- The header row is the first line. A CSV has no cells, so the workbook's `B2` offset does not apply.
- Size Kbytes is written with 2 decimals, matching the workbook.

### Failed saves

If a save fails in the database itself (the disk is full, the file is locked or damaged), the record is not lost. `MetricsRepository` hands it to the `ErrorLog` (`src/main/data/error-log.ts`), which appends it as one JSON line to `pending-writes.jsonl`, next to `harness.db`. It is a file, not a table, because a SQLite write is what just failed. The save still throws, with a message saying the record was kept and can be retried, so the Tester sees it; the startup log also reports how many saves are waiting.

Each line is a `PendingWrite`: an `id`, the `operation` (`saveTrial`, `saveExpert`, or `saveExpertResponse`), its `payload`, the `error`, and `failedAt`. `ErrorLog.retry(id, repository)` runs one again and `retryAll(repository)` runs them all, oldest first; a write that succeeds is removed from the file, and one that fails again stays with its new error. Retrying gives a trial or expert answer the next Test # at that time.

The renderer reaches the log through two channels: `errors:list` (`window.harness.listFailedWrites()`) returns a short summary of each waiting save (id, operation, a description such as "DOE Oracle trial, question 3", the error, and when it failed), and `errors:retry` (`window.harness.retryFailedWrites()`) retries them all and resolves with how many succeeded. The Export Page (E6) uses them for its Retry button.

Failures the data itself causes are not kept, because a retry would fail the same way: constraint violations such as a duplicate id, a FAILED trial without its failure, or an answer to a question that already has one (`ActiveAnswerExistsError`).

### Startup check

At startup the main process opens an in-memory SQLite database through better-sqlite3 and reads the SQLite version. The result is logged (`[sqlite] better-sqlite3 loaded, SQLite version 3.x.y`) and shown in the window under "Storage". If the native module cannot be loaded, the window shows a red "SQLite failed to load" box with the error text instead, so a broken install is obvious. No tables are created and nothing is stored.

better-sqlite3 13 uses Node-API and ships prebuilt binaries inside the npm package (Windows x64 and arm64, macOS, Linux). Nothing compiles on `npm install` and nothing is rebuilt for Electron.

## Packaging the Windows installer

`npm run dist:win` on Windows builds the app and produces `release/DOE Oracle Test Harness-<version>-x64.msi` with electron-builder. The first run downloads the WiX toolset into electron-builder's cache and Chromium into `.browser-bundle/`. The installer is per-user and shows a short wizard. It installs to `%LOCALAPPDATA%\Programs\DOE Oracle Test Harness`.

Whether it needs administrator rights is only partly known:

- Tested on Windows 11 (MSI 0.2.21): an account in the Administrators group, with UAC at its defaults, got no elevation prompt at install or at uninstall.
- Not tested: a standard user account. Until someone installs with one, do not assume it works without an administrator.
- The Apps entry is registered under `HKEY_LOCAL_MACHINE`, not `HKEY_CURRENT_USER`, on that Windows 11 machine and on the CI runner.

The MSI is the only thing a Tester installs for the harness. It contains the app, `config/questions.json`, the SQLite native module, and the browser.

The app icon lives in `build-resources/`: `icon.png` (512 px) is the source and `icon.ico` (16 to 256 px frames) is what Windows uses. The MSI cannot be built without an icon, because electron-builder's installer template always references one for the shortcuts. To rebrand, replace both files.

### The bundled browser

`scripts/bundle-browser.mjs` (`npm run bundle:browser`) runs Playwright's own installer for the Chromium build the installed Playwright version pins, into `harness/.browser-bundle/`, and writes `browser.json` there: the Playwright version, the build's revision and version, the path of the executable, and the platform and architecture it was fetched for (checked when the installed app starts a browser; see "Browser automation"). Only the headed build is fetched, because that is the only one the app launches; the headless shell is used by the unit tests alone. The script never reads or changes Playwright's cache in your user folder.

electron-builder ships `browser.json` and the `chromium-<revision>` folder as `resources/browser/`. Playwright's ffmpeg and winldd are left out: they record video and check installs, which the harness does not do.

The build Playwright 1.65 pins is Google's Chrome for Testing 158. It ships exactly as downloaded, with its `ABOUT` notice file; its full credits and terms are inside the browser at `chrome://credits` and `chrome://terms`. **The installer includes Chrome for Testing and is for the team and the sponsor only. Do not publish it.**

With the browser, the MSI is about 300 MB (it was about 135 MB without it). The installed program folder is 855.1 MB, measured on Windows 11 with MSI 0.2.21. Settings, Apps reports about 1.13 GB for that same install. We have not found out where the difference comes from.

### Versions

`package.json` holds the major and minor version: `0.2` until the final build, which is `1.0`. The `harness-msi` workflow sets the patch to its run number, so an MSI from CI is, for example, `0.2.57`, and no two CI builds share a version. A local `dist:win` or `dist:dir` build keeps the `.0` from `package.json`.

So a local build is always `0.2.0`, which is lower than every CI build (`0.2.N`). Two things follow:

- A locally built MSI will not install over a CI build: Windows refuses it as older (see "Installing over an older version"). Uninstall the CI build first.
- Every development session, under `npm run dev` or from a local build, is recorded as `0.2.0`. The `app_version` column tells CI builds apart, not development sessions.

The version shows in the window under "App info", in the MSI's file name, in Settings, Apps, and in the `app_version` column of the `sessions` table, so every saved session records which build produced it.

### Installing over an older version

Installing a newer MSI over an older one upgrades in place: Windows removes the old program files and installs the new ones, and everything in the per-user data folder stays. The database is migrated forward the first time the new version opens it.

Installing an older MSI over a newer one is refused with "A newer version is already installed". To go back, uninstall first. Do not open a database from a newer version with an older one: the older code does not check for a newer schema. Move or delete the data folder (below) before going back.

### What uninstall leaves behind

Uninstalling from Settings, Apps removes the program folder (the app and its Chromium), the Start menu and desktop shortcuts, and the Apps entry.

It keeps the per-user data folder, `%APPDATA%\DOE Oracle Test Harness`, so results survive a reinstall or an upgrade:

| Kept | What it is |
| --- | --- |
| `harness.db` (and `harness.db-wal`, `harness.db-shm`) | every saved session, trial, and expert answer |
| `pending-writes.jsonl` | saves that failed and wait for a retry, if any |
| `browser-profiles\copilot` | the Copilot browser profile |
| `self-check\report.json` | the last self-check report, if one was run |
| everything else | Electron's own cache and settings |

Exports are wherever the Tester saved them, Documents by default, and are never removed.

For a true clean start, uninstall, then delete the data folder. In PowerShell:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\DOE Oracle Test Harness"
```

This deletes every saved result and the Copilot sign-in. Export first if the data matters.

### The self-check

Running the app with `--self-check` runs three start-up checks without opening the window, writes a report, and exits:

| Check | Passes when |
| --- | --- |
| `questions` | `config/questions.json` loads from where the app looks for it, with all 12 questions |
| `sqlite` | better-sqlite3 loads, and a scratch database (`self-check.db`) opens in the per-user data folder through `MetricsRepository`, migrations included; it is removed afterwards |
| `browser` | the Chromium a trial would use launches headed through `BrowserManager`, both as the shared browser and on a scratch profile, opens a page, and is the version `browser.json` pins |

The exit code is 0 when every check passed, 1 when one failed, and 2 when the checks were not done within 3 minutes. The report is `self-check\report.json` in the per-user data folder, or the file given with `--self-check-out=<file>`. It is a file because a packaged Electron app on Windows prints nothing to the console that started it.

```powershell
& "$env:LOCALAPPDATA\Programs\DOE Oracle Test Harness\DOE Oracle Test Harness.exe" --self-check | Out-Null
Get-Content "$env:APPDATA\DOE Oracle Test Harness\self-check\report.json"
```

The self-check never opens `harness.db` or the Copilot profile, and it contacts no site: its pages are `about:blank` and one set from a string. Without the flag the app starts exactly as it always does. The code is in `src/main/self-check/`.

#### Closing the browser

The self-check closes every Chromium it started before it exits, whichever way the run ends, so no `chrome.exe` is left running from the program folder to lock files against the next uninstall or reinstall:

- A check that passes its own limit (120 seconds for `browser`) is recorded as failed, and what it started is closed before the next check runs.
- When the 3 minutes pass with a check still going, everything is closed before the report is written.
- A browser launch that is still under way at either limit is waited for and then closed. Playwright cannot cancel a launch, so each self-check launch gets 90 seconds, after which Playwright ends the browser process itself. That is about four times the slowest browser check seen on the CI runner (21.4 seconds for both launches, on the first run).

Closing has a limit of its own, 105 seconds. In the worst case the app therefore exits 4 minutes 45 seconds after it started. If closing does not finish, the run fails and the report says why. The report's `cleanup` field records the outcome: `{ "ok": true, "problem": null }` when everything was closed. The `browser` check's detail also gives the time each launch took.

Measured before this was added, by forcing timeouts with the flags below: no browser process outlived the app. On the Windows CI runner, with the timeout forced mid-launch, nothing was running from the program folder once the app had exited. On macOS, across six forced runs, one browser process was still alive at the moment of exit and gone within 2 seconds, and the scratch profile folder was left behind twice. So a leftover `chrome.exe` had not been seen in practice. The explicit close makes it something the app does and reports, not a side effect of how Playwright shuts down.

#### Flags for testing the self-check

Two more flags exist only to test the timeout paths on a packaged build. They do nothing without `--self-check`, so they cannot change a normal launch:

| Flag | Effect |
| --- | --- |
| `--self-check-browser-timeout-ms=<n>` | The `browser` check's limit, instead of 120000. With `1` the check always times out while its first launch is under way. |
| `--self-check-deadline-ms=<n>` | The limit for all checks together, instead of 180000. |

A value that is not a whole number of milliseconds, 1 or more, is ignored.

### Continuous integration

The `harness-msi` workflow builds the MSI on `windows-latest` and then tests it on that runner, a clean machine with no Playwright cache and no development setup. `scripts/msi-smoke-test.ps1` does the work:

1. Installs the MSI silently (`msiexec /i ... /qn`) and checks the program files, the bundled browser, the shortcuts, and the Apps entry are there.
2. Runs the installed app with `--self-check`, with a time limit, and fails unless the report shows all three checks passed, from the installed copy, at the expected version. Then runs it again with `--self-check-browser-timeout-ms=1`, so the browser check times out mid-launch, and fails unless the app exits by itself with code 1, its report says it closed everything it started, and nothing is left running from the program folder.
3. Uninstalls silently (`msiexec /x ... /qn`) and checks the program folder, shortcuts, and Apps entry are gone and the per-user data folder is still there.

The MSI is attached to the run as the artifact `doe-oracle-test-harness-msi` only when all three steps pass. When one fails, the msiexec logs and the self-check reports are attached as `harness-msi-smoke-logs` instead.

The workflow runs:

- on every push to `main` that touches the harness;
- on pull requests that change the packaging setup (`electron-builder.yml`, `electron.vite.config.ts`, `tsconfig*.json`, `package.json`, the lockfile, `.nvmrc`, `scripts/`), what ships beside the app (`config/`, `build-resources/`), or the main process and the code it shares with the UI (`src/main/`, `src/shared/`). All of `src/main` counts, not only what the self-check calls: it is built into one file that the installed app runs from the top before the self-check starts. A pull request that changes only the renderer or the preload script does not run it;
- by hand, for any branch: in the Actions tab pick `harness-msi`, click **Run workflow**, and choose the branch, or run `gh workflow run harness-msi --ref <branch>`.

It is not a required check, so it never blocks a merge by itself.

The runner is Windows Server, not Windows 11, and it cannot sign in to Copilot or run a trial. A person still tests each MSI that matters on Windows 11 with `docs/install-test.md`.

The same script runs on any Windows machine that does not have the harness installed:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\msi-smoke-test.ps1 -MsiPath "C:\path\to\DOE Oracle Test Harness-0.2.57-x64.msi"
```

### Trying a CI build on Windows 11

1. Open the repository's Actions tab, pick the `harness-msi` run for the branch or pull request, and download the `doe-oracle-test-harness-msi` artifact.
2. Extract the zip and run the `.msi` inside. Windows SmartScreen may warn because the installer is unsigned; choose "More info" and "Run anyway".
3. Launch "DOE Oracle Test Harness" from the Start menu or the desktop shortcut.
4. Check that the window shows the app name and version under "App info" and a green "SQLite ... loaded" line under "Storage". A red "SQLite failed to load" box means the native module did not survive packaging; copy its text into an issue.

`docs/install-test.md` is the full checklist. To remove the app, uninstall "DOE Oracle Test Harness" from Settings, Apps.

On macOS, `npm run dist:dir` produces an unpacked `.app` under `release/` for a quick check of the packaged build, with the macOS build of the same Chromium inside. It is only for local testing. `"release/mac-arm64/DOE Oracle Test Harness.app/Contents/MacOS/DOE Oracle Test Harness" --self-check` runs the self-check against it.

## Troubleshooting

- `npm run dev` opens no window: check the terminal for a bundling error, then confirm `node -v` matches `.nvmrc`.
- Electron failed to download during `npm install`: re-run `npm install`; if you are behind a proxy, set `HTTPS_PROXY`.
- macOS shows a blank window on first launch: wait a moment, the window is shown once the renderer is ready.
- The installed app says "The browser that ships with the harness is missing or damaged": something removed or blocked files under `resources\browser` in the program folder. Reinstall from the MSI. If it happens again, check whether antivirus quarantined `chrome.exe`.
- The installed app says "The browser in this installer was built for ...": the MSI was packaged with a browser for another platform. Reinstalling the same MSI will not help. Build or download the MSI again from a `harness-msi` run.
- The installed app says "Could not open the Microsoft Copilot profile at ...": the profile folder, `%APPDATA%\DOE Oracle Test Harness\browser-profiles\copilot`, may be damaged. Close the harness, rename that folder (or delete it), and start the harness again. You will need to sign in to Copilot again. Reinstalling does not help, because uninstall keeps that folder.
