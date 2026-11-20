import type { Page, Request, Response } from 'playwright'
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

/** Thrown when the Tester did not submit the query within the submit wait time. The trial is aborted, not saved. */
export class GoogleSubmitTimeoutError extends Error {
  override readonly name = 'GoogleSubmitTimeoutError'
}

/** Where the adapter gets Google's page from the BrowserManager. */
export interface GooglePages {
  getPage(subject: Subject): Promise<Page>
}

export interface GoogleAdapterOptions {
  /** Overrides settings.submitWaitMs. */
  submitWaitMs?: number
  /** How long the home page may take to show its search box. */
  pageOpenTimeoutMs?: number
}

const DEFAULT_PAGE_OPEN_TIMEOUT_MS = 15_000

/**
 * The network and load events of one trial's search, each stamped in the
 * main process as Playwright reports it.
 */
interface SearchWatch {
  /** The search navigation left the page: the Tester's Enter sent it. */
  begin: Promise<number>
  /** Google's server answered that request, whatever the status. */
  firstResponse: Promise<number>
  /** The results page fired its load event. */
  loaded: Promise<number>
  /** Rejects whichever of the three is still pending. */
  fail: (error: Error) => void
  dispose: () => void
}

/** Everything one trial holds. dispose() releases it. */
interface ActiveTrial {
  page: Page | null
  submitted: boolean
  watch: SearchWatch | null
  /** The results page's URL once it has loaded, so capture knows whether the Tester is still on it. */
  resultsUrl: string | null
  /** Rejects with AdapterDisposedError when dispose() runs, so pending waits settle at once. */
  disposed: Promise<never>
  markDisposed: () => void
}

/**
 * Drives Google Search in its own signed-out browser context with the
 * Tester in the loop (stories #36 and #37): opens Google, types the exact
 * question into the search box, and waits for the Tester to submit it
 * (Architecture decision AD-3: the harness never presses Enter or clicks
 * Search on Google). One adapter serves the whole session; each start()
 * loads the home page afresh.
 *
 * The trial is timed from the browser's own events for the main frame, each
 * stamped in the main process as Playwright reports it:
 * - begin: the navigation request to the results page leaves, which is the
 *   Tester's Enter sending the search. It only counts if the search text in
 *   the URL is the question exactly; anything else (the text was edited, a
 *   suggestion was picked) aborts the trial;
 * - first response: the response to that request arrives;
 * - end: the results page fires its load event. Begin to end is the
 *   page-load time.
 *
 * Nothing the Tester does before Enter is timed: a slow Tester cannot cause
 * a timeout, only the submit wait, which aborts the trial without saving.
 * After the load the Tester reports whether the answer is on the page; the
 * Trial Controller owns that step and calls captureAnswer() on Answer Found.
 *
 * Failures the adapter observes are reported through onFailure():
 * - the home page cannot be loaded, or the search request fails before a
 *   response: networkError (UNREACHABLE);
 * - the results page comes back with HTTP 400 or higher: httpStatus
 *   (ERROR_RESPONSE).
 * The results page not finishing loading in time is the controller's
 * timer (TIMEOUT).
 *
 * The harness reads only the request URL, the response status, and the
 * results as shown. It never reads cookies, and it does nothing to hide
 * that the browser is automated.
 */
export class GoogleAdapter implements SubjectAdapter {
  readonly subject = Subject.GOOGLE
  private readonly submitWaitMs: number
  private readonly pageOpenTimeoutMs: number
  private trial: ActiveTrial | null = null
  private failureHandler: ((signal: FailureSignal) => void) | null = null
  private noticeHandler: ((notice: AdapterNotice) => void) | null = null

  constructor(
    private readonly pages: GooglePages,
    private readonly settings: GoogleSettings,
    options: GoogleAdapterOptions = {},
  ) {
    this.submitWaitMs = options.submitWaitMs ?? settings.submitWaitMs
    this.pageOpenTimeoutMs = options.pageOpenTimeoutMs ?? DEFAULT_PAGE_OPEN_TIMEOUT_MS
  }

