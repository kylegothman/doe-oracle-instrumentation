import type { Locator, Page, Request, Response } from 'playwright'
import type { FailureSignal } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import { Subject } from '../../shared/subjects'
import { openSubjectPage, SubjectUnreachableError } from '../browser/navigation'
import type { OracleSettings } from '../config/settings'
import type { CapturedAnswer, SubjectAdapter } from './subject-adapter'

/**
 * Where things are on the Oracle chat page (doe-frontend/src/pages/Chat.tsx).
 * The page has no ids or test hooks, so these anchor on attributes that are
 * part of its behaviour: the input's placeholder and the per-answer "Copy"
 * button. An answer bubble is the element whose button row holds that button.
 * The Send button is icon-only with no accessible name; pressing Enter in the
 * input runs the same handler, so the adapter submits with Enter.
 */
export const ORACLE_SELECTORS = {
  input: 'input[placeholder="Ask DOE anything..."]',
  answerBubble: 'div:has(> div > button[title="Copy"])',
  bubbleButtonRow: 'div:has(> button[title="Copy"])',
  citationLine: 'p.text-xs',
  systemMessage: 'div.italic.text-center',
} as const

/** Thrown when the Oracle page does not behave as the adapter expects. */
export class OracleAnswerError extends Error {
  override readonly name = 'OracleAnswerError'
}

/** Rejects a pending wait when dispose() ends the trial it belonged to. The controller ignores it. */
export class AdapterDisposedError extends Error {
  override readonly name = 'AdapterDisposedError'
}

/** Where the adapter gets the Oracle's page: the BrowserManager. */
export interface OraclePages {
  getPage(subject: Subject): Promise<Page>
}

export interface OracleAdapterOptions {
  /**
   * Upper bound on waiting for the answer, in milliseconds. 0, the default,
   * means no bound of the adapter's own: the Trial Controller's per-subject
   * timer ends a stuck trial by calling dispose(). Tests set a small value
   * to exercise the adapter on its own.
   */
  answerTimeoutMs?: number
  /** How long the page may take to send the search request after Enter. */
  submitTimeoutMs?: number
}

const DEFAULT_ANSWER_TIMEOUT_MS = 0
const DEFAULT_SUBMIT_TIMEOUT_MS = 10_000
const PAGE_OPEN_TIMEOUT_MS = 15_000
const CANCEL_WATCH_TIMEOUT_MS = 1_000
/** How often, while waiting for the search request to leave, the page is asked whether it showed an error instead. */
const SUBMIT_POLL_MS = 100
/** How long an empty answer bubble may stay empty, once the page is idle, before it counts as an empty answer. */
const EMPTY_ANSWER_GRACE_MS = 250

/** Promises for the two network-timed events of one submission, plus cleanup. */
interface SearchRequestWatch {
  begin: Promise<number>
  firstResponse: Promise<number>
  dispose: () => void
}

/** Shape of the values the in-page watchers return. */
type PageWatchResult = { at: number; empty?: true } | { error: string } | { cancelled: true }

/** Everything one trial holds. dispose() releases it. */
interface ActiveTrial {
  page: Page | null
  bubblesBefore: number
  systemMessagesBefore: number
  submitted: boolean
  watch: SearchRequestWatch | null
  /** Rejects with AdapterDisposedError when dispose() runs, so pending waits settle at once. */
  disposed: Promise<never>
  markDisposed: () => void
}

/**
 * Drives the DOE Oracle's chat page: opens it, types the question, submits
 * it, waits for the answer, and reads it back. One adapter serves the whole
 * session; each start() begins a new trial on a freshly loaded chat page.
 *
 * Timing comes from the browser's own events, not from the Oracle's code:
 * - begin: the POST to the search endpoint leaves the page (Playwright's
 *   `request` event, stamped in the main process);
 * - first response: that request's response arrives (`response` event,
 *   stamped in the main process);
 * - end: the answer text is on the page (stamped with the page's own clock
 *   inside `waitForFunction`).
 * The CORS preflight is not a POST, so it never counts as begin.
 *
 * Failures the adapter observes are reported through onFailure() as
 * FailureSignals and, where a promise is pending, also reject it:
 * - the chat page cannot be loaded, or is not the Oracle: networkError;
 * - the search request fails before any response (backend down): networkError;
 * - the page shows its own error line before the request could even be
 *   sent (a refused CORS preflight never reaches the request event): networkError;
 * - the response has an HTTP status of 400 or higher: httpStatus;
 * - the answer bubble stays empty once the page is idle: answerText ''.
 */
