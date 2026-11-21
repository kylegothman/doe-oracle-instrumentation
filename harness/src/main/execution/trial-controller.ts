import { randomUUID } from 'node:crypto'
import { FailureType, type FailureSignal } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import { SUBJECT_LABELS, type Subject } from '../../shared/subjects'
import { TrialStatus, type Trial, type TrialEvent, type TrialEventStatus, type TrialFailure } from '../../shared/trials'
import type { AdapterNotice, CapturedAnswer, SubjectAdapter } from '../adapters/subject-adapter'
import type { TrialPolicy } from '../config/settings'
import type { MetricsRepository, NewTrial } from '../data/metrics-repository'
import { FailureDetector } from './failure-detector'
import type { QuestionBank } from './question-bank'
import type { SessionManager } from './session-manager'
import type { TimingEvent, TimingService } from './timing-service'

export interface TrialControllerDeps {
  /** One adapter per subject, held for the whole session. */
  adapters: ReadonlyMap<Subject, SubjectAdapter>
  questions: Pick<QuestionBank, 'getByNumber'>
  timing: TimingService
  repository: Pick<MetricsRepository, 'saveTrial'>
  session: Pick<SessionManager, 'getCurrentSession' | 'buildDataSetName'>
  /** Each subject's time limit, when its clock starts, and whether the Tester confirms the end. */
  policies: Record<Subject, TrialPolicy>
  /** Where status events go: the IpcRouter. */
  events: { sendTrialEvent(event: TrialEvent): void }
  /**
   * The system clipboard, read only when the Tester clicks Use Copied Text
   * on the copy step. Electron's `clipboard` in the app; tests pass a fake.
   */
  clipboard?: { readText(): string | Promise<string> }
  /** Classifies failure signals; defaults to the standard rules. */
  detector?: FailureDetector
  /** Clock for elapsed times; defaults to Date.now. Tests use fake timers. */
  now?: () => number
  /** Upper bound on waiting for adapter.dispose(), so the harness is ready again soon after a failure (NFR-3). */
  disposeTimeoutMs?: number
}

/** Thrown from startTrial when cancelTrial ended the trial. Nothing was saved. */
export class TrialCancelledError extends Error {
  override readonly name = 'TrialCancelledError'

  constructor(readonly trialId: string) {
    super('The trial was cancelled before the subject answered. Nothing was saved.')
  }
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 3_000
/** What the Tester is told once a confirmed subject's answer has finished. */
export const CONFIRM_PROMPT = 'The answer finished. Confirm the end, adjust it, or cancel the trial.'
/**
 * What the Tester is told once the results have loaded, for a subject whose
 * answer the Tester reports. With a limit it also says how long they have.
 */
export function answerFoundPrompt(answerLimitMs?: number): string {
  const prompt =
    'The results page loaded. In the browser window, highlight the passage that answers the question, then click Answer Found. If the answer is not on the page, click No Answer.'
  return answerLimitMs === undefined
    ? prompt
    : `${prompt} After ${seconds(answerLimitMs)} without either, the trial is saved as no answer found.`
}

/**
 * What the Tester is told when Answer Found could not read a highlight from
 * the page they were on.
 */
export const COPY_PROMPT =
  'The highlighted text could not be read from the page you opened (a PDF, for example). In the browser window, copy the highlighted text (Ctrl+C, or Cmd+C on a Mac), then click Use Copied Text. If the answer is not there after all, click No Answer Found.'

/** What Use Copied Text says when the clipboard holds no text. */
export const EMPTY_CLIPBOARD_MESSAGE =
  'The clipboard has no text. Copy the highlighted text in the browser window, then click Use Copied Text again.'

/**
 * What a trial can wait for the Tester to do once the subject has
 * completed: confirm the end, report the answer, or copy the highlighted
 * text the harness could not read.
 */
type TesterStep = 'end' | 'answer' | 'copy'

/** Why a trial was saved as NO_ANSWER_FOUND: the Tester said so, or the answer limit ran out. */
type NoAnswerReason = 'tester' | 'limit'

/**
 * What ends a wait for the Tester. `confirmed` carries the corrected end
 * for an 'end' wait, the moment of Answer Found for an 'answer' wait, and
 * the text the Tester copied and checked for a 'copy' wait.
 */
type TesterReport = { kind: 'confirmed'; atMs?: number; text?: string } | { kind: 'no_answer'; reason: NoAnswerReason }

/** What ended a trial early. */
type Interruption = { kind: 'failure'; failure: TrialFailure } | { kind: 'cancel' }

/** Thrown inside startTrial's step chain when the trial is interrupted; never escapes the controller. */
class TrialInterruptedError extends Error {
  override readonly name = 'TrialInterruptedError'

