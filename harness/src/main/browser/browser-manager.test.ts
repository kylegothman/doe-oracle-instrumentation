import type { Browser, Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { Subject } from '../../shared/subjects'
import { BrowserLaunchError, BrowserManager, type BrowserLauncher } from './browser-manager'

/** A minimal stand-in for a Playwright Browser: contexts, pages, and the disconnected event. */
function createFakeBrowser() {
  let connected = true
  const listeners: Array<() => void> = []
  const pages: Array<{ closed: boolean }> = []
  const newContext = vi.fn(async () => ({
    newPage: vi.fn(async () => {
      const page = { closed: false, isClosed: () => page.closed }
      pages.push(page)
      return page as unknown as Page
    }),
  }))
  const browser = {
    isConnected: () => connected,
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'disconnected') listeners.push(listener)
    }),
    newContext,
    close: vi.fn(async () => {
      connected = false
      listeners.forEach((listener) => listener())
    }),
  }
  return { browser: browser as unknown as Browser, newContext, pages, disconnect: () => browser.close() }
}

function createFakeLauncher(fake = createFakeBrowser()) {
  const launcher: BrowserLauncher = { launch: vi.fn(async () => fake.browser) }
  return { launcher, fake }
}

describe('BrowserManager', () => {
  it('launches Chromium once and reuses it across calls', async () => {
    const { launcher } = createFakeLauncher()
    const manager = new BrowserManager({ launcher })

    await manager.launch()
    await manager.launch()
    await manager.getPage(Subject.DOE_ORACLE)

    expect(launcher.launch).toHaveBeenCalledTimes(1)
    expect(manager.isRunning).toBe(true)
  })

  it('launches headed by default and headless on request', async () => {
    const headed = createFakeLauncher()
    await new BrowserManager({ launcher: headed.launcher }).launch()
    expect(headed.launcher.launch).toHaveBeenCalledWith({ headless: false })

    const headless = createFakeLauncher()
    await new BrowserManager({ launcher: headless.launcher, headless: true }).launch()
    expect(headless.launcher.launch).toHaveBeenCalledWith({ headless: true })
  })

  it('gives a subject one context and one page, and returns the same page again', async () => {
    const { launcher, fake } = createFakeLauncher()
    const manager = new BrowserManager({ launcher })

    const first = await manager.getPage(Subject.DOE_ORACLE)
    const second = await manager.getPage(Subject.DOE_ORACLE)

    expect(second).toBe(first)
    expect(fake.newContext).toHaveBeenCalledTimes(1)
    expect(fake.pages).toHaveLength(1)
  })

  it('opens a fresh page when the previous one was closed', async () => {
    const { launcher, fake } = createFakeLauncher()
    const manager = new BrowserManager({ launcher })

    const first = await manager.getPage(Subject.DOE_ORACLE)
    fake.pages[0]!.closed = true
    const second = await manager.getPage(Subject.DOE_ORACLE)

    expect(second).not.toBe(first)
    expect(fake.pages).toHaveLength(2)
  })

  it('closes the browser and relaunches on the next use', async () => {
    const { launcher, fake } = createFakeLauncher()
    const manager = new BrowserManager({ launcher })
    await manager.getPage(Subject.DOE_ORACLE)

    await manager.close()

    expect(fake.browser.close).toHaveBeenCalledTimes(1)
    expect(manager.isRunning).toBe(false)
    await manager.getPage(Subject.DOE_ORACLE)
    expect(launcher.launch).toHaveBeenCalledTimes(2)
  })

  it('forgets a browser that disconnects on its own, so the next call relaunches', async () => {
    const { launcher, fake } = createFakeLauncher()
    const manager = new BrowserManager({ launcher })
    await manager.getPage(Subject.DOE_ORACLE)

    await fake.disconnect()

    expect(manager.isRunning).toBe(false)
    await manager.getPage(Subject.DOE_ORACLE)
    expect(launcher.launch).toHaveBeenCalledTimes(2)
  })

  it('explains how to install Chromium when the executable is missing', async () => {
    const launcher: BrowserLauncher = {
      launch: vi.fn(async () => {
        throw new Error("browserType.launch: Executable doesn't exist at /x/chrome\n╔═══╗ Looks like Playwright...")
      }),
    }
    const manager = new BrowserManager({ launcher })

    await expect(manager.launch()).rejects.toThrow(BrowserLaunchError)
    await expect(manager.launch()).rejects.toThrow(/npm run setup:browser/)
  })

  it('wraps any other launch failure in a BrowserLaunchError', async () => {
    const launcher: BrowserLauncher = {
      launch: vi.fn(async () => {
        throw new Error('spawn EACCES')
      }),
    }

    await expect(new BrowserManager({ launcher }).launch()).rejects.toThrow(/Could not launch Chromium: spawn EACCES/)
  })

  it('close is safe when nothing was launched', async () => {
    const { launcher } = createFakeLauncher()
    await expect(new BrowserManager({ launcher }).close()).resolves.toBeUndefined()
  })
})
