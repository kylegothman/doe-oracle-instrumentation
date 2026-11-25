import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { ExportFormat } from '../shared/export'
import { IpcChannels } from '../shared/ipc'
import { Subject } from '../shared/subjects'
import { CopilotAdapter } from './adapters/copilot-adapter'
import { GoogleAdapter } from './adapters/google-adapter'
import { OracleAdapter } from './adapters/oracle-adapter'
import type { SubjectAdapter } from './adapters/subject-adapter'
import { resolveBrowserLocation, type BrowserLocation } from './browser/browser-location'
import { BrowserManager } from './browser/browser-manager'
import { loadSettings } from './config/settings'
import { CsvWriter } from './data/csv-writer'
import { ErrorLog } from './data/error-log'
import { EXPORT_EXTENSIONS, ExportService } from './data/export-service'
import type { LogWriter } from './data/log-writer'
import { MetricsRepository } from './data/metrics-repository'
import { TestLogV3Writer } from './data/testlog-v3-writer'
import { logSqliteStatus, probeSqlite } from './data/sqlite'
import { createGetAppInfoHandler } from './execution/handlers/app-info'
import { createOpenCopilotSignInHandler } from './execution/handlers/copilot'
import { createListFailedWritesHandler, createRetryFailedWritesHandler } from './execution/handlers/errors'
import {
  createListExpertAnswersHandler,
  createListExpertsHandler,
  createSaveExpertAnswerHandler,
  createSaveExpertHandler,
} from './execution/handlers/experts'
import { createExportHandler, createExportPreviewHandler } from './execution/handlers/export'
import { createGetTrialLimitsHandler, createListQuestionsHandler } from './execution/handlers/questions'
import { createGetSessionHandler, createListSessionsHandler } from './execution/handlers/session'
import { createGetSqliteStatusHandler } from './execution/handlers/sqlite-status'
import {
  createCancelTrialHandler,
  createConfirmCompletionHandler,
  createListTrialsHandler,
  createReadCopiedTextHandler,
  createReportNoAnswerHandler,
  createStartTrialHandler,
} from './execution/handlers/trials'
import { ExpertRecordService } from './execution/expert-record-service'
import { IpcRouter } from './execution/ipc-router'
import { QuestionBank } from './execution/question-bank'
import { SessionManager } from './execution/session-manager'
import { TimingService } from './execution/timing-service'
import { TrialController } from './execution/trial-controller'
import { runSelfCheckAndExit } from './self-check/run-self-check'
import { parseSelfCheckArgs } from './self-check/self-check'

/** The Chromium instances the harness drives. Created once Electron is ready, launched on first use, closed on quit. */
let browserManager: BrowserManager | null = null

/**
 * Subjects whose sign-in must survive a restart keep a browser profile under
 * the per-user app data folder, never in the repository. Copilot's is
 * browser-profiles/copilot; the harness only passes the path to Playwright.
 */
function createBrowserManager(): BrowserManager {
  return new BrowserManager({
    location: browserLocation(),
    profiles: {
      [Subject.COPILOT]: join(app.getPath('userData'), 'browser-profiles', 'copilot'),
    },
  })
}

/**
 * The Chromium the harness drives: the copy shipped under resources/browser
 * in the packaged app, Playwright's cache during development.
 */
function browserLocation(): BrowserLocation {
  return resolveBrowserLocation({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath })
}

/**
 * The 12 standard questions ship in config/questions.json: next to
 * package.json during development, under resources/ in the packaged app
 * (see extraResources in electron-builder.yml).
 */
function questionsConfigPath(): string {
  return join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'config', 'questions.json')
}

/** Saves that fail in the database are kept for retry in pending-writes.jsonl, next to harness.db. */
function openErrorLog(): ErrorLog {
  return new ErrorLog(join(app.getPath('userData'), 'pending-writes.jsonl'))
}

/** Opens harness.db under the per-user app data folder and applies migrations. */
async function openRepository(errorLog: ErrorLog): Promise<MetricsRepository> {
  const filePath = join(app.getPath('userData'), 'harness.db')
  const repository = await MetricsRepository.open(filePath, { errorLog })
  console.log(`[data] Opened ${filePath} (schema version ${repository.schemaVersion})`)
  const pending = errorLog.listPending().length
  if (pending > 0) console.warn(`[errors] ${pending} failed save(s) waiting for retry in ${errorLog.logPath}`)
  return repository
}