export class OracleAdapter implements SubjectAdapter {
  readonly subject = Subject.DOE_ORACLE
  private readonly answerTimeoutMs: number
  private readonly submitTimeoutMs: number
  private trial: ActiveTrial | null = null
  private failureHandler: ((signal: FailureSignal) => void) | null = null

  constructor(
    private readonly pages: OraclePages,
    private readonly settings: OracleSettings,
    options: OracleAdapterOptions = {},
  ) {
    this.answerTimeoutMs = options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS
    this.submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS
  }

  /** The chat page URL built from the settings. */
  get chatUrl(): string {
    return new URL(this.settings.chatPath, this.settings.baseUrl).toString()
  }

  /**
   * Opens the chat page, types the exact question, and submits it. Resolves
   * with the begin timestamp: when the POST to the search endpoint left the
   * page.
   */
  async start(question: Question): Promise<number> {
    await this.dispose()
    const trial = newActiveTrial()
    this.trial = trial

    const page = await this.untilDisposed(trial, this.pages.getPage(this.subject))
    trial.page = page
    await this.openChat(trial, page)

    const input = this.input(page)
    trial.bubblesBefore = await page.locator(ORACLE_SELECTORS.answerBubble).count()
    trial.systemMessagesBefore = await page.locator(ORACLE_SELECTORS.systemMessage).count()

    await input.fill(question.text)
    const typed = await input.inputValue()
    if (typed !== question.text) {
      throw new OracleAnswerError(`The Oracle input holds "${typed}" instead of the question`)
    }

    await installPageHelpers(page)
    const watch = this.watchSearchRequest(page)
    trial.watch = watch
    try {
      await input.press('Enter')
      trial.submitted = true
      return await this.untilDisposed(trial, this.beginOrPageError(trial, page, watch.begin))
    } catch (error) {
      watch.dispose()
      trial.watch = null
      throw error
    }
  }

  /** Resolves when the search request's response arrives, with the main-process timestamp. */
  async waitForFirstResponse(): Promise<number> {
    const { trial, watch } = this.submittedTrial()
    return this.untilDisposed(trial, watch.firstResponse)
  }

  /** Resolves when the new bubble has its answer text, with the page's timestamp. */
  async waitForCompletion(): Promise<number> {
    const { trial, page } = this.submittedTrial()
    return this.untilDisposed(
      trial,
      this.watchPage(trial, page, (args) => {
        if (window.__harnessCancelled) return { cancelled: true }
        const errorText = window.__harnessNewSystemError?.(args)
        if (errorText) return { error: errorText }
        const bubbles = document.querySelectorAll(args.answerBubble)
        if (bubbles.length <= args.bubblesBefore) return false
        const bubble = bubbles[bubbles.length - 1]
        const text = bubble ? (window.__harnessAnswerText?.(bubble, args) ?? '') : ''
        if (text.length > 0) return { at: Date.now() }
        // The bubble is there but has no text. Once the page is idle again
        // (its input re-enabled) and the text stays empty past the grace
        // period, the Oracle answered with nothing.
        const input = document.querySelector(args.input)
        if (!(input instanceof HTMLInputElement) || input.disabled) return false
        if (window.__harnessEmptySince === undefined) {
          window.__harnessEmptySince = Date.now()
          return false
        }
        if (Date.now() - window.__harnessEmptySince < args.emptyGraceMs) return false
        return { at: window.__harnessEmptySince, empty: true }
      }),
    )
  }