  constructor(readonly interruption: Interruption) {
    super(interruption.kind === 'cancel' ? 'cancelled' : interruption.failure.type)
  }
}

/** Everything about the trial in progress. */
class RunningTrial {
  readonly trialId = randomUUID()
  interruption: Interruption | null = null
  answer: CapturedAnswer | null = null
  /** When the Tester reported the answer was on the page, for a subject whose policy has answerFound. */
  answerFoundAtMs: number | null = null
  /** Set when the trial ends as NO_ANSWER_FOUND, with why. */
  noAnswer: NoAnswerReason | null = null
  /** On the copy step: the clipboard text last read and shown to the Tester, which is what a confirm saves. */
  copiedText: string | null = null
  /** True once the controller has released the trial; nothing more happens to it after that. */
  released = false
  /** The timed adapter step in flight, so its stamp can still be recorded if the trial is interrupted as it settles. */
  pending: { event: TimingEvent; work: Promise<number> } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Set while the trial waits for the Tester: to confirm the end, or to report the answer. */
  private confirmation: { waitingFor: TesterStep; resolve: (report: TesterReport) => void } | null = null
  private waitStarted: (() => void) | null = null
  private readonly interrupted: Promise<never>
  private rejectInterrupted: (error: TrialInterruptedError) => void = () => {}
  private resolveClosed: () => void = () => {}
  /** Resolves once the controller has released the trial. */
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve
  })

  constructor(
    readonly subject: Subject,
    readonly question: Question,
    readonly adapter: SubjectAdapter,
    readonly startedAtMs: number,
  ) {
    this.interrupted = new Promise<never>((_resolve, reject) => {
      this.rejectInterrupted = reject
    })
    this.interrupted.catch(() => {})
  }

  /** Resolves with the adapter's result unless the trial is interrupted first. */
  step<T>(work: Promise<T>): Promise<T> {
    if (this.interruption) {
      work.catch(() => {})
      return Promise.reject(new TrialInterruptedError(this.interruption))
    }
    return Promise.race([work, this.interrupted])
  }

  /** Ends the trial early. The first interruption wins; later ones are ignored. */
  interrupt(interruption: Interruption): boolean {
    if (this.interruption) return false
    this.interruption = interruption
    this.rejectInterrupted(new TrialInterruptedError(interruption))
    return true
  }

  /** What the trial is waiting for the Tester to do, or null when it waits for nothing. */
  get waitingFor(): TesterStep | null {
    return this.confirmation?.waitingFor ?? null
  }

  /** Resolves with what ended the wait: the Tester's report, or the answer limit running out. */
  awaitConfirmation(waitingFor: TesterStep): Promise<TesterReport> {
    return new Promise((resolve) => {
      this.confirmation = { waitingFor, resolve }
      const started = this.waitStarted
      this.waitStarted = null
      started?.()
    })
  }

  /** Resolves the next time the trial starts waiting for the Tester. */
  nextWait(): Promise<void> {
    return new Promise((resolve) => {
      this.waitStarted = resolve
    })
  }

  /** Ends the wait. The first report wins; a later one finds nothing waiting and is ignored. */
  confirm(report: TesterReport): void {
    const confirmation = this.confirmation
    this.confirmation = null
    confirmation?.resolve(report)
  }

  startTimer(ms: number, onExpiry: () => void): void {
    this.stopTimer()
    this.timer = setTimeout(onExpiry, ms)
  }

  stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  markClosed(): void {
    this.released = true
    this.resolveClosed()
  }
}