function registerIpcHandlers(repositoryReady: Promise<MetricsRepository>, browserManager: BrowserManager, errorLog: ErrorLog): IpcRouter {
  // Probe once at startup. The handler reports this same result to the
  // renderer, so a broken native module shows up in the window.
  const sqliteStatus = probeSqlite()
  void sqliteStatus.then(logSqliteStatus)

  const settings = loadSettings()
  // One adapter per subject, each driving its own page: the Oracle and
  // Google in separate contexts of the shared Chromium, Copilot on its
  // persistent profile. Google has no profile folder, so it is signed out
  // and its cookies are gone when the harness quits.
  const adapters = new Map<Subject, SubjectAdapter>([
    [Subject.DOE_ORACLE, new OracleAdapter(browserManager, settings.oracle)],
    [Subject.COPILOT, new CopilotAdapter(browserManager, settings.copilot)],
    [Subject.GOOGLE, new GoogleAdapter(browserManager, settings.google)],
  ])
  // One session per launch, started as soon as the database is open so it
  // is saved before any trial can reference it.
  const sessionReady = repositoryReady.then((repository) => {
    const session = new SessionManager({ store: repository, appVersion: app.getVersion() })
    const started = session.startSession()
    console.log(`[session] ${started.sessionId} started ${started.startedAt} (harness ${started.appVersion})`)
    return session
  })
  // Read once at startup; a bad file makes every trial:start report the problem.
  const questionsReady = Promise.resolve().then(() => QuestionBank.load(questionsConfigPath()))
  questionsReady.catch((error: unknown) => {
    console.error(`[questions] ${error instanceof Error ? error.message : String(error)}`)
  })

  const router = new IpcRouter(ipcMain, {
    eventTargets: () => BrowserWindow.getAllWindows().map((window) => window.webContents),
  })
  const controllerReady = Promise.all([repositoryReady, sessionReady, questionsReady]).then(
    ([repository, session, questions]) =>
      new TrialController({
        adapters,
        questions,
        timing: new TimingService(),
        repository,
        session,
        policies: settings.trialPolicies,
        events: router,
        // Read only when the Tester clicks Use Copied Text on Google's copy step.
        clipboard,
      }),
  )
  router.register(IpcChannels.getAppInfo, createGetAppInfoHandler(app))
  router.register(IpcChannels.getSqliteStatus, createGetSqliteStatusHandler(sqliteStatus))
  router.register(IpcChannels.getSession, createGetSessionHandler(() => sessionReady))
  router.register(IpcChannels.startTrial, createStartTrialHandler(() => controllerReady))
  router.register(IpcChannels.confirmCompletion, createConfirmCompletionHandler(() => controllerReady))
  router.register(IpcChannels.cancelTrial, createCancelTrialHandler(() => controllerReady))
  router.register(IpcChannels.reportNoAnswer, createReportNoAnswerHandler(() => controllerReady))
  router.register(IpcChannels.readCopiedText, createReadCopiedTextHandler(() => controllerReady))
  router.register(IpcChannels.listTrials, createListTrialsHandler(() => repositoryReady))
  router.register(IpcChannels.openCopilotSignIn, createOpenCopilotSignInHandler({ pages: browserManager, settings: settings.copilot }))
  router.register(IpcChannels.listFailedWrites, createListFailedWritesHandler(errorLog))
  router.register(IpcChannels.retryFailedWrites, createRetryFailedWritesHandler(errorLog, () => repositoryReady))
  const exportReady = repositoryReady.then(
    (repository) =>
      new ExportService({
        repository,
        writers: new Map<ExportFormat, LogWriter>([
          [ExportFormat.TESTLOG_V3_XLSX, new TestLogV3Writer()],
          [ExportFormat.CSV, new CsvWriter()],
        ]),
      }),
  )
  router.register(IpcChannels.exportLog, createExportHandler(() => exportReady, chooseSavePath))
  router.register(IpcChannels.previewExport, createExportPreviewHandler(() => exportReady))
  router.register(IpcChannels.listSessions, createListSessionsHandler(() => repositoryReady))
  router.register(IpcChannels.listQuestions, createListQuestionsHandler(() => questionsReady))
  router.register(IpcChannels.getTrialLimits, createGetTrialLimitsHandler(settings.trialPolicies))
  // The expert's record and answers (UC-5). An answer carries this launch's
  // session and must be to one of the standard questions, so the service
  // waits for all three, as the controller does.
  const expertsReady = Promise.all([repositoryReady, sessionReady, questionsReady]).then(
    ([repository, session, questions]) => new ExpertRecordService({ repository, session, questions }),
  )
  router.register(IpcChannels.listExperts, createListExpertsHandler(() => expertsReady))
  router.register(IpcChannels.saveExpert, createSaveExpertHandler(() => expertsReady))
  router.register(IpcChannels.listExpertAnswers, createListExpertAnswersHandler(() => expertsReady))
  router.register(IpcChannels.saveExpertAnswer, createSaveExpertAnswerHandler(() => expertsReady))
  return router
}

/**
 * The export's save dialog (UC-6): suggests a file name in Documents and
 * returns the chosen path, or null if the Tester cancelled.
 */
async function chooseSavePath(suggestedName: string, format: ExportFormat): Promise<string | null> {
  const options = {
    title: 'Export the test log',
    defaultPath: join(app.getPath('documents'), suggestedName),
    filters: [
      format === ExportFormat.CSV
        ? { name: 'CSV file', extensions: [EXPORT_EXTENSIONS[format]] }
        : { name: 'Excel workbook', extensions: [EXPORT_EXTENSIONS[format]] },
    ],
  }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1024,
    height: 720,
    // Below this the console's cards no longer fit; without a minimum the window can be dragged down to its title bar.
    minWidth: 900,
    minHeight: 600,
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

// `--self-check` runs the start-up checks and exits instead of opening the
// harness (see self-check/self-check.ts). Without the flag nothing changes.
const selfCheck = parseSelfCheckArgs(process.argv)

void app.whenReady().then(() => {
  if (selfCheck.enabled) {
    void runSelfCheckAndExit({ app, args: selfCheck, questionsPath: questionsConfigPath(), location: browserLocation() })
    return
  }
  browserManager = createBrowserManager()
  const errorLog = openErrorLog()
  repositoryReady = openRepository(errorLog)
  repositoryReady.catch((error: unknown) => {
    console.error(`[data] ${error instanceof Error ? error.message : String(error)}`)
  })
  registerIpcHandlers(repositoryReady, browserManager, errorLog)
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
      await browserManager?.close()
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
