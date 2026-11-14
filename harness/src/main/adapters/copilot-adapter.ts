import type { Page, WebSocket as PlaywrightWebSocket } from 'playwright'
import type { FailureSignal } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import { Subject } from '../../shared/subjects'
import { openSubjectPage, SubjectUnreachableError } from '../browser/navigation'
import type { CopilotSettings } from '../config/settings'
import { isChatRequestFrame } from './copilot-frames'
import { CopilotSignedOutError, probeCopilotPage, safePageUrl } from './copilot-session'
import { AdapterDisposedError, type AdapterNotice, type CapturedAnswer, type SubjectAdapter } from './subject-adapter'

/** What the Tester is told once the question is typed. */
export const COPILOT_SUBMIT_PROMPT = 'Press Enter in the Copilot window to send the question'

/** Thrown when the Copilot page does not behave as the adapter expects. The trial is aborted, not saved. */
export class CopilotAnswerError extends Error {
  override readonly name = 'CopilotAnswerError'
}

/** Thrown when the Tester did not submit the question within the submit wait. The trial is aborted, not saved. */
export class CopilotSubmitTimeoutError extends Error {
  override readonly name = 'CopilotSubmitTimeoutError'
}

/** Where the adapter gets Copilot's page: the BrowserManager, which keeps it on the persistent profile. */
export interface CopilotPages {
  getPage(subject: Subject): Promise<Page>
}

export interface CopilotAdapterOptions {
  /**
   * Upper bound on waiting for the answer, in milliseconds. 0, the default,
   * means no bound of the adapter's own: the Trial Controller's per-subject
   * timer ends a stuck trial by calling dispose(). Tests set a small value.
   */
  answerTimeoutMs?: number
  /** Overrides settings.submitWaitMs. */
  submitWaitMs?: number
  /** Overrides settings.submitConfirmMs. */
  submitConfirmMs?: number
  /** Overrides settings.quietPeriodMs. */
  quietPeriodMs?: number
  /** How long the chat page may take to show its input, the sign-in page, or the offline screen. */
  pageOpenTimeoutMs?: number
}

const DEFAULT_ANSWER_TIMEOUT_MS = 0
const DEFAULT_PAGE_OPEN_TIMEOUT_MS = 15_000
/** How often the in-page watch state is read. The timestamps come from the page's MutationObserver, not from this interval. */
const WATCH_POLL_MS = 50
const CANCEL_WATCH_TIMEOUT_MS = 1_000

/** Which condition a watch waits for. */
type WatchMode = 'submit' | 'confirm' | 'first'

/** What a watch resolves with: a page-clock timestamp, or what went wrong. */
type WatchResult =
  | { at: number }
  | { edited: string }
  | { error: string; at: number }
  | { offline: number }
  | { cancelled: true }
  | { gone: true }

/** Thrown inside the adapter when a watch's own time limit passed; turned into the right error by the caller. */
class WatchTimeoutError extends Error {
  override readonly name = 'WatchTimeoutError'
}

/** The ChatHub socket listener of one trial: when the request frame left, plus cleanup. */
interface SocketWatch {
  requestSentAt: number | null
  requestSent: Promise<number>
  dispose: () => void
}

/** Everything one trial holds. dispose() releases it. */
interface ActiveTrial {
  page: Page | null
  submitted: boolean
  socket: SocketWatch | null
  /** Rejects with AdapterDisposedError when dispose() runs, so pending waits settle at once. */
  disposed: Promise<never>
  markDisposed: () => void
}

/**
 * Drives Microsoft Copilot's chat page with the Tester in the loop: opens a
 * new chat, types the question, and waits for the Tester to press Enter
 * (Architecture decision AD-3: the harness never submits to Copilot), then
 * follows the streamed answer. One adapter serves the whole session; each
 * start() begins a new chat on the persistent, signed-in profile.
 *
 * Timing comes from a MutationObserver installed in the page, stamped with
 * the page's own clock:
 * - begin: the editor clearing, which Copilot does as it sends (14 ms before
 *   its own request stamp in the spike). It only counts once something
 *   confirms a send followed: the Stop button, the new message, or the
 *   request frame on the ChatHub socket (stamped in the main process). An
 *   editor that clears with none of those is the Tester deleting the text,
 *   and the trial is aborted;
 * - first response: the first text in the new answer;
 * - end (#35): the last change to that text before the finished marker.
 *
 * Nothing the Tester does before Enter is timed: a slow Tester cannot cause
 * a timeout, only the submit wait, which aborts the trial without saving.
 * The ChatHub socket is read for the request frame and (#35) the citation
 * URLs; its frames are never logged or stored.
 */