/**
 * The Test Execution core (Detailed Design 3.2 and 3.3, story #27): runs
 * every trial, for every subject, the same way. One trial at a time:
 *
 * 1. startTrial looks up the adapter and the question, starts the subject's
 *    clock (see TrialPolicy for when), and sends `started`.
 * 2. It drives the adapter through start, waitForFirstResponse,
 *    waitForCompletion, and captureAnswer, sending `first_response` on the
 *    way, and `awaiting_submit` when an adapter reports that the Tester
 *    must submit the question (Copilot: the clock has not started yet).
 *    The clock stops at completion. For a subject whose policy has
 *    confirmEnd, the controller then sends `awaiting_confirmation` with
 *    the detected begin and end and waits for confirmCompletion, which may
 *    replace the end, before the answer is captured; the Tester has as
 *    long as they like. For a subject whose policy has answerFound
 *    (Google, story #37) completion is the results page finishing loading:
 *    the controller sends `awaiting_confirmation` with begin and that end,
 *    and the same confirmCompletion call is the Tester's Answer Found. The
 *    moment it arrives is stamped, the answer is captured, and the trial is
 *    saved with its page-load time (begin to end), time to answer (begin to
 *    Answer Found), and source URL. reportNoAnswer, or the policy's
 *    answerLimitMs running out with neither call, saves the trial as
 *    NO_ANSWER_FOUND instead: a result, not a failure, with its page-load
 *    time and no answer. When the captured answer is marked unreadable
 *    (the Tester highlighted inside a PDF, which the harness cannot read),
 *    nothing is saved yet: the controller sends `awaiting_copied_text` and
 *    waits, with no timer running. readCopiedText reads the clipboard for
 *    the Tester to check, and confirmCompletion then saves that text as
 *    the answer, with the time to answer of the Answer Found click and the
 *    page they were on as the source. reportNoAnswer and cancelTrial work
 *    there as before. Each step is raced against the trial being
 *    interrupted by the timer, by a failure signal from the adapter, or by
 *    cancelTrial.
 * 3. On a failure (SD-4): the FailureDetector classifies the signal, the
 *    adapter is disposed, the clock stops, and closeTrial saves the trial
 *    as FAILED with a failed_requests row and sends `failed`. The failed
 *    trial is returned like a successful one. A captured answer that is
 *    empty fails the same way, as EMPTY_ANSWER, for every subject.
 * 4. On success closeTrial saves the trial as SUCCESS and sends `completed`.
 *    A NO_ANSWER_FOUND trial is saved and sends `completed` too, with a
 *    message saying why; the record carries the status.
 *
 * A cancelled trial rejects with TrialCancelledError and saves nothing. An
 * error from the harness itself (Chromium missing, the page closed under
 * the adapter) also saves nothing: the trial is released, `aborted` is
 * sent, and the error reaches the caller. Either way the controller is
 * ready for the next trial as soon as closeTrial returns.
 */
export class TrialController {
  private current: RunningTrial | null = null
  private readonly now: () => number
  private readonly disposeTimeoutMs: number
  private readonly detector: FailureDetector

  constructor(private readonly deps: TrialControllerDeps) {
    this.now = deps.now ?? Date.now
    this.disposeTimeoutMs = deps.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
    this.detector = deps.detector ?? new FailureDetector()
  }

  /** True when no trial is running, so startTrial can be called. */
  isReady(): boolean {
    return this.current === null
  }

  /** The id of the trial in progress, or null. */
  get runningTrialId(): string | null {
    return this.current?.trialId ?? null
  }

