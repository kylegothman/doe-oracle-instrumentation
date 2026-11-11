# DOE Oracle Test Harness

Windows 11 desktop app that measures the DOE Oracle, Microsoft Copilot, and Google Search by asking each the same set of questions. This folder holds the harness only. The sponsor's DOE Oracle code lives at the repository root and is never modified by harness work.

Stack: Electron, React + TypeScript built by Vite through electron-vite, SQLite through better-sqlite3, ExcelJS for exports, Playwright for driving browsers, electron-builder for the MSI installer, Vitest and ESLint.

## Prerequisites

- Node.js 26 LTS. The exact version is in `.nvmrc`.
- npm 11 (bundled with Node 26).
- Git.

No C++ build tools are needed. Native modules used by the harness ship prebuilt binaries.

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
npm run dev
```

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
| `npm test` | Runs the Vitest unit tests once. |

Run `lint`, `typecheck`, `test`, and `build` before opening a pull request. Continuous integration runs the same four on Ubuntu and Windows.

## Project layout

```
harness/
  electron.vite.config.ts   bundling for main, preload, and renderer
  eslint.config.mjs         lint rules (the renderer may not import Electron or Node)
  vitest.config.ts          unit test settings
  tsconfig.node.json        TypeScript for main, preload, shared
  tsconfig.web.json         TypeScript for renderer, shared
  src/
    main/                   Electron main process (Node)
      index.ts              app lifecycle and window creation
      execution/            test run orchestration and IPC routing
      adapters/             one adapter per system under test
      browser/              browser automation
      data/                 SQLite storage and exports
    preload/                contextBridge script that exposes window.harness
    renderer/               React UI (browser only, no Node access)
    shared/                 types shared by main, preload, and renderer
  out/                      build output (ignored by git)
```

## Security baseline

Every window is created with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. The renderer talks to the main process only through the typed bridge the preload script exposes on `window`. ESLint rejects any `electron` or Node built-in import under `src/renderer`.

## Troubleshooting

- `npm run dev` opens no window: check the terminal for a bundling error, then confirm `node -v` matches `.nvmrc`.
- Electron failed to download during `npm install`: re-run `npm install`; if you are behind a proxy, set `HTTPS_PROXY`.
- macOS shows a blank window on first launch: wait a moment, the window is shown once the renderer is ready.