  /**
   * Opens Google's home page, types the exact question into the search box,
   * tells the Tester to press Enter, and resolves with begin once they
   * have: the moment the search request left the page.
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

    const input = page.locator(this.settings.selectors.input).first()
    try {
      await this.untilDisposed(trial, input.waitFor({ state: 'visible', timeout: this.pageOpenTimeoutMs }))
    } catch (error) {
      if (!isPlaywrightTimeout(error)) throw error
      throw new GoogleAnswerError(
        `The page at ${safeUrl(page)} loaded but its search box did not appear within ${seconds(this.pageOpenTimeoutMs)}. Look at the Google window.`,
      )
    }
    await this.untilDisposed(trial, input.fill(question.text))
    const typed = await this.untilDisposed(trial, input.inputValue())
    if (typed !== question.text) {
      throw new GoogleAnswerError(`The Google search box holds "${typed}" instead of the question`)
    }

    // Listen before the Tester is told to press Enter, so the request cannot be missed.
    trial.watch = this.watchSearch(page, question.text)
    this.notify({ status: 'awaiting_submit', message: GOOGLE_SUBMIT_PROMPT })
    const begin = await this.untilDisposed(trial, trial.watch.begin)
    trial.submitted = true
    return begin
  }

  /** Resolves when Google's server has answered the search request, with the moment the response arrived. */
  async waitForFirstResponse(): Promise<number> {
    const { trial, watch } = this.submittedTrial()
    return this.untilDisposed(trial, watch.firstResponse)
  }

  /**
   * Resolves when the results page has fired its load event, with that
   * moment. The adapter has no time limit of its own here: the Trial
   * Controller's timer ends a page that never finishes loading.
   */
  async waitForCompletion(): Promise<number> {
    const { trial, page, watch } = this.submittedTrial()
    const loadedAt = await this.untilDisposed(trial, watch.loaded)
    trial.resultsUrl = safeUrl(page)
    // The timed part is over: what the Tester opens from here on is not the search.
    watch.dispose()
    return loadedAt
  }

  /**
   * Reads the answer when the Tester clicks Answer Found:
   * - the passage the Tester highlighted, when it lies inside the results
   *   and outside the AI overview, with the URL of the result it came from;
   * - with nothing highlighted, the text of the results as shown, without
   *   the AI overview, and the results page's own URL.
   * If the Tester has opened a result in the Google window, the highlighted
   * passage on that page is read with that page's URL. The text is never
   * replaced: a page with no results gives an empty answer.
   */
  async captureAnswer(): Promise<CapturedAnswer> {
    const { trial, page } = this.submittedTrial()
    const pageUrl = safeUrl(page)
    if (trial.resultsUrl !== null && pageUrl !== trial.resultsUrl && !this.isResultsUrl(pageUrl)) {
      const text = await page.evaluate(() => (window.getSelection()?.toString() ?? '').trim())
      return { text, citations: [], sourceUrl: pageUrl }
    }
    const { selectors } = this.settings
    const shown = await page.evaluate(readResults, {
      resultContainers: selectors.resultContainers,
      resultTitle: selectors.resultTitle,
      aiOverview: selectors.aiOverview,
      aiOverviewHeading: selectors.aiOverviewHeading,
      aiOverviewLabels: this.settings.aiOverviewLabels,
    })
    return { text: shown.text, citations: [], sourceUrl: shown.sourceUrl ?? pageUrl }
  }

  /** Registers the handler that receives failure signals. The controller registers one per trial. */
  onFailure(handler: (signal: FailureSignal) => void): void {
    this.failureHandler = handler
  }

  /** Registers the handler that receives the "press Enter" notice. The controller registers one per trial. */
  onNotice(handler: (notice: AdapterNotice) => void): void {
    this.noticeHandler = handler
  }

  /**
   * Ends the current trial: drops the page listeners and the submit wait and
   * rejects pending waits. Safe to call at any time and more than once. The
   * page stays open; the next start() loads the home page on it.
   */
  async dispose(): Promise<void> {
    const trial = this.trial
    if (!trial) return
    this.trial = null
    trial.watch?.dispose()
    trial.watch = null
    trial.markDisposed()
  }

