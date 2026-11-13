import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  HARNESS_API_KEY,
  IpcChannels,
  IpcEventChannels,
  type HarnessApi,
  type IpcArgs,
  type IpcChannel,
  type IpcResult,
} from '../shared/ipc'
import type { TrialEvent } from '../shared/trials'

/**
 * Preload script. It runs in the renderer's isolated world before any page
 * script and is the only code that may touch Electron on the renderer's
 * behalf. Everything the page can do lives on the single `window.harness`
 * object below, typed by the shared contract.
 */

function invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<C>>
}

const harnessApi: HarnessApi = {
  getAppInfo: () => invoke(IpcChannels.getAppInfo),
  getSqliteStatus: () => invoke(IpcChannels.getSqliteStatus),
  getSession: () => invoke(IpcChannels.getSession),
  startTrial: (subject, questionNumber) => invoke(IpcChannels.startTrial, subject, questionNumber),
  listTrials: (sessionId) =>
    sessionId === undefined ? invoke(IpcChannels.listTrials) : invoke(IpcChannels.listTrials, sessionId),
  onTrialEvent: (callback) => {
    // Only the payload reaches the page; the Electron event object stays in the preload.
    const listener = (_event: IpcRendererEvent, event: TrialEvent): void => callback(event)
    ipcRenderer.on(IpcEventChannels.trialEvent, listener)
    return () => {
      ipcRenderer.removeListener(IpcEventChannels.trialEvent, listener)
    }
  },
}

contextBridge.exposeInMainWorld(HARNESS_API_KEY, harnessApi)