  /** Runs one trial and resolves with the saved record, whether it succeeded or failed. */
  async startTrial(subject: Subject, questionNumber: number): Promise<Trial> {
    if (this.current) {
      throw new Error('A trial is already running. Wait for it to finish, then try again.')
    }
    const adapter = this.deps.adapters.get(subject)
    if (!adapter) {
      throw new Error(`No adapter is registered for ${SUBJECT_LABELS[subject]}`)
    }
    const question = this.deps.questions.getByNumber(questionNumber)
    const policy = this.deps.policies[subject]

    const trial = new RunningTrial(subject, question, adapter, this.now())
    this.current = trial
    adapter.onFailure((signal) => this.onFailureSignal(trial, signal))
    adapter.onNotice?.((notice) => this.onNotice(trial, notice))
    if (policy.startsAt === 'trial_start') {
      trial.startTimer(policy.timeoutMs, () => this.onTimeout(trial))
    }
    this.send(trial, 'started')

    try {
      await this.timedStep(trial, 'begin', adapter.start(question))
      if (policy.startsAt === 'submit') {
        trial.startTimer(policy.timeoutMs, () => this.onTimeout(trial))
      }
      await this.timedStep(trial, 'first_response', adapter.waitForFirstResponse())
      this.send(trial, 'first_response')
      await this.timedStep(trial, 'end', adapter.waitForCompletion())
      // Completion reached: the clock stops here, before the answer is read.
      trial.stopTimer()
      if (policy.confirmEnd) {
        const marks = this.deps.timing.getMarks(trial.trialId)
        this.send(trial, 'awaiting_confirmation', { message: CONFIRM_PROMPT, beginMs: marks.begin, endMs: marks.end })
        const report = await trial.step(trial.awaitConfirmation('end'))
        if (report.kind === 'confirmed' && report.atMs !== undefined) {
          this.deps.timing.mark(trial.trialId, 'end', report.atMs)
        }
      }
      if (policy.answerFound) {
        const marks = this.deps.timing.getMarks(trial.trialId)
        const limitMs = policy.answerLimitMs
        this.send(trial, 'awaiting_confirmation', { message: answerFoundPrompt(limitMs), beginMs: marks.begin, endMs: marks.end })
        if (limitMs !== undefined) {
          // The answer limit counts from the results loading, not from this line.
          const remainingMs = Math.max(0, (marks.end ?? this.now()) + limitMs - this.now())
          trial.startTimer(remainingMs, () => trial.confirm({ kind: 'no_answer', reason: 'limit' }))
        }
        const report = await trial.step(trial.awaitConfirmation('answer'))
        trial.stopTimer()
        if (report.kind === 'no_answer') {
          // A result, not a failure: nothing is read from the page and no failure is recorded.
          trial.noAnswer = report.reason
          return await this.closeTrial(trial)
        }
        trial.answerFoundAtMs = report.atMs ?? null
      }
      trial.answer = await trial.step(adapter.captureAnswer())
      if (policy.answerFound && trial.answer.unreadable) {
        // The Tester was on a page whose highlight cannot be read (a PDF). Nothing is saved yet: they copy
        // the text and confirm it. No timer runs here; the time to answer stays the Answer Found click.
        const unread = trial.answer
        trial.answer = null
        const marks = this.deps.timing.getMarks(trial.trialId)
        this.send(trial, 'awaiting_copied_text', {
          message: COPY_PROMPT,
          beginMs: marks.begin,
          endMs: marks.end,
          ...(trial.answerFoundAtMs === null ? {} : { answerFoundMs: trial.answerFoundAtMs }),
          ...(unread.sourceUrl === undefined ? {} : { sourceUrl: unread.sourceUrl }),
        })
        const report = await trial.step(trial.awaitConfirmation('copy'))
        if (report.kind === 'no_answer') {
          // The same result as No Answer Found on the results: no answer, no time to answer, no source.
          trial.answerFoundAtMs = null
          trial.noAnswer = report.reason
          return await this.closeTrial(trial)
        }
        trial.answer = { text: report.text ?? '', citations: [], ...(unread.sourceUrl === undefined ? {} : { sourceUrl: unread.sourceUrl }) }
      }
      // The subject-independent check: an answer with no text is a failure, whatever the adapter said.
      this.onFailureSignal(trial, { answerText: trial.answer.text, timedOut: false })
      return await this.closeTrial(trial, trial.interruption?.kind === 'failure' ? trial.interruption.failure : undefined)
    } catch (error) {
      if (trial.released) {
        // closeTrial already released the trial and reported the problem (the save failed).
        throw error
      }
      const interruption = trial.interruption
      if (interruption?.kind === 'failure') {
        await this.recoverPendingMark(trial)
        return this.closeTrial(trial, interruption.failure)
      }
      if (interruption?.kind === 'cancel') {
        await this.abandonTrial(trial, 'cancelled', 'Cancelled by the Tester')
        throw new TrialCancelledError(trial.trialId)
      }
      await this.abandonTrial(trial, 'aborted', describe(error))
      throw error
    }
  }

