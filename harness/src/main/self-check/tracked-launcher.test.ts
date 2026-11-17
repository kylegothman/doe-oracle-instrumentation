import type { Browser, BrowserContext } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserLauncher } from '../browser/browser-manager'
import { SELF_CHECK_LAUNCH_TIMEOUT_MS, TrackedLauncher } from './tracked-launcher'

/** A promise the test settles when it chooses, to stand for a launch that is still under way. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeBrowser() {
  return { close: vi.fn(async () => undefined) }
}

function launcherReturning(browser: unknown, context: unknown): BrowserLauncher {
  return {
    launch: vi.fn(async () => browser as Browser),
    launchPersistentContext: vi.fn(async () => context as BrowserContext),
  }
}

/** Lets promise callbacks that are already queued run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('TrackedLauncher', () => {
  it('passes each launch through with the self-check launch limit, and returns what Playwright returned', async () => {
    const browser = fakeBrowser()
    const context = fakeBrowser()
    const inner = launcherReturning(browser, context)
    const launcher = new TrackedLauncher(inner)

    await expect(launcher.launch({ headless: false, executablePath: '/app/chrome' })).resolves.toBe(browser)
    await expect(launcher.launchPersistentContext('/data/profile', { headless: false })).resolves.toBe(context)

    expect(inner.launch).toHaveBeenCalledWith({ headless: false, executablePath: '/app/chrome', timeout: SELF_CHECK_LAUNCH_TIMEOUT_MS })
    expect(inner.launchPersistentContext).toHaveBeenCalledWith('/data/profile', { headless: false, timeout: SELF_CHECK_LAUNCH_TIMEOUT_MS })
  })

  it('gives a launch at least a minute, so a slow first launch on a working machine does not fail', () => {
    expect(SELF_CHECK_LAUNCH_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('records how long each launch took', async () => {
    const ticks = [1000, 1800, 2000, 2350]
    const launcher = new TrackedLauncher(launcherReturning(fakeBrowser(), fakeBrowser()), { now: () => ticks.shift() ?? 0 })

    await launcher.launch()
    await launcher.launchPersistentContext('/data/profile')

    expect(launcher.launches).toEqual([
      { kind: 'shared', durationMs: 800 },
      { kind: 'profile', durationMs: 350 },
    ])
  })

  it('closes everything it launched, once, however often closeAll is called', async () => {
    const browser = fakeBrowser()
    const context = fakeBrowser()
    const launcher = new TrackedLauncher(launcherReturning(browser, context))
    await launcher.launch()
    await launcher.launchPersistentContext('/data/profile')

    await Promise.all([launcher.closeAll(), launcher.closeAll()])
    await launcher.closeAll()

    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('waits for a launch that is still under way, then closes the browser it returns', async () => {
    const browser = fakeBrowser()
    const pending = deferred<Browser>()
    const launcher = new TrackedLauncher({ launch: () => pending.promise, launchPersistentContext: vi.fn() })
    const launch = launcher.launch()

    let closed = false
    const closing = launcher.closeAll().then(() => {
      closed = true
    })
    await settle()
    // Nothing to close yet, and closeAll has not given up on the launch.
    expect(closed).toBe(false)
    expect(browser.close).not.toHaveBeenCalled()

    pending.resolve(browser as unknown as Browser)
    await closing

    expect(browser.close).toHaveBeenCalledTimes(1)
    await expect(launch).resolves.toBe(browser)
  })

  it('refuses to launch once closing has started', async () => {
    const inner = launcherReturning(fakeBrowser(), fakeBrowser())
    const launcher = new TrackedLauncher(inner)

    await launcher.closeAll()

    await expect(launcher.launch()).rejects.toThrow(/closing its browsers/)
    await expect(launcher.launchPersistentContext('/data/profile')).rejects.toThrow(/closing its browsers/)
    expect(inner.launch).not.toHaveBeenCalled()
    expect(inner.launchPersistentContext).not.toHaveBeenCalled()
  })

  it('finishes when a launch under way fails: there is nothing to close', async () => {
    const pending = deferred<Browser>()
    const launcher = new TrackedLauncher({ launch: () => pending.promise, launchPersistentContext: vi.fn() })
    const launch = launcher.launch()

    const closing = launcher.closeAll()
    pending.reject(new Error('Timeout 90000ms exceeded'))

    await expect(closing).resolves.toBeUndefined()
    await expect(launch).rejects.toThrow('Timeout 90000ms exceeded')
    expect(launcher.launches).toEqual([])
  })

  it('closes the rest when one browser will not close, and when a launch throws at once', async () => {
    const stuck = { close: vi.fn(async () => Promise.reject(new Error('Target closed'))) }
    const context = fakeBrowser()
    const launcher = new TrackedLauncher(launcherReturning(stuck, context))
    await launcher.launch()
    await launcher.launchPersistentContext('/data/profile')

    await expect(launcher.closeAll()).resolves.toBeUndefined()
    expect(context.close).toHaveBeenCalledTimes(1)

    const throwing = new TrackedLauncher({
      launch: () => {
        throw new Error('bad options')
      },
      launchPersistentContext: vi.fn(),
    })
    await expect(throwing.launch()).rejects.toThrow('bad options')
    await expect(throwing.closeAll()).resolves.toBeUndefined()
  })
})
