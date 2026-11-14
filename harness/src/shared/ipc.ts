import type { CopilotSignInStatus } from './copilot'
import type { Session } from './session'
import type { Subject } from './subjects'
import type { Trial, TrialEvent } from './trials'

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
  'session:get': { args: []; result: Session }
  'trial:start': { args: [subject: Subject, questionNumber: number]; result: Trial }
  'trial:confirm': { args: [trialId: string, endMs?: number]; result: void }
  'trial:cancel': { args: [trialId: string]; result: void }
  'trials:list': { args: [sessionId?: string]; result: Trial[] }
  'copilot:open-sign-in': { args: []; result: CopilotSignInStatus }
}

export type IpcChannel = keyof IpcContracts
export type IpcArgs<C extends IpcChannel> = IpcContracts[C]['args']
export type IpcResult<C extends IpcChannel> = IpcContracts[C]['result']

/** Named channel constants so call sites never repeat the string. */
export const IpcChannels = {
  getAppInfo: 'app:get-info',
  getSqliteStatus: 'diagnostics:get-sqlite-status',
  getSession: 'session:get',
  startTrial: 'trial:start',
  confirmCompletion: 'trial:confirm',
  cancelTrial: 'trial:cancel',
  listTrials: 'trials:list',
  openCopilotSignIn: 'copilot:open-sign-in',
} as const satisfies Record<string, IpcChannel>

/**
 * Events the main process pushes to the renderer without being asked.
 * The payload type is what the renderer's listener receives.
 */
export interface IpcEvents {
  'trial:event': TrialEvent
}

export type IpcEventChannel = keyof IpcEvents
export type IpcEventPayload<C extends IpcEventChannel> = IpcEvents[C]

export const IpcEventChannels = {
  trialEvent: 'trial:event',
} as const satisfies Record<string, IpcEventChannel>

/** Returned by every subscription; call it to stop listening. */
export type Unsubscribe = () => void

/** The property name the preload script exposes on `window`. */
export const HARNESS_API_KEY = 'harness' as const

/** What the renderer sees as `window.harness`. */
export interface HarnessApi {
  /** Returns the app name and version from the main process. */
  getAppInfo(): Promise<AppInfo>
  /** Returns the result of the SQLite startup probe. */
  getSqliteStatus(): Promise<SqliteStatus>
  /** Returns this launch's session: its ID, start time, and the harness version. */
  getSession(): Promise<Session>
  /** Runs one trial of a question against a subject and resolves with the saved trial. */
  startTrial(subject: Subject, questionNumber: number): Promise<Trial>
  /**
   * Confirms the end of a trial that is awaiting confirmation, keeping the
   * detected end or replacing it with endMs (epoch milliseconds). The trial
   * is then captured and saved; startTrial's promise delivers the record.
   */
  confirmCompletion(trialId: string, endMs?: number): Promise<void>
  /** Ends the running trial without saving it. startTrial's promise then rejects. */
  cancelTrial(trialId: string): Promise<void>
  /** Lists saved trials, newest first, for one session or for all sessions. */
  listTrials(sessionId?: string): Promise<Trial[]>
  /**
   * Brings the Copilot window to the front on the chat page so the Tester
   * can sign in there, and reports whether the chat is usable. The harness
   * never signs in itself.
   */
  openCopilotSignIn(): Promise<CopilotSignInStatus>
  /** Receives the running trial's status events. Returns the function that unsubscribes. */
  onTrialEvent(callback: (event: TrialEvent) => void): Unsubscribe
}