  /**
   * The Tester confirmed a trial that is awaiting confirmation.
   *
   * For a subject whose end the Tester confirms: keeps the detected end, or
   * replaces it with endMs, which must not be before the question was sent.
   *
   * For a subject whose answer the Tester reports (Google), this is Answer
   * Found: the moment the call arrives is the time to answer, read from the
   * main process's clock, so endMs is refused. On the copy step it confirms
   * the text readCopiedText last returned, and that text is saved.
   *
   * The trial is then captured and saved; resolves once that is done and
   * the controller is ready again, or once the trial waits on the copy step.
   */
  async confirmCompletion(trialId: string, endMs?: number): Promise<void> {
    const trial = this.current
    if (!trial || trial.trialId !== trialId) {
      throw new Error(`Trial ${trialId} is not running`)
    }
    if (trial.waitingFor === null) {
      throw new Error('The trial is not waiting for confirmation: its answer has not finished yet')
    }
    if (trial.waitingFor === 'answer' || trial.waitingFor === 'copy') {
      if (endMs !== undefined) {
        throw new Error(
          `The time to answer for ${SUBJECT_LABELS[trial.subject]} is the moment Answer Found is clicked. It cannot be adjusted.`,
        )
      }
      if (trial.waitingFor === 'answer') {
        const copyStep = trial.nextWait()
        trial.confirm({ kind: 'confirmed', atMs: this.now() })
        // Done once the trial is saved, or once it waits for the Tester to copy the text it could not read.
        await Promise.race([trial.closed, copyStep])
        return
      }
      if (trial.copiedText === null) {
        throw new Error('No copied text has been read yet. Copy the highlighted text, then click Use Copied Text.')
      }
      trial.confirm({ kind: 'confirmed', text: trial.copiedText })
      await trial.closed
      return
    }
    if (endMs !== undefined) {
      const { timing } = this.deps
      if (typeof endMs !== 'number' || !Number.isFinite(endMs)) {
        throw new Error(`The corrected end must be a number of epoch milliseconds, got ${String(endMs)}`)
      }
      const beginMs = timing.getMarks(trialId).begin
      if (beginMs !== undefined && endMs < beginMs) {
        throw new Error(`The corrected end (${timing.toIso(endMs)}) is before the question was sent (${timing.toIso(beginMs)})`)
      }
    }
    trial.confirm(endMs === undefined ? { kind: 'confirmed' } : { kind: 'confirmed', atMs: endMs })
    await trial.closed
  }

  /**
   * The Tester reported that the answer is not on the page, for a trial
   * that is waiting for them to report it (Google, story #37). The trial is
   * saved as NO_ANSWER_FOUND; resolves once that is done and the controller
   * is ready again.
   */
  async reportNoAnswer(trialId: string): Promise<void> {
    const trial = this.current
    if (!trial || trial.trialId !== trialId) {
      throw new Error(`Trial ${trialId} is not running`)
    }
    if (trial.waitingFor === 'end') {
      throw new Error(
        `A ${SUBJECT_LABELS[trial.subject]} trial has no "no answer" result. Confirm the end of the answer, or cancel the trial.`,
      )
    }
    if (trial.waitingFor !== 'answer' && trial.waitingFor !== 'copy') {
      throw new Error('The trial is not waiting for the Tester to report the answer: the results have not loaded yet')
    }
    trial.confirm({ kind: 'no_answer', reason: 'tester' })
    await trial.closed
  }

  /**
   * Use Copied Text, on the copy step: reads the system clipboard and
   * resolves with its text, trimmed, for the Tester to check. Nothing is
   * saved; confirmCompletion then saves exactly this text. An empty string
   * means the clipboard held no text, and the step goes on waiting. The
   * clipboard is read only here, on the Tester's click.
   */
  async readCopiedText(trialId: string): Promise<string> {
    const trial = this.current
    if (!trial || trial.trialId !== trialId) {
      throw new Error(`Trial ${trialId} is not running`)
    }
    if (trial.waitingFor !== 'copy') {
      throw new Error('The trial is not waiting for copied text')
    }
    const { clipboard } = this.deps
    if (!clipboard) {
      throw new Error('The clipboard is not available to the harness')
    }
    const text = (await clipboard.readText()).replace(/\r\n?/g, '\n').trim()
    if (text !== '') trial.copiedText = text
    return text
  }