export class CopilotAdapter implements SubjectAdapter {
  readonly subject = Subject.COPILOT
  private readonly answerTimeoutMs: number
  private readonly submitWaitMs: number
  private readonly submitConfirmMs: number
  private readonly quietPeriodMs: number
  private readonly pageOpenTimeoutMs: number
  private trial: ActiveTrial | null = null
  private failureHandler: ((signal: FailureSignal) => void) | null = null
  private noticeHandler: ((notice: AdapterNotice) => void) | null = null

  constructor(
    private readonly pages: CopilotPages,
    private readonly settings: CopilotSettings,
    options: CopilotAdapterOptions = {},
  ) {
    this.answerTimeoutMs = options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS
    this.submitWaitMs = options.submitWaitMs ?? settings.submitWaitMs
    this.submitConfirmMs = options.submitConfirmMs ?? settings.submitConfirmMs
    this.quietPeriodMs = options.quietPeriodMs ?? settings.quietPeriodMs
    this.pageOpenTimeoutMs = options.pageOpenTimeoutMs ?? DEFAULT_PAGE_OPEN_TIMEOUT_MS
  }

  /**
   * Opens a new chat, types the exact question, tells the Tester to press
   * Enter, and resolves with begin once they have: the page-clock moment
   * the editor cleared, confirmed by a send signal.
   */
  async start(question: Question): Promise<number> {
    await this.dispose()
    const trial = newActiveTrial()
    this.trial = trial

    const page = await this.untilDisposed(trial, this.pages.getPage(this.subject))
    trial.page = page
    await this.openChat(trial, page)

    const { selectors } = this.settings
    const before = await page.evaluate(countBefore, selectors)
    const input = page.locator(selectors.input)
    await input.fill(question.text)
    const typed = stripZeroWidth(await input.innerText())
    if (typed !== question.text) {
      throw new CopilotAnswerError(`The Copilot input holds "${typed}" instead of the question`)
    }

    trial.socket = this.watchSocket(page)
    await page.evaluate(installWatch, { ...selectors, ...before, typedText: question.text })
    this.notify({ status: 'awaiting_submit', message: COPILOT_SUBMIT_PROMPT })
    const begin = await this.untilDisposed(trial, this.waitForTesterSubmit(trial, page))
    trial.submitted = true
    return begin
  }

  /** Resolves when the first text of the answer is on the page, with the page's timestamp. */
  async waitForFirstResponse(): Promise<number> {
    const { trial, page } = this.submittedTrial()
    const result = await this.untilDisposed(
      trial,
      this.watch(page, 'first', this.answerTimeoutMs).catch((error: unknown) => {
        if (error instanceof WatchTimeoutError) {
          throw new CopilotAnswerError(`No answer started within ${seconds(this.answerTimeoutMs)}`)
        }
        throw error
      }),
    )
    return this.timestampOf(result, 'before the answer started')
  }

  /** TODO(#35): stream-end detection. */
  async waitForCompletion(): Promise<number> {
    this.submittedTrial()
    throw new CopilotAnswerError('Stream-end detection is not available yet (#35)')
  }

