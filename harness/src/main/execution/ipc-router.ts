import type { IpcMainInvokeEvent } from 'electron'
import type { IpcArgs, IpcChannel, IpcResult } from '../../shared/ipc'

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

/** A handler for one channel. Its arguments and result come from the shared contract. */
export type IpcHandler<C extends IpcChannel> = (
  ...args: IpcArgs<C>
) => IpcResult<C> | Promise<IpcResult<C>>

/**
 * Registers request handlers with `ipcMain.handle`, one per channel in the
 * shared contract, so the renderer's `invoke` calls are answered with the
 * right types. Each channel can be registered once; `dispose` removes them all.
 */
export class IpcRouter {
  private readonly registered = new Set<IpcChannel>()

  constructor(private readonly ipcMain: IpcMainLike) {}

  register<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): this {
    if (this.registered.has(channel)) {
      throw new Error(`An IPC handler is already registered for channel "${channel}"`)
    }
    // Always answer with a promise so sync and async handlers behave the same.
    this.ipcMain.handle(channel, async (_event, ...args) => handler(...(args as IpcArgs<C>)))
    this.registered.add(channel)
    return this
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