  /** Ends the running trial without saving it. Resolves once the controller is ready again. */
  async cancelTrial(trialId: string): Promise<void> {
    const trial = this.current
    if (!trial || trial.trialId !== trialId) {
      throw new Error(`Trial ${trialId} is not running`)
    }
    trial.interrupt({ kind: 'cancel' })
    await trial.closed
  }

  /** Runs a timed adapter step and records its stamp. */
  private async timedStep(trial: RunningTrial, event: TimingEvent, work: Promise<number>): Promise<void> {
    trial.pending = { event, work }
    const ms = await trial.step(work)
    trial.pending = null
    this.deps.timing.mark(trial.trialId, event, ms)
  }

  /**
   * An adapter may resolve a step and report a failure in the same tick,
   * as the Oracle adapter does when Playwright delivers a request and its
   * failure together. The interruption then wins the race before the
   * step's stamp is recorded. Once the microtasks have drained, the step's
   * promise has settled if it was going to; record its stamp so the failed
   * trial keeps every mark the subject actually reached.
   */
  private async recoverPendingMark(trial: RunningTrial): Promise<void> {
    const pending = trial.pending
    trial.pending = null
    if (!pending) return
    await new Promise<void>((resolve) => process.nextTick(resolve))
    const unsettled = Symbol('unsettled')
    const value = await Promise.race([pending.work, Promise.resolve(unsettled)]).catch(() => unsettled)
    if (typeof value === 'number') {
      this.deps.timing.mark(trial.trialId, pending.event, value)
    }
  }

  /** The adapter needs the Tester to do something: pass it on as an event. */
  private onNotice(trial: RunningTrial, notice: AdapterNotice): void {
    if (this.current !== trial || trial.released) return
    this.send(trial, notice.status, { message: notice.message })
  }

  /** The subject's clock ran out: the trial fails as TIMEOUT. */
  private onTimeout(trial: RunningTrial): void {
    this.onFailureSignal(trial, { timedOut: true })
  }

  /**
   * A signal from the adapter (or the clock). Classified by the detector;
   * a signal that is not a failure by the rules is ignored and the trial
   * goes on. The first failure ends the trial; later ones are ignored.
   */
  private onFailureSignal(trial: RunningTrial, signal: FailureSignal): void {
    if (this.current !== trial || trial.released) return
    const type = this.detector.classify(signal)
    if (!type) return
    trial.interrupt({
      kind: 'failure',
      failure: { type, message: this.failureMessage(trial, type, signal), elapsedMs: this.elapsed(trial) },
    })
  }

  private failureMessage(trial: RunningTrial, type: FailureType, signal: FailureSignal): string {
    const label = SUBJECT_LABELS[trial.subject]
    switch (type) {
      case FailureType.TIMEOUT:
        return `No answer from ${label} within ${seconds(this.deps.policies[trial.subject].timeoutMs)}`
      case FailureType.ERROR_RESPONSE:
        return signal.httpStatus !== undefined && signal.httpStatus >= 400
          ? `${label} answered with HTTP ${String(signal.httpStatus)}`
          : `${label} showed an error instead of an answer: ${signal.errorMessage ?? ''}`
      case FailureType.UNREACHABLE:
        return signal.networkError ?? `${label} could not be reached`
      case FailureType.EMPTY_ANSWER:
        return `${label} completed with an empty answer`
    }
  }

  /**
   * Ends the trial and saves it: as SUCCESS with its answer, as
   * NO_ANSWER_FOUND, or as FAILED with the failure. Sends `completed` or
   * `failed` and returns the record.
   */
  private async closeTrial(trial: RunningTrial, failure?: TrialFailure): Promise<Trial> {
    const record = this.buildRecord(trial, failure)
    await this.releaseTrial(trial)
    let saved: Trial
    try {
      saved = this.deps.repository.saveTrial(record, failure)
    } catch (error) {
      this.send(trial, 'aborted', { message: `The trial could not be saved: ${describe(error)}` })
      throw error
    }
    if (failure) {
      this.send(trial, 'failed', { message: failure.message, failureType: failure.type })
    } else if (trial.noAnswer) {
      this.send(trial, 'completed', { message: this.noAnswerMessage(trial, trial.noAnswer) })
    } else {
      this.send(trial, 'completed')
    }
    return saved
  }