  /** Reads the newest answer bubble: its text without citations and buttons, plus the citation lines. */
  async captureAnswer(): Promise<CapturedAnswer> {
    const { page } = this.submittedTrial()
    const bubble = page.locator(ORACLE_SELECTORS.answerBubble).last()
    const captured = await bubble.evaluate(
      (node, selectors) => {
        const parts: string[] = []
        for (const child of Array.from(node.children)) {
          if (child.matches(selectors.bubbleButtonRow) || child.matches(selectors.citationLine)) continue
          const clone = child.cloneNode(true) as Element
          clone.querySelectorAll(selectors.citationLine).forEach((line) => line.remove())
          const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (text) parts.push(text)
        }
        const citations = Array.from(node.querySelectorAll(selectors.citationLine))
          .map((line) => (line.textContent ?? '').replace(/^\s*📄\s*/u, '').replace(/\s+/g, ' ').trim())
          .filter((line) => line.length > 0)
        return { text: parts.join('\n'), citations }
      },
      { bubbleButtonRow: ORACLE_SELECTORS.bubbleButtonRow, citationLine: ORACLE_SELECTORS.citationLine },
    )
    return { ...captured, sourceUrl: page.url() }
  }

  /** Registers the handler that receives failure signals. The controller registers one per trial. */
  onFailure(handler: (signal: FailureSignal) => void): void {
    this.failureHandler = handler
  }

  /**
   * Ends the current trial: drops the network listeners and timers, rejects
   * pending waits, and tells the page's watcher to stop polling. Safe to
   * call at any time and more than once. The next start() opens the chat
   * page again, so nothing from this trial carries over.
   */
  async dispose(): Promise<void> {
    const trial = this.trial
    if (!trial) return
    this.trial = null
    trial.watch?.dispose()
    trial.watch = null
    trial.markDisposed()
    if (trial.page && !trial.page.isClosed()) {
      await cancelPageWatch(trial.page)
    }
  }

  private input(page: Page): Locator {
    return page.locator(ORACLE_SELECTORS.input)
  }

  /** The current trial once its question has been submitted; throws otherwise. */
  private submittedTrial(): { trial: ActiveTrial; page: Page; watch: SearchRequestWatch } {
    const trial = this.trial
    if (!trial || !trial.submitted || !trial.page || !trial.watch) {
      throw new OracleAnswerError('start(question) must be called before waiting for the answer')
    }
    return { trial, page: trial.page, watch: trial.watch }
  }

  /** Settles as soon as either the work finishes or dispose() ends the trial. */
  private untilDisposed<T>(trial: ActiveTrial, work: Promise<T>): Promise<T> {
    return Promise.race([work, trial.disposed])
  }

  private report(signal: FailureSignal): void {
    this.failureHandler?.(signal)
  }

  /** Loads the chat page and waits until the question input is usable. */
  private async openChat(trial: ActiveTrial, page: Page): Promise<void> {
    try {
      await this.untilDisposed(trial, openSubjectPage(page, this.subject, this.chatUrl))
    } catch (error) {
      if (error instanceof SubjectUnreachableError) {
        this.report({ networkError: error.message, timedOut: false })
      }
      throw error
    }
    try {
      await this.untilDisposed(trial, this.input(page).waitFor({ state: 'visible', timeout: PAGE_OPEN_TIMEOUT_MS }))
    } catch (error) {
      if (isPlaywrightTimeout(error)) {
        const message = `The page at ${this.chatUrl} loaded but does not look like the DOE Oracle chat: its question input did not appear within ${seconds(PAGE_OPEN_TIMEOUT_MS)}. Check that the Oracle frontend is what runs at that address.`
        this.report({ networkError: message, timedOut: false })
        throw new OracleAnswerError(message)
      }
      throw error
    }
  }