  /** The current trial once the Tester has submitted the search; throws otherwise. */
  private submittedTrial(): { trial: ActiveTrial; page: Page; watch: SearchWatch } {
    const trial = this.trial
    if (!trial || !trial.submitted || !trial.page || !trial.watch) {
      throw new GoogleAnswerError('start(question) must be called, and the Tester must have pressed Enter, before waiting for the results')
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

  private notify(notice: AdapterNotice): void {
    this.noticeHandler?.(notice)
  }

  private isResultsUrl(url: string): boolean {
    return pathnameOf(url) === this.settings.resultsPath
  }

  /**
   * Follows the search through the page's main-frame events. The first
   * navigation request to the results path that carries a search text is
   * the Tester's submit; redirects of it are followed, and the response
   * that is not a redirect decides between results and an error status.
   * Only a load event after that response counts, so the home page
   * finishing its own load late is never mistaken for the results.
   */
  private watchSearch(page: Page, questionText: string): SearchWatch {
    const { resultsPath, queryParam } = this.settings
    let search: Request | null = null
    let answered = false
    let finished = false
    const begin = deferred<number>()
    const firstResponse = deferred<number>()
    const loaded = deferred<number>()

    const fail = (error: Error): void => {
      begin.reject(error)
      firstResponse.reject(error)
      loaded.reject(error)
    }
    const onRequest = (request: Request): void => {
      if (finished || !isMainFrameNavigation(page, request)) return
      if (search) {
        if (request.redirectedFrom() === search) search = request
        return
      }
      const url = parseUrl(request.url())
      const sent = url?.pathname === resultsPath ? url.searchParams.get(queryParam) : null
      if (sent === null) return
      if (sent !== questionText) {
        fail(
          new GoogleAnswerError(
            `The search sent to Google was "${sent}", not the question. The trial was aborted; run it again and press Enter without changing the text.`,
          ),
        )
        return
      }
      search = request
      begin.resolve(Date.now())
    }
    const onResponse = (response: Response): void => {
      if (finished || !search || response.request() !== search) return
      // The server answered, so first response is stamped whatever the status, at the first hop of a redirect.
      firstResponse.resolve(Date.now())
      const status = response.status()
      if (status >= 300 && status < 400) return
      if (status >= 400) {
        this.report({ httpStatus: status, timedOut: false })
        return
      }
      answered = true
    }
    const onRequestFailed = (request: Request): void => {
      if (finished || request !== search) return
      const reason = request.failure()?.errorText ?? 'unknown reason'
      if (/ERR_ABORTED/.test(reason)) {
        fail(new GoogleAnswerError('The search was interrupted before the results page loaded. The trial was aborted; run it again.'))
        return
      }
      const message = `The search request to Google failed before the results page loaded (${reason})`
      this.report({ networkError: message, timedOut: false })
      fail(new GoogleAnswerError(message))
    }
    const onLoad = (): void => {
      if (finished || !answered) return
      loaded.resolve(Date.now())
    }
    const onClose = (): void => {
      fail(new GoogleAnswerError('The Google window was closed during the trial. Nothing was saved; run the trial again.'))
    }
    page.on('request', onRequest)
    page.on('response', onResponse)
    page.on('requestfailed', onRequestFailed)
    page.on('load', onLoad)
    page.on('close', onClose)

    const submitTimer = setTimeout(() => {
      begin.reject(
        new GoogleSubmitTimeoutError(
          `The search was not submitted within ${seconds(this.submitWaitMs)}: no Enter in the Google window. The trial was aborted; run it again when ready.`,
        ),
      )
    }, this.submitWaitMs)
    void begin.promise.then(
      () => clearTimeout(submitTimer),
      () => clearTimeout(submitTimer),
    )

    return {
      begin: begin.promise,
      firstResponse: firstResponse.promise,
      loaded: loaded.promise,
      fail,
      dispose: () => {
        finished = true
        clearTimeout(submitTimer)
        page.off('request', onRequest)
        page.off('response', onResponse)
        page.off('requestfailed', onRequestFailed)
        page.off('load', onLoad)
        page.off('close', onClose)
      },
    }
  }
}

function newActiveTrial(): ActiveTrial {
  let markDisposed = (): void => {}
  const disposed = new Promise<never>((_resolve, reject) => {
    markDisposed = () => reject(new AdapterDisposedError('The trial was disposed before Google answered'))
  })
  disposed.catch(() => {})
  return {
    page: null,
    submitted: false,
    watch: null,
    resultsUrl: null,
    disposed,
    markDisposed: () => markDisposed(),
  }
}

/** A promise with its settle functions. A rejection nobody awaits is not an unhandled one. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function isMainFrameNavigation(page: Page, request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame()
  } catch {
    // A request without a frame (a service worker's) is never the Tester's search.
    return false
  }
}

interface ReadResultsArgs {
  resultContainers: string[]
  resultTitle: string
  aiOverview: string
  aiOverviewHeading: string
  aiOverviewLabels: string[]
}

/**
 * Reads the results as shown. Runs inside the page, so it must not use
 * anything from this module.
 *
 * The AI overview is found two ways: by the configured container selector,
 * and by its heading. From an element whose whole text is one of the
 * labels, the block is its parent, widened upwards for as long as that adds
 * no result title, so the whole overview goes and no result goes with it.
 *
 * A highlighted passage counts when it starts inside the results and
 * outside every AI overview block. Its source is the link of the result it
 * starts in: the one title link of the nearest enclosing block, or, where a
 * block holds several, the last title before the passage.
 *
 * With nothing highlighted, the results container is copied, the AI
 * overview blocks are cut from the copy, and its text is read as laid out.
 */
function readResults(args: ReadResultsArgs): { text: string; sourceUrl: string | null } {
  let container: Element | null = null
  for (const selector of args.resultContainers) {
    container = document.querySelector(selector)
    if (container) break
  }
  if (!(container instanceof HTMLElement)) return { text: '', sourceUrl: null }
  const results = container

  const titlesIn = (root: Element): Element[] => Array.from(root.querySelectorAll(args.resultTitle))
  const labels = args.aiOverviewLabels.map((label) => label.trim().toLowerCase())
  const aiBlocks: Element[] = []
  if (args.aiOverview.trim() !== '') {
    aiBlocks.push(...Array.from(results.querySelectorAll(args.aiOverview)))
  }
  for (const heading of Array.from(results.querySelectorAll(args.aiOverviewHeading))) {
    if (!labels.includes((heading.textContent ?? '').trim().toLowerCase())) continue
    let block: Element = heading.parentElement && heading.parentElement !== results ? heading.parentElement : heading
    while (block.parentElement && block.parentElement !== results && titlesIn(block.parentElement).length === titlesIn(block).length) {
      block = block.parentElement
    }
    aiBlocks.push(block)
  }
  const inAiOverview = (node: Node): boolean => aiBlocks.some((block) => block.contains(node))

  const linkOf = (title: Element): string | null => {
    const link = title.closest('a[href]')
    if (!(link instanceof HTMLAnchorElement)) return null
    try {
      // Without scripts Google wraps a result as /url?q=<target>; the target is the source.
      const url = new URL(link.href)
      const wrapped = url.pathname === '/url' ? (url.searchParams.get('q') ?? url.searchParams.get('url')) : null
      return wrapped && /^https?:/i.test(wrapped) ? wrapped : link.href
    } catch {
      return link.href
    }
  }

  const selection = window.getSelection()
  const selected = (selection?.toString() ?? '').trim()
  if (selection && selected !== '' && selection.rangeCount > 0) {
    const start = selection.getRangeAt(0).startContainer
    if (results.contains(start) && !inAiOverview(start)) {
      let sourceUrl: string | null = null
      let scope: Element | null = start instanceof Element ? start : start.parentElement
      while (scope && results.contains(scope)) {
        const titles = titlesIn(scope).filter((title) => !inAiOverview(title))
        if (titles.length > 0) {
          let chosen = titles[0]
          for (const title of titles) {
            const position = title.compareDocumentPosition(start)
            if (title === start || position & Node.DOCUMENT_POSITION_FOLLOWING || position & Node.DOCUMENT_POSITION_CONTAINED_BY) {
              chosen = title
            }
          }
          sourceUrl = chosen ? linkOf(chosen) : null
          break
        }
        scope = scope.parentElement
      }
      return { text: selected, sourceUrl }
    }
  }

  // Each AI overview block as the child indexes that lead to it from the container, so it can be found again in the copy.
  const pathTo = (node: Element): number[] => {
    const path: number[] = []
    let current: Element = node
    while (current !== results && current.parentElement) {
      path.unshift(Array.prototype.indexOf.call(current.parentElement.children, current))
      current = current.parentElement
    }
    return path
  }
  const paths = aiBlocks.map(pathTo)
  const copy = results.cloneNode(true) as HTMLElement
  const doomed: Element[] = []
  for (const path of paths) {
    let node: Element | undefined = copy
    for (const index of path) node = node?.children[index]
    if (node && node !== copy) doomed.push(node)
  }
  for (const node of doomed) node.remove()
  copy.style.position = 'absolute'
  copy.style.left = '-99999px'
  copy.style.width = `${Math.max(results.clientWidth, 320)}px`
  document.body.append(copy)
  try {
    const text = copy.innerText
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { text, sourceUrl: null }
  } finally {
    copy.remove()
  }
}

function isPlaywrightTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Timeout \d+ms exceeded/i.test(message)
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function pathnameOf(url: string): string {
  return parseUrl(url)?.pathname ?? ''
}

/** The page's URL, or an empty string when the page is gone. */
function safeUrl(page: Page): string {
  try {
    return page.url()
  } catch {
    return ''
  }
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`
}