  /** TODO(#35): the answer text and citations. */
  async captureAnswer(): Promise<CapturedAnswer> {
    this.submittedTrial()
    throw new CopilotAnswerError('Reading the answer is not available yet (#35)')
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
   * Ends the current trial: drops the socket listeners, rejects pending
   * waits, and stops the page's observer. Safe to call at any time and more
   * than once. The page and its signed-in profile stay open; the next
   * start() opens a new chat on them.
   */
  async dispose(): Promise<void> {
    const trial = this.trial
    if (!trial) return
    this.trial = null
    trial.socket?.dispose()
    trial.socket = null
    trial.markDisposed()
    if (trial.page && !trial.page.isClosed()) {
      await cancelWatch(trial.page)
    }
  }

  /** The current trial once its question has been submitted; throws otherwise. */
  private submittedTrial(): { trial: ActiveTrial; page: Page } {
    const trial = this.trial
    if (!trial || !trial.submitted || !trial.page) {
      throw new CopilotAnswerError('start(question) must be called, and the Tester must have pressed Enter, before waiting for the answer')
    }
    return { trial, page: trial.page }
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

  /** Loads a new chat and makes sure it is the signed-in Copilot chat with its input ready. */
  private async openChat(trial: ActiveTrial, page: Page): Promise<void> {
    try {
      await this.untilDisposed(trial, openSubjectPage(page, this.subject, this.settings.chatUrl))
    } catch (error) {
      if (error instanceof SubjectUnreachableError) {
        this.report({ networkError: error.message, timedOut: false })
      }
      throw error
    }
    const state = await this.untilDisposed(trial, probeCopilotPage(page, this.settings, { timeoutMs: this.pageOpenTimeoutMs }))
    switch (state) {
      case 'chat':
        return
      case 'signed_out':
        throw new CopilotSignedOutError(safePageUrl(page))
      case 'offline': {
        const message = `Copilot shows "No internet connection" at ${safePageUrl(page)}. Check the network, then run the trial again.`
        this.report({ networkError: message, timedOut: false })
        throw new CopilotAnswerError(message)
      }
      case 'unknown': {
        const message = `The page at ${safePageUrl(page)} loaded but does not look like the Copilot chat: its question input did not appear within ${seconds(this.pageOpenTimeoutMs)}. Look at the Copilot window.`
        this.report({ networkError: message, timedOut: false })
        throw new CopilotAnswerError(message)
      }
    }
  }

  /**
   * Waits for the Tester's Enter: the editor clearing, then a confirming
   * send signal within submitConfirmMs. Text changed before the send, or
   * cleared with no send following, aborts the trial.
   */
  private async waitForTesterSubmit(trial: ActiveTrial, page: Page): Promise<number> {
    let result: WatchResult
    try {
      result = await this.watch(page, 'submit', this.submitWaitMs)
    } catch (error) {
      if (error instanceof WatchTimeoutError) {
        throw new CopilotSubmitTimeoutError(
          `The question was not sent within ${seconds(this.submitWaitMs)}: no Enter in the Copilot window. The trial was aborted; run it again when ready.`,
        )
      }
      throw error
    }
    if ('edited' in result) {
      throw new CopilotAnswerError(
        `The question in the Copilot input was changed before it was sent (it now reads "${result.edited}"). The trial was aborted; run it again.`,
      )
    }
    const clearedAt = this.timestampOf(result, 'before the question was sent')
    if (!(await this.confirmSubmit(trial, page))) {
      throw new CopilotAnswerError(
        'The question was removed from the Copilot input without being sent. The trial was aborted; run it again.',
      )
    }
    return clearedAt
  }

  /** True when a send signal follows the editor clearing within submitConfirmMs. */
  private async confirmSubmit(trial: ActiveTrial, page: Page): Promise<boolean> {
    if (trial.socket?.requestSentAt !== null && trial.socket?.requestSentAt !== undefined) return true
    const fromPage = this.watch(page, 'confirm', this.submitConfirmMs).then(
      () => true,
      (error: unknown) => {
        if (error instanceof WatchTimeoutError) return false
        throw error
      },
    )
    const fromSocket = trial.socket ? trial.socket.requestSent.then(() => true) : new Promise<boolean>(() => {})
    return Promise.race([fromPage, fromSocket])
  }

  /** A timestamp result, or the error/offline outcome turned into a failure of the trial. */
  private timestampOf(result: WatchResult, when: string): number {
    if ('offline' in result) {
      const message = `Copilot lost its connection ("No internet connection") ${when}`
      this.report({ networkError: message, timedOut: false })
      throw new CopilotAnswerError(message)
    }
    if ('error' in result) {
      throw new CopilotAnswerError(`Copilot showed an error ${when}: ${result.error}`)
    }
    if (!('at' in result)) {
      throw new CopilotAnswerError(`Unexpected watch result ${when}`)
    }
    return result.at
  }

  /**
   * Polls the in-page watch state every WATCH_POLL_MS until the mode's
   * condition holds, the trial is cancelled, or timeoutMs passes (0 means
   * no limit). Timestamps in the result are the page's.
   */
  private async watch(page: Page, mode: WatchMode, timeoutMs: number): Promise<WatchResult> {
    let handle
    try {
      handle = await page.waitForFunction(readWatch, { mode, quietPeriodMs: this.quietPeriodMs }, { polling: WATCH_POLL_MS, timeout: timeoutMs })
    } catch (error) {
      if (timeoutMs > 0 && isPlaywrightTimeout(error)) {
        throw new WatchTimeoutError(`nothing happened within ${seconds(timeoutMs)}`)
      }
      throw error
    }
    const result = (await handle.jsonValue()) as WatchResult
    if ('cancelled' in result) {
      throw new AdapterDisposedError('The trial was disposed before Copilot answered')
    }
    if ('gone' in result) {
      throw new CopilotAnswerError('The Copilot page was reloaded during the trial, so the answer could not be followed')
    }
    return result
  }

  /**
   * Listens on the ChatHub socket for the first invocation frame after the
   * question was typed: the request carrying it. Only its moment is kept;
   * the frame itself is parsed in memory and dropped.
   */
  private watchSocket(page: Page): SocketWatch {
    const hubPath = this.settings.chatHubPath
    let resolveRequest: (ms: number) => void = () => {}
    const requestSent = new Promise<number>((resolve) => {
      resolveRequest = resolve
    })
    const listeners: Array<{ socket: PlaywrightWebSocket; onSent: (frame: { payload: string | Buffer }) => void }> = []
    const watch: SocketWatch = {
      requestSentAt: null,
      requestSent,
      dispose: () => {
        page.off('websocket', onSocket)
        for (const { socket, onSent } of listeners) socket.off('framesent', onSent)
        listeners.length = 0
      },
    }
    const onSocket = (socket: PlaywrightWebSocket): void => {
      if (!pathnameOf(socket.url()).startsWith(hubPath)) return
      const onSent = (frame: { payload: string | Buffer }): void => {
        if (watch.requestSentAt !== null || !isChatRequestFrame(frame.payload)) return
        watch.requestSentAt = Date.now()
        resolveRequest(watch.requestSentAt)
      }
      socket.on('framesent', onSent)
      listeners.push({ socket, onSent })
    }
    page.on('websocket', onSocket)
    return watch
  }
}

function newActiveTrial(): ActiveTrial {
  let markDisposed = (): void => {}
  const disposed = new Promise<never>((_resolve, reject) => {
    markDisposed = () => reject(new AdapterDisposedError('The trial was disposed before Copilot answered'))
  })
  disposed.catch(() => {})
  return { page: null, submitted: false, socket: null, disposed, markDisposed }
}

/** Removes the zero-width characters Copilot's editor appends to the typed text. */
export function stripZeroWidth(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
}

/** Counts, before the question is typed, what the page already shows, so only new things count during the trial. */
function countBefore(selectors: WatchSelectors): WatchCounts {
  return {
    messagesBefore: document.querySelectorAll(selectors.message).length,
    repliesBefore: document.querySelectorAll(selectors.reply).length,
    botMessagesBefore: document.querySelectorAll(selectors.botMessage).length,
    alertTextsBefore: Array.from(document.querySelectorAll(selectors.answerError)).map((node) => (node.textContent ?? '').trim()),
  }
}

/**
 * Installs the trial's MutationObserver in the page. It stamps, with the
 * page's clock, the first moment each thing happened and keeps the state on
 * window.__copilotWatch for the adapter to read. Runs inside the page, so it
 * must not use anything from this module.
 */
function installWatch(args: WatchArgs): void {
  const strip = (text: string): string => text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  const state: CopilotWatchState = {
    typedText: args.typedText,
    clearedAt: null,
    editedAt: null,
    editedText: null,
    stopSeenAt: null,
    stopGoneAt: null,
    newMessageAt: null,
    firstTextAt: null,
    lastChangeAt: null,
    lastText: '',
    changes: 0,
    actionsAt: null,
    errorAt: null,
    errorText: null,
    offlineAt: null,
    cancelled: false,
  }
  window.__copilotWatchStop?.()
  window.__copilotWatch = state
  const check = (): void => {
    if (state.cancelled) return
    const now = Date.now()
    const editor = document.querySelector(args.input)
    const text = editor instanceof HTMLElement ? strip(editor.innerText) : ''
    if (state.clearedAt === null) {
      if (text === '') state.clearedAt = now
      else if (text !== state.typedText && state.editedAt === null) {
        state.editedAt = now
        state.editedText = text
      }
    }
    const stop = document.querySelector(args.stopButton)
    if (stop && state.stopSeenAt === null) state.stopSeenAt = now
    if (!stop && state.stopSeenAt !== null && state.stopGoneAt === null) state.stopGoneAt = now
    if (state.newMessageAt === null && document.querySelectorAll(args.message).length > args.messagesBefore) {
      state.newMessageAt = now
    }
    const reply = document.querySelectorAll(args.reply)[args.repliesBefore]
    const replyText = reply instanceof HTMLElement ? reply.innerText : ''
    if (replyText !== state.lastText) {
      if (state.firstTextAt === null && strip(replyText) !== '') state.firstTextAt = now
      state.lastChangeAt = now
      state.lastText = replyText
      state.changes += 1
    }
    const bot = document.querySelectorAll(args.botMessage)[args.botMessagesBefore]
    if (bot && state.actionsAt === null && bot.querySelector(args.messageActions)) state.actionsAt = now
    if (state.errorAt === null) {
      for (const alert of Array.from(document.querySelectorAll(args.answerError))) {
        const alertText = (alert.textContent ?? '').trim()
        if (alertText !== '' && !args.alertTextsBefore.includes(alertText)) {
          state.errorAt = now
          state.errorText = alertText
          break
        }
      }
    }
    if (state.offlineAt === null && document.querySelector(args.offline)) state.offlineAt = now
  }
  const observer = new MutationObserver(check)
  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'disabled', 'aria-disabled', 'alt', 'role', 'class', 'data-testid'],
  })
  window.__copilotWatchStop = () => {
    state.cancelled = true
    observer.disconnect()
  }
  check()
}