  /**
   * Polls a watcher inside the page once per animation frame until it returns
   * a value. The watcher runs in the page, so its timestamps come from the
   * page's clock at the moment the condition first held.
   */
  private async watchPage(
    trial: ActiveTrial,
    page: Page,
    watcher: (args: PageWatchArgs) => PageWatchResult | false,
  ): Promise<number> {
    await installPageHelpers(page)
    const args = this.watchArgs(trial)
    let handle
    try {
      handle = await page.waitForFunction(watcher, args, { polling: 'raf', timeout: this.answerTimeoutMs })
    } catch (error) {
      if (this.answerTimeoutMs > 0 && isPlaywrightTimeout(error)) {
        throw new OracleAnswerError(`No answer appeared within ${seconds(this.answerTimeoutMs)}`)
      }
      throw error
    }
    const result = (await handle.jsonValue()) as PageWatchResult
    if ('cancelled' in result) {
      throw new AdapterDisposedError('The trial was disposed before the Oracle answered')
    }
    if ('error' in result) {
      throw new OracleAnswerError(`The Oracle reported an error: ${result.error}`)
    }
    if (result.empty) {
      this.report({ answerText: '', timedOut: false })
    }
    return result.at
  }

  private watchArgs(trial: ActiveTrial): PageWatchArgs {
    return {
      input: ORACLE_SELECTORS.input,
      answerBubble: ORACLE_SELECTORS.answerBubble,
      bubbleButtonRow: ORACLE_SELECTORS.bubbleButtonRow,
      citationLine: ORACLE_SELECTORS.citationLine,
      systemMessage: ORACLE_SELECTORS.systemMessage,
      bubblesBefore: trial.bubblesBefore,
      systemMessagesBefore: trial.systemMessagesBefore,
      emptyGraceMs: EMPTY_ANSWER_GRACE_MS,
    }
  }

