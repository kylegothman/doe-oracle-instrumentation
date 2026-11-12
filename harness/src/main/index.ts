import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IpcChannels } from '../shared/ipc'
import { Subject } from '../shared/subjects'
import { OracleAdapter } from './adapters/oracle-adapter'
import type { SubjectAdapter } from './adapters/subject-adapter'
import { BrowserManager } from './browser/browser-manager'
import { loadSettings } from './config/settings'
import { MetricsRepository } from './data/metrics-repository'
import { logSqliteStatus, probeSqlite } from './data/sqlite'
import { createGetAppInfoHandler } from './execution/handlers/app-info'
import { createGetSessionHandler } from './execution/handlers/session'
import { createGetSqliteStatusHandler } from './execution/handlers/sqlite-status'
import { createListTrialsHandler, createStartTrialHandler } from './execution/handlers/trials'
import { IpcRouter } from './execution/ipc-router'
import { SessionManager } from './execution/session-manager'
import { TimingService } from './execution/timing-service'
import { TrialController } from './execution/trial-controller'

/** The one Chromium instance the harness drives. Launched on first use, closed on quit. */
const browserManager = new BrowserManager()

/** Opens harness.db under the per-user app data folder and applies migrations. */
async function openRepository(): Promise<MetricsRepository> {
  const filePath = join(app.getPath('userData'), 'harness.db')
  const repository = await MetricsRepository.open(filePath)
  console.log(`[data] Opened ${filePath} (schema version ${repository.schemaVersion})`)
  return repository
}

function registerIpcHandlers(repositoryReady: Promise<MetricsRepository>): IpcRouter {
  // Probe once at startup. The handler reports this same result to the
  // renderer, so a broken native module shows up in the window.
  const sqliteStatus = probeSqlite()
  void sqliteStatus.then(logSqliteStatus)

  const settings = loadSettings()
  // One adapter per subject, each driving its own page in the shared Chromium.
  // TODO(#5, #6): register the Copilot and Google adapters here.
  const adapters = new Map<Subject, SubjectAdapter>([
    [Subject.DOE_ORACLE, new OracleAdapter(browserManager, settings.oracle)],
  ])
  // One session per launch, started as soon as the database is open so it
  // is saved before any trial can reference it.
  const sessionReady = repositoryReady.then((repository) => {
    const session = new SessionManager({ store: repository, appVersion: app.getVersion() })
    const started = session.startSession()
    console.log(`[session] ${started.sessionId} started ${started.startedAt} (harness ${started.appVersion})`)
    return session
  })
  const controllerReady = Promise.all([repositoryReady, sessionReady]).then(
    ([repository, session]) => new TrialController({ adapters, timing: new TimingService(), repository, session }),
  )

  const router = new IpcRouter(ipcMain)
  router.register(IpcChannels.getAppInfo, createGetAppInfoHandler(app))
  router.register(IpcChannels.getSqliteStatus, createGetSqliteStatusHandler(sqliteStatus))
  router.register(IpcChannels.getSession, createGetSessionHandler(() => sessionReady))
  router.register(IpcChannels.startTrial, createStartTrialHandler(() => controllerReady))
  router.register(IpcChannels.listTrials, createListTrialsHandler(() => repositoryReady))
  return router
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1024,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    title: app.getName(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security baseline for every window in the harness. The renderer never
      // gets Node access; it talks to the main process through the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  // The harness never opens new windows from page navigation.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // electron-vite serves the renderer from its dev server during `npm run dev`
  // and sets ELECTRON_RENDERER_URL. Packaged builds load the built index.html.
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

let repositoryReady: Promise<MetricsRepository> | null = null

void app.whenReady().then(() => {
  repositoryReady = openRepository()
  repositoryReady.catch((error: unknown) => {
    console.error(`[data] ${error instanceof Error ? error.message : String(error)}`)
  })
  registerIpcHandlers(repositoryReady)
  createMainWindow()

  app.on('activate', () => {
    // macOS re-creates the window when the dock icon is clicked with no windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

let shuttingDown = false
app.on('before-quit', (event) => {
  // Close Chromium and the database before Electron exits.
  if (shuttingDown) {
    return
  }
  event.preventDefault()
  shuttingDown = true
  void (async () => {
    try {
      await browserManager.close()
      const repository = await repositoryReady?.catch(() => null)
      repository?.close()
    } finally {
      app.quit()
    }
  })()
})

app.on('window-all-closed', () => {
  // On Windows and Linux the app quits when its last window closes.
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
