import type { Browser, BrowserContext, LaunchOptions } from 'playwright'
import type { BrowserLauncher, PersistentLaunchOptions } from '../browser/browser-manager'

/**
 * How long one browser launch may take in the self-check before Playwright
 * gives up and ends the browser process it started. Playwright's own default
 * is 3 minutes, longer than the whole self-check may run.
 *
 * It has to be generous: a first launch right after an install is slow while
 * antivirus scans the browser's files, and a slow launch on a machine where
 * the browser works must not fail the check. On the harness-msi runner the
 * whole browser check (two launches, two pages, closing both) took 21.4 s
 * the first time it ever ran and 3.8 to 3.9 s on the next three runs, so one
 * launch has never needed more than 21.4 s. The limit is about four times
 * that.
 */
export const SELF_CHECK_LAUNCH_TIMEOUT_MS = 90_000

/** Which of the harness's two kinds of launch a record is about. */
export type LaunchKind = 'shared' | 'profile'

/** One launch that returned a browser, and how long it took. */
export interface LaunchRecord {
  kind: LaunchKind
  durationMs: number
}

interface Closable {
  close(): Promise<void>
}

/**
 * The launcher the self-check hands to BrowserManager. It passes every
 * launch through to Playwright and remembers what came back, so the
 * self-check can close every Chromium it started whatever state the check
 * that started it is in: finished, failed, or abandoned after its time ran
 * out with a launch still under way.
 *
 * BrowserManager cannot do this by itself. A launch that returns after
 * close() was called is kept, not closed, and a check that has timed out is
 * still running the code that would have closed it.
 */
export class TrackedLauncher implements BrowserLauncher {
  private readonly inFlight = new Set<Promise<void>>()
  private readonly started: Closable[] = []
  private readonly records: LaunchRecord[] = []
  private sealed = false
  private closing: Promise<void> | null = null

  constructor(
    private readonly inner: BrowserLauncher,
    private readonly options: { launchTimeoutMs?: number; now?: () => number } = {},
  ) {}

  launch(options?: LaunchOptions): Promise<Browser> {
    return this.track('shared', () => this.inner.launch({ ...options, timeout: this.launchTimeoutMs }))
  }

  launchPersistentContext(userDataDir: string, options?: PersistentLaunchOptions): Promise<BrowserContext> {
    return this.track('profile', () => this.inner.launchPersistentContext(userDataDir, { ...options, timeout: this.launchTimeoutMs }))
  }

  /** The launches that returned a browser so far, in the order they finished. */
  get launches(): readonly LaunchRecord[] {
    return this.records
  }

  /**
   * Closes every Chromium this launcher started, and from now on refuses to
   * start another. A launch that is still under way is waited for and then
   * closed: Playwright offers no way to cancel one, and it ends within
   * the launch limit either way. Safe to call more than once; every call
   * resolves when the one round of closing is done. Never rejects.
   */
  closeAll(): Promise<void> {
    this.sealed = true
    this.closing ??= (async () => {
      // Nothing can be added once sealed, so this is every launch there will be.
      await Promise.all([...this.inFlight])
      await Promise.all(this.started.map((browser) => browser.close().catch(() => undefined)))
    })()
    return this.closing
  }

  private get launchTimeoutMs(): number {
    return this.options.launchTimeoutMs ?? SELF_CHECK_LAUNCH_TIMEOUT_MS
  }

  private track<T extends Closable>(kind: LaunchKind, start: () => Promise<T>): Promise<T> {
    if (this.sealed) {
      return Promise.reject(new Error('the self-check is closing its browsers, so no new one was launched'))
    }
    const now = this.options.now ?? Date.now
    const startedAt = now()
    let launch: Promise<T>
    try {
      launch = start()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const settled: Promise<void> = launch
      .then(
        (browser) => {
          this.started.push(browser)
          this.records.push({ kind, durationMs: now() - startedAt })
        },
        () => undefined,
      )
      .finally(() => {
        this.inFlight.delete(settled)
      })
    this.inFlight.add(settled)
    return launch
  }
}
