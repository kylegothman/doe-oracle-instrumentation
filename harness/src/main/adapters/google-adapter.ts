import type { Page } from 'playwright'
import type { FailureSignal } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import { Subject } from '../../shared/subjects'
import { openSubjectPage, SubjectUnreachableError } from '../browser/navigation'
import type { GoogleSettings } from '../config/settings'
import { AdapterDisposedError, type AdapterNotice, type CapturedAnswer, type SubjectAdapter } from './subject-adapter'

/** What the Tester is told once the search query is typed. */
export const GOOGLE_SUBMIT_PROMPT = 'Press Enter in the Google window to submit the search query'

/** Thrown when the Google page does not behave as expected. The trial is aborted, not saved. */
export class GoogleAnswerError extends Error {
  override readonly name = 'GoogleAnswerError'
}

/** Thrown when the Tester did not submit the query within the submit wait time. */
export class GoogleSubmitTimeoutError extends Error {
  override readonly name = 'GoogleSubmitTimeoutError'
}

/** Where the adapter gets Google's page from the BrowserManager. */
export interface GooglePages {
  getPage(subject: Subject): Promise<Page>
}

export interface GoogleAdapterOptions {
  /** Page load timeout in milliseconds (defaults to settings.pageLoadTimeoutMs or 60000). */
  pageLoadTimeoutMs?: number
  /** Answer found confirmation timeout in milliseconds. */
  answerFoundTimeoutMs?: number
}

const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 60_000
const DEFAULT_ANSWER_FOUND_TIMEOUT_MS = 30_000

interface ActiveTrial {
  page: Page | null
  submitted: boolean
  disposed: Promise<never>
  markDisposed: () => void
}

/**
 * Drives Google Search in a clean, signed-out browser context with the Tester in the loop:
 * opens Google, types the query into the search box, and waits for the Tester to press Enter
 * (Architecture decision AD-3). Page load timing comes from Playwright's native load event.
 */
export class GoogleAdapter implements SubjectAdapter {
  readonly subject = Subject.GOOGLE
  private readonly pageLoadTimeoutMs: number
  private readonly answerFoundTimeoutMs: number
  private trial: ActiveTrial | null = null
  private failureHandler: ((signal: FailureSignal) => void) | null = null
  private noticeHandler: ((notice: AdapterNotice) => void) | null = null

  constructor(
    private readonly pages: GooglePages,
    private readonly settings: GoogleSettings,
    options: GoogleAdapterOptions = {},
  ) {
    this.pageLoadTimeoutMs = options.pageLoadTimeoutMs ?? settings.pageLoadTimeoutMs ?? DEFAULT_PAGE_LOAD_TIMEOUT_MS
    this.answerFoundTimeoutMs = options.answerFoundTimeoutMs ?? settings.answerFoundTimeoutMs ?? DEFAULT_ANSWER_FOUND_TIMEOUT_MS
  }

  /**
   * Opens Google Search signed-out, types the exact question into the search box,
   * tells the Tester to press Enter, and waits for the page navigation load event.
   */
  async start(question: Question): Promise<number> {
    await this.dispose()
    const trial = newActiveTrial()
    this.trial = trial

    const page = await this.untilDisposed(trial, this.pages.getPage(this.subject))
    trial.page = page

    try {
      await this.untilDisposed(trial, openSubjectPage(page, this.subject, this.settings.searchUrl))
    } catch (error) {
      if (error instanceof SubjectUnreachableError) {
        this.report({ networkError: error.message, timedOut: false })
      }
      throw error
    }

    const { selectors } = this.settings
    const input = page.locator(selectors.input)
    await input.waitFor({ state: 'visible', timeout: this.pageLoadTimeoutMs })
    await input.fill(question.text)

    this.notify({ status: 'awaiting_submit', message: GOOGLE_SUBMIT_PROMPT })

    // Wait for the Tester to press Enter, triggering navigation to search results
    const loadPromise = page.waitForLoadState('load', { timeout: this.pageLoadTimeoutMs }).catch(() => {
      throw new GoogleSubmitTimeoutError(`Search page load timed out within ${seconds(this.pageLoadTimeoutMs)}: no Enter in the Google window.`)
    })

    const startTime = Date.now()
    await this.untilDisposed(trial, loadPromise)
    trial.submitted = true
    return startTime
  }

  async waitForFirstResponse(): Promise<number> {
    // For Google search, first response and navigation completion coincide on the results page load
    return Date.now()
  }

  /**
   * Waits for completion or the secondary "Answer Found" timer.
   * If the answer found limit runs out, it returns cleanly (handled as no answer found, not a failure).
   */
  async waitForCompletion(): Promise<number> {
    const { trial, page } = this.submittedTrial()
    
    // Secondary timeout waiting for results / answer confirmation
    const resultsLocator = page.locator(this.settings.selectors.searchResults)
    try {
      await this.untilDisposed(
        trial,
        resultsLocator.waitFor({ state: 'visible', timeout: this.answerFoundTimeoutMs })
      )
    } catch {
      // Per lead guidance: if the Answer Found timer runs out, treat as no answer found (non-failure)
    }
    
    return Date.now()
  }

  async captureAnswer(): Promise<CapturedAnswer> {
    const { page } = this.submittedTrial()
    const text = await page.evaluate(() => document.body.innerText.slice(0, 1000))
    return {
      text: text.trim() || 'No answer found',
      citations: [],
      sourceUrl: page.url(),
    }
  }

  onFailure(handler: (signal: FailureSignal) => void): void {
    this.failureHandler = handler
  }

  onNotice(handler: (notice: AdapterNotice) => void): void {
    this.noticeHandler = handler
  }

  async dispose(): Promise<void> {
    const trial = this.trial
    if (!trial) return
    this.trial = null
    trial.markDisposed()
  }

  private submittedTrial(): { trial: ActiveTrial; page: Page } {
    const trial = this.trial
    if (!trial || !trial.submitted || !trial.page) {
      throw new GoogleAnswerError('start(question) must be called and submitted before waiting for results')
    }
    return { trial, page: trial.page }
  }

  private untilDisposed<T>(trial: ActiveTrial, work: Promise<T>): Promise<T> {
    return Promise.race([work, trial.disposed])
  }

  private report(signal: FailureSignal): void {
    this.failureHandler?.(signal)
  }

  private notify(notice: AdapterNotice): void {
    this.noticeHandler?.(notice)
  }
}

function newActiveTrial(): ActiveTrial {
  let markDisposed = (): void => {}
  const disposed = new Promise<never>((_resolve, reject) => {
    markDisposed = () => reject(new AdapterDisposedError('The trial was disposed'))
  })
  disposed.catch(() => {})
  return {
    page: null,
    submitted: false,
    disposed,
    markDisposed: () => markDisposed(),
  }
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`
}