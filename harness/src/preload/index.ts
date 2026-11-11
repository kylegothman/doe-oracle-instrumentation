import { contextBridge, ipcRenderer } from 'electron'
import {
  HARNESS_API_KEY,
  IpcChannels,
  type HarnessApi,
  type IpcArgs,
  type IpcChannel,
  type IpcResult,
} from '../shared/ipc'

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
}

contextBridge.exposeInMainWorld(HARNESS_API_KEY, harnessApi)
