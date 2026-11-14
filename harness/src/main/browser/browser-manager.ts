import { chromium, type Browser, type BrowserContext, type BrowserType, type LaunchOptions, type Page } from 'playwright'
import { SUBJECT_LABELS, type Subject } from '../../shared/subjects'

/** Options of chromium.launchPersistentContext. */
export type PersistentLaunchOptions = NonNullable<Parameters<BrowserType['launchPersistentContext']>[1]>

/** The part of Playwright the manager calls. Injected so tests run without a browser. */
export interface BrowserLauncher {
  launch(options?: LaunchOptions): Promise<Browser>
  launchPersistentContext(userDataDir: string, options?: PersistentLaunchOptions): Promise<BrowserContext>
}

export interface BrowserManagerOptions {
  /** Headed by default so the Tester watches the trial in a real window. Tests pass true. */
  headless?: boolean
  launcher?: BrowserLauncher
  /**
   * Subjects that keep a browser profile between launches, and where. A
   * subject listed here gets a persistent context on that folder instead of
   * a throw-away one, so a sign-in survives a restart. Copilot needs this:
   * the Tester signs in once and every later trial finds the session.
   */
  profiles?: Partial<Record<Subject, string>>
}

/** Thrown when Chromium cannot be started, with a message the Tester can act on. */
export class BrowserLaunchError extends Error {
  override readonly name = 'BrowserLaunchError'
}

/** A subject's persistent context and the page it drives. */
interface PersistentSession {
  context: BrowserContext
  page: Page | null
}

/**
 * Owns the Chromium instances the harness drives. Playwright launches them
 * from the Electron main process. Each subject under test gets its own
 * browser context (separate cookies and storage) holding a single page, so
 * subjects never share a session:
 * - a subject without a profile folder gets a fresh context in the shared
 *   Chromium, gone when the harness quits (the Oracle, and Google in E5);
 * - a subject with a profile folder (see BrowserManagerOptions.profiles)
 *   gets its own Chromium on that folder through launchPersistentContext,
 *   so what the Tester signs in to stays signed in across launches. The
 *   harness never reads the folder; it only hands the path to Playwright.
 *
 * TODO(#44): Playwright's Chromium lives in the user's cache (ms-playwright),
 * so the MSI does not include it. E8 must bundle it or install it on first run.
 */
export class BrowserManager {
  private readonly headless: boolean
  private readonly launcher: BrowserLauncher
  private readonly profiles: Partial<Record<Subject, string>>
  private browser: Browser | null = null
  private readonly pages = new Map<Subject, Page>()
  private readonly persistent = new Map<Subject, PersistentSession>()

  constructor(options: BrowserManagerOptions = {}) {
    this.headless = options.headless ?? false
    this.launcher = options.launcher ?? chromium
    this.profiles = options.profiles ?? {}
  }

  /** True while the shared Chromium (for subjects without a profile) is up. */
  get isRunning(): boolean {
    return this.browser !== null && this.browser.isConnected()
  }

  /** The profile folder a subject keeps between launches, if it has one. */
  profileDir(subject: Subject): string | undefined {
    return this.profiles[subject]
  }

  /** Starts the shared Chromium if it is not already running. Safe to call repeatedly. */
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

  /** The page for a subject, in its own context. Launches a browser if needed. */
  async getPage(subject: Subject): Promise<Page> {
    const profile = this.profiles[subject]
    if (profile) {
      return this.getPersistentPage(subject, profile)
    }

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

  /** Closes every Chromium and page. Safe to call when nothing is running. */
  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    this.pages.clear()
    const sessions = [...this.persistent.values()]
    this.persistent.clear()
    await Promise.all([
      browser ? browser.close() : Promise.resolve(),
      ...sessions.map((session) => session.context.close().catch(() => undefined)),
    ])
  }

  /** The page of a subject's persistent context, launching the context on its profile folder if needed. */
  private async getPersistentPage(subject: Subject, profile: string): Promise<Page> {
    let session = this.persistent.get(subject)
    if (!session) {
      session = { context: await this.launchPersistent(subject, profile), page: null }
      const launched = session
      launched.context.on('close', () => {
        // The Tester closed the window, or Chromium died. Forget it so the
        // next getPage() launches the profile again instead of failing.
        if (this.persistent.get(subject) === launched) {
          this.persistent.delete(subject)
        }
      })
      this.persistent.set(subject, session)
    }
    if (session.page && !session.page.isClosed()) {
      return session.page
    }
    // A persistent context opens with one blank page; use it rather than leave it hanging around.
    const page = session.context.pages().find((candidate) => !candidate.isClosed()) ?? (await session.context.newPage())
    session.page = page
    return page
  }

  private async launchPersistent(subject: Subject, profile: string): Promise<BrowserContext> {
    try {
      return await this.launcher.launchPersistentContext(profile, { headless: this.headless })
    } catch (error) {
      throw toLaunchError(error, `${SUBJECT_LABELS[subject]} profile at ${profile}`)
    }
  }
}

function toLaunchError(error: unknown, what = 'Chromium'): BrowserLaunchError {
  const message = error instanceof Error ? error.message : String(error)
  if (/Executable doesn't exist/i.test(message)) {
    return new BrowserLaunchError(
      "Playwright's Chromium is not installed. From harness/, run `npm run setup:browser`, then try again.",
    )
  }
  if (/ProcessSingleton|profile .* in use|SingletonLock/i.test(message)) {
    return new BrowserLaunchError(
      `Could not open the ${what}: another Chromium is using it. Close that window, then try again.`,
    )
  }
  return new BrowserLaunchError(`Could not launch ${what}: ${message}`)
}
