import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '../../shared/ipc'
import { createGetAppInfoHandler } from './handlers/app-info'
import { IpcRouter, type IpcMainLike } from './ipc-router'

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/** A stand-in for ipcMain that records handlers and lets a test invoke them. */
function createFakeIpcMain() {
  const listeners = new Map<string, Listener>()
  const ipcMain: IpcMainLike = {
    handle: vi.fn((channel: string, listener: Listener) => {
      listeners.set(channel, listener)
    }),
    removeHandler: vi.fn((channel: string) => {
      listeners.delete(channel)
    }),
  }
  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const listener = listeners.get(channel)
    if (!listener) {
      throw new Error(`No handler registered for "${channel}"`)
    }
    return listener({} as IpcMainInvokeEvent, ...args)
  }
  return { ipcMain, listeners, invoke }
}

describe('IpcRouter', () => {
  it('registers a handler with ipcMain.handle under the channel name', () => {
    const { ipcMain, listeners } = createFakeIpcMain()
    const router = new IpcRouter(ipcMain)

    router.register(IpcChannels.getAppInfo, () => ({ name: 'n', version: 'v' }))

    expect(ipcMain.handle).toHaveBeenCalledTimes(1)
    expect(listeners.has('app:get-info')).toBe(true)
    expect(router.channels).toEqual(['app:get-info'])
  })

  it('answers an invoke on app:get-info with the app name and version', async () => {
    const { ipcMain, invoke } = createFakeIpcMain()
    const router = new IpcRouter(ipcMain)
    router.register(
      IpcChannels.getAppInfo,
      createGetAppInfoHandler({
        getName: () => 'DOE Oracle Test Harness',
        getVersion: () => '0.1.0',
      }),
    )

    await expect(invoke('app:get-info')).resolves.toEqual({
      name: 'DOE Oracle Test Harness',
      version: '0.1.0',
    })
  })

  it('refuses to register the same channel twice', () => {
    const { ipcMain } = createFakeIpcMain()
    const router = new IpcRouter(ipcMain)
    router.register(IpcChannels.getAppInfo, () => ({ name: 'n', version: 'v' }))

    expect(() => router.register(IpcChannels.getAppInfo, () => ({ name: 'n', version: 'v' }))).toThrow(
      /already registered/,
    )
    expect(ipcMain.handle).toHaveBeenCalledTimes(1)
  })

  it('removes every handler on dispose', () => {
    const { ipcMain, listeners } = createFakeIpcMain()
    const router = new IpcRouter(ipcMain)
    router.register(IpcChannels.getAppInfo, () => ({ name: 'n', version: 'v' }))

    router.dispose()

    expect(ipcMain.removeHandler).toHaveBeenCalledWith('app:get-info')
    expect(listeners.size).toBe(0)
    expect(router.channels).toEqual([])
  })
})
