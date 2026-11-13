import type { IpcMainInvokeEvent } from 'electron'
import {
  IpcEventChannels,
  type IpcArgs,
  type IpcChannel,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcResult,
} from '../../shared/ipc'
import type { TrialEvent } from '../../shared/trials'

/**
 * The slice of Electron's `ipcMain` the router needs. It is injected so the
 * router can be unit tested without loading Electron.
 */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void
  removeHandler(channel: string): void
}

/** The slice of a window's `webContents` that events are sent to. */
export interface IpcEventTarget {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

export interface IpcRouterOptions {
  /** The windows that receive pushed events, looked up at send time. */
  eventTargets?: () => IpcEventTarget[]
}

/** A handler for one channel. Its arguments and result come from the shared contract. */
export type IpcHandler<C extends IpcChannel> = (
  ...args: IpcArgs<C>
) => IpcResult<C> | Promise<IpcResult<C>>

/**
 * Registers request handlers with `ipcMain.handle`, one per channel in the
 * shared contract, so the renderer's `invoke` calls are answered with the
 * right types. Each channel can be registered once; `dispose` removes them all.
 * It also pushes events (trial status) to every open window.
 */
export class IpcRouter {
  private readonly registered = new Set<IpcChannel>()

  constructor(
    private readonly ipcMain: IpcMainLike,
    private readonly options: IpcRouterOptions = {},
  ) {}

  register<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): this {
    if (this.registered.has(channel)) {
      throw new Error(`An IPC handler is already registered for channel "${channel}"`)
    }
    // Always answer with a promise so sync and async handlers behave the same.
    this.ipcMain.handle(channel, async (_event, ...args) => handler(...(args as IpcArgs<C>)))
    this.registered.add(channel)
    return this
  }

  /** Pushes a trial status event to every open window. Never throws: a trial must not fail because a window went away. */
  sendTrialEvent(event: TrialEvent): void {
    this.send(IpcEventChannels.trialEvent, event)
  }

  private send<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
    for (const target of this.options.eventTargets?.() ?? []) {
      try {
        if (!target.isDestroyed()) target.send(channel, payload)
      } catch (error) {
        console.warn(`[ipc] Could not send ${channel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Channels that currently have a handler, in registration order. */
  get channels(): readonly IpcChannel[] {
    return [...this.registered]
  }

  dispose(): void {
    for (const channel of this.registered) {
      this.ipcMain.removeHandler(channel)
    }
    this.registered.clear()
  }
}
