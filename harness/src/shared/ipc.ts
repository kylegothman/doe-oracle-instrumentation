import type { Subject } from './subjects'
import type { Trial } from './trials'

/**
 * The contract between the renderer and the main process.
 *
 * This file is imported by all three sides: the main process registers a
 * handler per channel, the preload script forwards calls over ipcRenderer,
 * and the renderer calls the typed `window.harness` object. Keeping every
 * channel's argument and result types here means the three cannot drift.
 *
 * Only plain, structured-cloneable data may cross the bridge. No Node or
 * Electron types belong in this file.
 */

/** Identity of the running app, as reported by the main process. */
export interface AppInfo {
  /** Product name, for example "DOE Oracle Test Harness". */
  name: string
  /** Version from harness/package.json. */
  version: string
}

/**
 * Result of the SQLite startup probe. The main process opens an in-memory
 * database through better-sqlite3 once at startup; this tells the renderer
 * whether the native module loaded, so a broken install is visible on screen.
 */
export type SqliteStatus =
  | { ok: true; version: string }
  | { ok: false; error: string }

/**
 * Request and response shape for every IPC channel. Add a new channel here
 * first; the compiler then points at the handler and the bridge to update.
 */
export interface IpcContracts {
  'app:get-info': { args: []; result: AppInfo }
  'diagnostics:get-sqlite-status': { args: []; result: SqliteStatus }
  'trial:start': { args: [subject: Subject, questionNumber: number]; result: Trial }
  'trials:list': { args: [sessionId?: string]; result: Trial[] }
}

export type IpcChannel = keyof IpcContracts
export type IpcArgs<C extends IpcChannel> = IpcContracts[C]['args']
export type IpcResult<C extends IpcChannel> = IpcContracts[C]['result']

/** Named channel constants so call sites never repeat the string. */
export const IpcChannels = {
  getAppInfo: 'app:get-info',
  getSqliteStatus: 'diagnostics:get-sqlite-status',
  startTrial: 'trial:start',
  listTrials: 'trials:list',
} as const satisfies Record<string, IpcChannel>

/** The property name the preload script exposes on `window`. */
export const HARNESS_API_KEY = 'harness' as const

/** What the renderer sees as `window.harness`. */
export interface HarnessApi {
  /** Returns the app name and version from the main process. */
  getAppInfo(): Promise<AppInfo>
  /** Returns the result of the SQLite startup probe. */
  getSqliteStatus(): Promise<SqliteStatus>
  /** Runs one trial of a question against a subject and resolves with the saved trial. */
  startTrial(subject: Subject, questionNumber: number): Promise<Trial>
  /** Lists saved trials, newest first, for one session or for all sessions. */
  listTrials(sessionId?: string): Promise<Trial[]>
}