  /**
   * Resolves with begin when the search request leaves the page. While it
   * has not, asks the page every SUBMIT_POLL_MS whether it showed its own
   * error line instead; it does when the request could not be sent at all
   * (for example the CORS preflight to a backend that is down), in which
   * case Playwright never reports a request. That is a network failure.
   */
  private beginOrPageError(trial: ActiveTrial, page: Page, begin: Promise<number>): Promise<number> {
    const args = this.watchArgs(trial)
    return new Promise<number>((resolve, reject) => {
      let settled = false
      const stop = (): void => {
        settled = true
        clearInterval(poll)
      }
      const poll = setInterval(() => {
        if (settled) return
        page
          .evaluate((a) => window.__harnessNewSystemError?.(a) ?? null, args)
          .then((text) => {
            if (settled || !text) return
            stop()
            const message = `The Oracle page could not send the search request: ${text}`
            this.report({ networkError: message, timedOut: false })
            reject(new OracleAnswerError(message))
          })
          .catch(() => undefined)
      }, SUBMIT_POLL_MS)
      begin.then(
        (ms) => {
          if (settled) return
          stop()
          resolve(ms)
        },
        (error: unknown) => {
          if (settled) return
          stop()
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  /**
   * Listens for the one POST to the search endpoint that Enter triggers and
   * stamps, in the main process, when it leaves and when its response
   * arrives. A request that fails before any response (for example the
   * backend is down) is reported as a failure and rejects first response.
   */
  private watchSearchRequest(page: Page): SearchRequestWatch {
    const endpointPath = this.settings.searchEndpointPath
    const isSearchRequest = (request: Request): boolean =>
      request.method() === 'POST' && pathnameOf(request.url()) === endpointPath

    let matched: Request | null = null
    let resolveBegin: (ms: number) => void = () => {}
    let rejectBegin: (error: Error) => void = () => {}
    let resolveFirst: (ms: number) => void = () => {}
    let rejectFirst: (error: Error) => void = () => {}
    const begin = new Promise<number>((resolve, reject) => {
      resolveBegin = resolve
      rejectBegin = reject
    })
    const firstResponse = new Promise<number>((resolve, reject) => {
      resolveFirst = resolve
      rejectFirst = reject
    })
    // The caller may never await one of these; keep a rejection from being "unhandled".
    begin.catch(() => {})
    firstResponse.catch(() => {})

    const onRequest = (request: Request): void => {
      if (matched || !isSearchRequest(request)) return
      matched = request
      resolveBegin(Date.now())
    }
    const onResponse = (response: Response): void => {
      if (!matched || response.request() !== matched) return
      // The response arrived, so first response is stamped even when it is an error.
      resolveFirst(Date.now())
      const status = response.status()
      if (status >= 400) {
        this.report({ httpStatus: status, timedOut: false })
      }
    }
    const onRequestFailed = (request: Request): void => {
      if (request !== matched) return
      const reason = request.failure()?.errorText ?? 'unknown reason'
      const message = `The request to ${endpointPath} failed before a response arrived (${reason})`
      this.report({ networkError: message, timedOut: false })
      rejectFirst(new OracleAnswerError(message))
    }
    page.on('request', onRequest)
    page.on('response', onResponse)
    page.on('requestfailed', onRequestFailed)

    const submitTimer = setTimeout(() => {
      rejectBegin(
        new OracleAnswerError(`The Oracle page did not send a request to ${endpointPath} within ${seconds(this.submitTimeoutMs)}`),
      )
    }, this.submitTimeoutMs)
    const answerTimer =
      this.answerTimeoutMs > 0
        ? setTimeout(() => {
            rejectFirst(new OracleAnswerError(`No response from ${endpointPath} within ${seconds(this.answerTimeoutMs)}`))
          }, this.answerTimeoutMs)
        : null

    const dispose = (): void => {
      clearTimeout(submitTimer)
      if (answerTimer) clearTimeout(answerTimer)
      page.off('request', onRequest)
      page.off('response', onResponse)
      page.off('requestfailed', onRequestFailed)
    }
    void begin.then(() => clearTimeout(submitTimer)).catch(dispose)
    void firstResponse.then(dispose).catch(dispose)
    return { begin, firstResponse, dispose }
  }
}

function newActiveTrial(): ActiveTrial {
  let markDisposed = (): void => {}
  const disposed = new Promise<never>((_resolve, reject) => {
    markDisposed = () => reject(new AdapterDisposedError('The trial was disposed before the Oracle answered'))
  })
  disposed.catch(() => {})
  return { page: null, bubblesBefore: 0, systemMessagesBefore: 0, submitted: false, watch: null, disposed, markDisposed }
}

/** Defines, once per page load, the helpers the in-page watchers use, and resets the per-wait flags. */
async function installPageHelpers(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__harnessCancelled = false
    window.__harnessEmptySince = undefined
    if (window.__harnessNewSystemError) return
    // The answer text of a bubble: everything but its button row and citation lines, as captureAnswer reads it.
    window.__harnessAnswerText = (bubble, args) => {
      const clone = bubble.cloneNode(true) as Element
      clone.querySelectorAll(`${args.bubbleButtonRow}, ${args.citationLine}`).forEach((node) => node.remove())
      return (clone.textContent ?? '').trim()
    }
    window.__harnessNewSystemError = (args) => {
      const messages = document.querySelectorAll(args.systemMessage)
      if (messages.length <= args.systemMessagesBefore) return null
      const text = (messages[messages.length - 1]?.textContent ?? '').trim()
      return /error/i.test(text) ? text : null
    }
  })
}

/** Tells a page's watcher to stop polling. Gives up after a moment if the page does not respond. */
async function cancelPageWatch(page: Page): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CANCEL_WATCH_TIMEOUT_MS)
  })
  try {
    const flagged = page
      .evaluate(() => {
        window.__harnessCancelled = true
      })
      .catch(() => undefined)
    await Promise.race([flagged, gaveUp])
  } finally {
    clearTimeout(timer)
  }
}

function isPlaywrightTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Timeout \d+ms exceeded/i.test(message)
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`
}

interface PageWatchArgs {
  input: string
  answerBubble: string
  bubbleButtonRow: string
  citationLine: string
  systemMessage: string
  bubblesBefore: number
  systemMessagesBefore: number
  emptyGraceMs: number
}

declare global {
  interface Window {
    /** Installed by the adapter inside the Oracle page; see installPageHelpers. */
    __harnessNewSystemError?: (args: PageWatchArgs) => string | null
    /** Installed by the adapter inside the Oracle page; the answer text of a bubble without its chrome. */
    __harnessAnswerText?: (bubble: Element, args: PageWatchArgs) => string
    /** Set by dispose() so the in-page watcher stops polling. */
    __harnessCancelled?: boolean
    /** When the completion watcher first saw an empty answer bubble on an idle page. */
    __harnessEmptySince?: number
  }
}
