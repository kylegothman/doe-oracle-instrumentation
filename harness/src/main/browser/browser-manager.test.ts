import type { Browser, BrowserContext, Page } from 'playwright'
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

/** A minimal stand-in for a persistent BrowserContext: one blank page to start, newPage, and the close event. */
function createFakeContext() {
  const listeners: Array<() => void> = []
  const pages: Array<{ closed: boolean; isClosed: () => boolean }> = []
  const addPage = () => {
    const page = { closed: false, isClosed: () => page.closed }
    pages.push(page)
    return page as unknown as Page
  }
  addPage()
  const context = {
    pages: () => pages.filter(() => true) as unknown as Page[],
    newPage: vi.fn(async () => addPage()),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'close') listeners.push(listener)
    }),
    close: vi.fn(async () => {
      listeners.forEach((listener) => listener())
    }),
  }
  return { context: context as unknown as BrowserContext, pages, newPage: context.newPage, close: context.close }
}

function createFakeLauncher(fake = createFakeBrowser()) {
  const contexts: ReturnType<typeof createFakeContext>[] = []
  const launcher: BrowserLauncher = {
    launch: vi.fn(async () => fake.browser),
    launchPersistentContext: vi.fn(async () => {
      const persistent = createFakeContext()
      contexts.push(persistent)
      return persistent.context
    }),
  }
  return { launcher, fake, contexts }
}

/** A launcher whose every launch fails with the given message. */
function failingLauncher(message: string): BrowserLauncher {
  return {
    launch: vi.fn(async () => {
      throw new Error(message)
    }),
    launchPersistentContext: vi.fn(async () => {
      throw new Error(message)
    }),
  }
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
    const launcher = failingLauncher("browserType.launch: Executable doesn't exist at /x/chrome\n╔═══╗ Looks like Playwright...")
    const manager = new BrowserManager({ launcher })

    await expect(manager.launch()).rejects.toThrow(BrowserLaunchError)
    await expect(manager.launch()).rejects.toThrow(/npm run setup:browser/)
  })

  it('wraps any other launch failure in a BrowserLaunchError', async () => {
    const launcher = failingLauncher('spawn EACCES')

    await expect(new BrowserManager({ launcher }).launch()).rejects.toThrow(/Could not launch Chromium: spawn EACCES/)
  })

  describe('a subject with a profile folder', () => {
    const profiles = { [Subject.COPILOT]: '/userData/browser-profiles/copilot' }

    it('gets a persistent context on that folder, headed like the rest, and never touches the shared Chromium', async () => {
      const { launcher, contexts } = createFakeLauncher()
      const manager = new BrowserManager({ launcher, profiles })

      const page = await manager.getPage(Subject.COPILOT)

      expect(launcher.launchPersistentContext).toHaveBeenCalledWith('/userData/browser-profiles/copilot', { headless: false })
      expect(launcher.launch).not.toHaveBeenCalled()
      expect(manager.isRunning).toBe(false)
      expect(manager.profileDir(Subject.COPILOT)).toBe('/userData/browser-profiles/copilot')
      expect(manager.profileDir(Subject.DOE_ORACLE)).toBeUndefined()
      // The blank page the context opens with is the one used; no second page is created.
      expect(page).toBe(contexts[0]!.pages[0])
      expect(contexts[0]!.newPage).not.toHaveBeenCalled()
    })

    it('returns the same page again and launches the profile only once', async () => {
      const { launcher } = createFakeLauncher()
      const manager = new BrowserManager({ launcher, profiles })

      const first = await manager.getPage(Subject.COPILOT)
      const second = await manager.getPage(Subject.COPILOT)

      expect(second).toBe(first)
      expect(launcher.launchPersistentContext).toHaveBeenCalledTimes(1)
    })

    it('opens a new page in the same context when the Tester closed the tab', async () => {
      const { launcher, contexts } = createFakeLauncher()
      const manager = new BrowserManager({ launcher, profiles })

      const first = await manager.getPage(Subject.COPILOT)
      contexts[0]!.pages[0]!.closed = true
      const second = await manager.getPage(Subject.COPILOT)

      expect(second).not.toBe(first)
      expect(contexts[0]!.newPage).toHaveBeenCalledTimes(1)
      expect(launcher.launchPersistentContext).toHaveBeenCalledTimes(1)
    })

    it('launches the profile again after its window was closed', async () => {
      const { launcher, contexts } = createFakeLauncher()
      const manager = new BrowserManager({ launcher, profiles })
      await manager.getPage(Subject.COPILOT)

      await contexts[0]!.close()
      await manager.getPage(Subject.COPILOT)

      expect(launcher.launchPersistentContext).toHaveBeenCalledTimes(2)
    })

    it('keeps the other subjects in throw-away contexts of the shared Chromium', async () => {
      const { launcher, fake } = createFakeLauncher()
      const manager = new BrowserManager({ launcher, profiles })

      await manager.getPage(Subject.DOE_ORACLE)

      expect(launcher.launch).toHaveBeenCalledTimes(1)
      expect(fake.newContext).toHaveBeenCalledTimes(1)
      expect(launcher.launchPersistentContext).not.toHaveBeenCalled()
    })

    it('close() closes the persistent context along with the shared Chromium', async () => {
      const { launcher, fake, contexts } = createFakeLauncher()
      const manager = new BrowserManager({ launcher, profiles })
      await manager.getPage(Subject.DOE_ORACLE)
      await manager.getPage(Subject.COPILOT)

      await manager.close()

      expect(fake.browser.close).toHaveBeenCalledTimes(1)
      expect(contexts[0]!.close).toHaveBeenCalledTimes(1)
      await manager.getPage(Subject.COPILOT)
      expect(launcher.launchPersistentContext).toHaveBeenCalledTimes(2)
    })

    it('says which profile could not be opened, and when another Chromium holds it', async () => {
      await expect(
        new BrowserManager({ launcher: failingLauncher('spawn EACCES'), profiles }).getPage(Subject.COPILOT),
      ).rejects.toThrow(/Could not launch Microsoft Copilot profile at \/userData\/browser-profiles\/copilot: spawn EACCES/)
      await expect(
        new BrowserManager({ launcher: failingLauncher('Failed to launch: ProcessSingleton lock held'), profiles }).getPage(Subject.COPILOT),
      ).rejects.toThrow(/another Chromium is using it/)
    })
  })

  it('close is safe when nothing was launched', async () => {
    const { launcher } = createFakeLauncher()
    await expect(new BrowserManager({ launcher }).close()).resolves.toBeUndefined()
  })
})