  private noAnswerMessage(trial: RunningTrial, reason: NoAnswerReason): string {
    const limitMs = this.deps.policies[trial.subject].answerLimitMs
    return reason === 'tester' || limitMs === undefined
      ? 'Saved as no answer found: the Tester reported that the answer is not on the page.'
      : `Saved as no answer found: no answer was reported within ${seconds(limitMs)} of the results loading.`
  }

  /** Ends a trial that is not saved: cancelled by the Tester, or aborted by a harness error. */
  private async abandonTrial(trial: RunningTrial, status: 'cancelled' | 'aborted', message: string): Promise<void> {
    await this.releaseTrial(trial)
    this.send(trial, status, { message })
  }

  /** Stops the clock, disposes the adapter (bounded), forgets the marks, and frees the controller. */
  private async releaseTrial(trial: RunningTrial): Promise<void> {
    trial.stopTimer()
    try {
      await withTimeout(trial.adapter.dispose(), this.disposeTimeoutMs)
    } catch (error) {
      console.warn(`[trial] ${SUBJECT_LABELS[trial.subject]} adapter did not dispose cleanly: ${describe(error)}`)
    }
    this.deps.timing.clear(trial.trialId)
    if (this.current === trial) {
      this.current = null
    }
    trial.markClosed()
  }

  private buildRecord(trial: RunningTrial, failure?: TrialFailure): NewTrial {
    const { timing, session } = this.deps
    const marks = timing.getMarks(trial.trialId)
    const beginMs = marks.begin
    const firstResponseMs = marks.first_response
    const endMs = marks.end
    return {
      trialId: trial.trialId,
      sessionId: session.getCurrentSession().sessionId,
      dataSetName: session.buildDataSetName(trial.subject, new Date(beginMs ?? trial.startedAtMs)),
      subject: trial.subject,
      questionNumber: trial.question.number,
      status: failure ? TrialStatus.FAILED : trial.noAnswer ? TrialStatus.NO_ANSWER_FOUND : TrialStatus.SUCCESS,
      beginTs: beginMs === undefined ? null : timing.toIso(beginMs),
      firstResponseTs: firstResponseMs === undefined ? null : timing.toIso(firstResponseMs),
      endTs: endMs === undefined ? null : timing.toIso(endMs),
      responseMs: beginMs === undefined || endMs === undefined ? null : timing.durationMs(beginMs, endMs),
      firstResponseMs:
        beginMs === undefined || firstResponseMs === undefined ? null : timing.durationMs(beginMs, firstResponseMs),
      answerText: trial.answer?.text ?? null,
      citations: trial.answer?.citations ?? [],
      // Only a subject whose answer the Tester reports has these three; the others leave them null.
      ...(this.deps.policies[trial.subject].answerFound
        ? {
            pageLoadMs: beginMs === undefined || endMs === undefined ? null : timing.durationMs(beginMs, endMs),
            timeToAnswerMs:
              beginMs === undefined || trial.answerFoundAtMs === null ? null : timing.durationMs(beginMs, trial.answerFoundAtMs),
            sourceUrl: trial.answer?.sourceUrl ?? null,
          }
        : {}),
    }
  }

  private send(
    trial: RunningTrial,
    status: TrialEventStatus,
    extra: { message?: string; failureType?: FailureType; beginMs?: number; endMs?: number; answerFoundMs?: number; sourceUrl?: string } = {},
  ): void {
    try {
      this.deps.events.sendTrialEvent({
        trialId: trial.trialId,
        subject: trial.subject,
        questionNumber: trial.question.number,
        status,
        elapsedMs: this.elapsed(trial),
        ...extra,
      })
    } catch (error) {
      console.warn(`[trial] Could not send the ${status} event: ${describe(error)}`)
    }
  }

  private elapsed(trial: RunningTrial): number {
    return Math.max(0, this.now() - trial.startedAtMs)
  }
}

/** Resolves or rejects with the work, or rejects after ms if the work has not settled. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${seconds(ms)}`)), ms)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`
}
