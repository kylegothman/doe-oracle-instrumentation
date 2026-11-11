import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IpcChannels } from '../shared/ipc'
import { logSqliteStatus, probeSqlite } from './data/sqlite'
import { createGetAppInfoHandler } from './execution/handlers/app-info'
import { createGetSqliteStatusHandler } from './execution/handlers/sqlite-status'
import { IpcRouter } from './execution/ipc-router'

function registerIpcHandlers(): IpcRouter {
  // Probe once at startup. The handler reports this same result to the
  // renderer, so a broken native module shows up in the window.
  const sqliteStatus = probeSqlite()
  void sqliteStatus.then(logSqliteStatus)

  const router = new IpcRouter(ipcMain)
  router.register(IpcChannels.getAppInfo, createGetAppInfoHandler(app))
  router.register(IpcChannels.getSqliteStatus, createGetSqliteStatusHandler(sqliteStatus))
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

void app.whenReady().then(() => {
  registerIpcHandlers()
  createMainWindow()

  app.on('activate', () => {
    // macOS re-creates the window when the dock icon is clicked with no windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // On Windows and Linux the app quits when its last window closes.
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