/** Reads the watch state for one mode. Runs inside the page on every poll. */
function readWatch(args: { mode: WatchMode; quietPeriodMs: number }): WatchResult | false {
  const state = window.__copilotWatch
  if (!state) return { gone: true }
  if (state.cancelled) return { cancelled: true }
  if (state.offlineAt !== null) return { offline: state.offlineAt }
  if (state.errorAt !== null && state.errorText !== null) return { error: state.errorText, at: state.errorAt }
  switch (args.mode) {
    case 'submit':
      if (state.editedAt !== null) return { edited: state.editedText ?? '' }
      if (state.clearedAt !== null) return { at: state.clearedAt }
      return false
    case 'confirm':
      if (state.stopSeenAt !== null) return { at: state.stopSeenAt }
      if (state.newMessageAt !== null) return { at: state.newMessageAt }
      return false
    case 'first':
      if (state.firstTextAt !== null) return { at: state.firstTextAt }
      return false
  }
}

/** Tells the page's observer to stop. Gives up after a moment if the page does not respond. */
async function cancelWatch(page: Page): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CANCEL_WATCH_TIMEOUT_MS)
  })
  try {
    const stopped = page
      .evaluate(() => {
        window.__copilotWatchStop?.()
      })
      .catch(() => undefined)
    await Promise.race([stopped, gaveUp])
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

/** The selectors the in-page watch needs: plain CSS, usable with querySelector. */
type WatchSelectors = Pick<
  CopilotSettings['selectors'],
  'input' | 'stopButton' | 'message' | 'botMessage' | 'reply' | 'messageActions' | 'answerError' | 'offline'
>

interface WatchCounts {
  messagesBefore: number
  repliesBefore: number
  botMessagesBefore: number
  alertTextsBefore: string[]
}

type WatchArgs = WatchSelectors & WatchCounts & { typedText: string }

/** The trial's in-page observations, all stamped with the page's clock; null until seen. */
interface CopilotWatchState {
  typedText: string
  /** The editor became empty: Copilot clearing it as it sends, or the Tester deleting the text. */
  clearedAt: number | null
  /** The editor's text stopped matching the question before it was sent. */
  editedAt: number | null
  editedText: string | null
  stopSeenAt: number | null
  stopGoneAt: number | null
  /** A message was added to the conversation. */
  newMessageAt: number | null
  /** The new answer first had text. */
  firstTextAt: number | null
  /** The new answer's text last changed. */
  lastChangeAt: number | null
  lastText: string
  changes: number
  /** The new answer's actions toolbar appeared: the message is complete. */
  actionsAt: number | null
  /** An alert with new text appeared. */
  errorAt: number | null
  errorText: string | null
  offlineAt: number | null
  cancelled: boolean
}

declare global {
  interface Window {
    /** The Copilot trial's in-page observations; see installWatch. */
    __copilotWatch?: CopilotWatchState
    /** Stops the observer and marks the watch cancelled; set by installWatch. */
    __copilotWatchStop?: () => void
  }
}
