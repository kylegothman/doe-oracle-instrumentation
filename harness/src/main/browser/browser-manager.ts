import { chromium, type Browser, type LaunchOptions, type Page } from 'playwright'
import type { SubjectId } from '../../shared/subjects'

/** The part of Playwright the manager calls. Injected so tests run without a browser. */
export interface BrowserLauncher {
  launch(options?: LaunchOptions): Promise<Browser>
}

export interface BrowserManagerOptions {
  /** Headed by default so the Tester watches the trial in a real window. Tests pass true. */
  headless?: boolean
  launcher?: BrowserLauncher
}

/** Thrown when Chromium cannot be started, with a message the Tester can act on. */
export class BrowserLaunchError extends Error {
  override readonly name = 'BrowserLaunchError'
}

/**
 * Owns the one Chromium instance the harness drives. Playwright launches it
 * from the Electron main process. Each subject under test gets its own
 * browser context (separate cookies and storage) holding a single page, so
 * subjects never share a session.
 *
 * TODO(#44): Playwright's Chromium lives in the user's cache (ms-playwright),
 * so the MSI does not include it. E8 must bundle it or install it on first run.
 */
export class BrowserManager {
  private readonly headless: boolean
  private readonly launcher: BrowserLauncher
  private browser: Browser | null = null
  private readonly pages = new Map<SubjectId, Page>()

  constructor(options: BrowserManagerOptions = {}) {
    this.headless = options.headless ?? false
    this.launcher = options.launcher ?? chromium
  }

  get isRunning(): boolean {
    return this.browser !== null && this.browser.isConnected()
  }

  /** Starts Chromium if it is not already running. Safe to call repeatedly. */
  async launch(): Promise<void> {
    if (this.isRunning) {
      return
    }
    this.browser = null
    this.pages.clear()

    let browser: Browser
    try {
      browser = await this.launcher.launch({ headless: this.headless })
    } catch (error) {
      throw toLaunchError(error)
    }
    browser.on('disconnected', () => {
      // The Tester closed the window, or Chromium died. Forget it so the
      // next getPage() launches a fresh instance instead of failing.
      if (this.browser === browser) {
        this.browser = null
        this.pages.clear()
      }
    })
    this.browser = browser
  }

  /** The page for a subject, in its own context. Launches the browser if needed. */
  async getPage(subject: SubjectId): Promise<Page> {
    await this.launch()
    const browser = this.browser
    if (!browser) {
      throw new BrowserLaunchError('Chromium disconnected while it was being prepared')
    }

    const existing = this.pages.get(subject)
    if (existing && !existing.isClosed()) {
      return existing
    }

    const context = await browser.newContext()
    const page = await context.newPage()
    this.pages.set(subject, page)
    return page
  }

  /** Closes Chromium and every page. Safe to call when nothing is running. */
  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    this.pages.clear()
    if (browser) {
      await browser.close()
    }
  }
}

function toLaunchError(error: unknown): BrowserLaunchError {
  const message = error instanceof Error ? error.message : String(error)
  if (/Executable doesn't exist/i.test(message)) {
    return new BrowserLaunchError(
      "Playwright's Chromium is not installed. From harness/, run `npm run setup:browser`, then try again.",
    )
  }
  return new BrowserLaunchError(`Could not launch Chromium: ${message}`)
}
