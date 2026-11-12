import { randomUUID } from 'node:crypto'
import { FailureType } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import { SUBJECT_LABELS, type Subject } from '../../shared/subjects'
import { TrialStatus, type Trial, type TrialEvent, type TrialEventStatus } from '../../shared/trials'
import type { CapturedAnswer, SubjectAdapter } from '../adapters/subject-adapter'
import type { TrialTimeoutPolicy } from '../config/settings'
import type { MetricsRepository, NewTrial } from '../data/metrics-repository'
import type { QuestionBank } from './question-bank'
import type { SessionManager } from './session-manager'
import type { TimingService } from './timing-service'

export interface TrialControllerDeps {
  /** One adapter per subject, held for the whole session. */
  adapters: ReadonlyMap<Subject, SubjectAdapter>
  questions: Pick<QuestionBank, 'getByNumber'>
  timing: TimingService
  repository: Pick<MetricsRepository, 'saveTrial'>
  session: Pick<SessionManager, 'getCurrentSession' | 'buildDataSetName'>
  /** Each subject's time limit and when its clock starts. */
  timeouts: Record<Subject, TrialTimeoutPolicy>
  /** Where status events go: the IpcRouter. */
  events: { sendTrialEvent(event: TrialEvent): void }
  /** Clock for elapsed times; defaults to Date.now. Tests use fake timers. */
  now?: () => number
  /** Upper bound on waiting for adapter.dispose(), so the harness is ready again soon after a failure (NFR-3). */
  disposeTimeoutMs?: number
}

/** Why a trial ended before it completed. */
export interface TrialFailure {
  type: FailureType
  message: string
  /** Milliseconds from the trial's start to the failure. */
  elapsedMs: number
}

/** Thrown from startTrial when cancelTrial ended the trial. Nothing was saved. */
export class TrialCancelledError extends Error {
  override readonly name = 'TrialCancelledError'

  constructor(readonly trialId: string) {
    super('The trial was cancelled before the subject answered. Nothing was saved.')
  }
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 3_000

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
  /** True once the controller has released the trial; nothing more happens to it after that. */
  released = false
  private timer: ReturnType<typeof setTimeout> | null = null
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
 *    clock (see TrialTimeoutPolicy for when), and sends `started`.
 * 2. It drives the adapter through start, waitForFirstResponse,
 *    waitForCompletion, and captureAnswer, sending `first_response` on the
 *    way. Each step is raced against the trial being interrupted by the
 *    timer, by a failure, or by cancelTrial.
 * 3. closeTrial releases the adapter (dispose, bounded by disposeTimeoutMs)
 *    and the timer, saves the trial as SUCCESS or FAILED, and sends
 *    `completed` or `failed`.
 *
 * A cancelled trial rejects with TrialCancelledError and saves nothing. An
 * error from the harness itself (Chromium missing, the page closed under
 * the adapter) also saves nothing: the trial is released, `aborted` is
 * sent, and the error reaches the caller. Either way the controller is
 * ready for the next trial as soon as closeTrial returns.
 *
 * TODO(#28): failures reported by adapters are classified by the Failure
 * Detector next; until then they end the trial as aborted.
 * TODO(#35): confirmCompletion(trialId), for Copilot's streamed answer.
 * TODO(#37): markAnswerFound(trialId) and markNoAnswerFound(trialId), for
 * Google, where the Tester reports whether the answer was on the page.
 */
export class TrialController {
  private current: RunningTrial | null = null
  private readonly now: () => number
  private readonly disposeTimeoutMs: number

  constructor(private readonly deps: TrialControllerDeps) {
    this.now = deps.now ?? Date.now
    this.disposeTimeoutMs = deps.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
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
    const policy = this.deps.timeouts[subject]

    const trial = new RunningTrial(subject, question, adapter, this.now())
    this.current = trial
    if (policy.startsAt === 'trial_start') {
      trial.startTimer(policy.timeoutMs, () => this.onTimeout(trial))
    }
    this.send(trial, 'started')

    try {
      const beginMs = await trial.step(adapter.start(question))
      this.deps.timing.mark(trial.trialId, 'begin', beginMs)
      if (policy.startsAt === 'submit') {
        trial.startTimer(policy.timeoutMs, () => this.onTimeout(trial))
      }
      const firstResponseMs = await trial.step(adapter.waitForFirstResponse())
      this.deps.timing.mark(trial.trialId, 'first_response', firstResponseMs)
      this.send(trial, 'first_response')
      const endMs = await trial.step(adapter.waitForCompletion())
      this.deps.timing.mark(trial.trialId, 'end', endMs)
      // Completion reached: the clock stops here, before the answer is read.
      trial.stopTimer()
      trial.answer = await trial.step(adapter.captureAnswer())
      return await this.closeTrial(trial)
    } catch (error) {
      if (trial.released) {
        // closeTrial already released the trial and reported the problem (the save failed).
        throw error
      }
      const interruption = trial.interruption
      if (interruption?.kind === 'failure') {
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

  /** Ends the running trial without saving it. Resolves once the controller is ready again. */
  async cancelTrial(trialId: string): Promise<void> {
    const trial = this.current
    if (!trial || trial.trialId !== trialId) {
      throw new Error(`Trial ${trialId} is not running`)
    }
    trial.interrupt({ kind: 'cancel' })
    await trial.closed
  }

  /** The subject's clock ran out: the trial fails as TIMEOUT. */
  private onTimeout(trial: RunningTrial): void {
    if (this.current !== trial) return
    const limit = this.deps.timeouts[trial.subject].timeoutMs
    trial.interrupt({
      kind: 'failure',
      failure: {
        type: FailureType.TIMEOUT,
        message: `No answer from ${SUBJECT_LABELS[trial.subject]} within ${seconds(limit)}`,
        elapsedMs: this.elapsed(trial),
      },
    })
  }

  /**
   * Ends the trial and saves it: as SUCCESS with its answer, or as FAILED
   * with the failure. Sends `completed` or `failed` and returns the record.
   */
  private async closeTrial(trial: RunningTrial, failure?: TrialFailure): Promise<Trial> {
    const record = this.buildRecord(trial, failure)
    await this.releaseTrial(trial)
    let saved: Trial
    try {
      saved = this.deps.repository.saveTrial(record)
    } catch (error) {
      this.send(trial, 'aborted', { message: `The trial could not be saved: ${describe(error)}` })
      throw error
    }
    if (failure) {
      this.send(trial, 'failed', { message: failure.message, failureType: failure.type })
    } else {
      this.send(trial, 'completed')
    }
    return saved
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
      status: failure ? TrialStatus.FAILED : TrialStatus.SUCCESS,
      beginTs: beginMs === undefined ? null : timing.toIso(beginMs),
      firstResponseTs: firstResponseMs === undefined ? null : timing.toIso(firstResponseMs),
      endTs: endMs === undefined ? null : timing.toIso(endMs),
      responseMs: beginMs === undefined || endMs === undefined ? null : timing.durationMs(beginMs, endMs),
      firstResponseMs:
        beginMs === undefined || firstResponseMs === undefined ? null : timing.durationMs(beginMs, firstResponseMs),
      answerText: trial.answer?.text ?? null,
      citations: trial.answer?.citations ?? [],
    }
  }

  private send(
    trial: RunningTrial,
    status: TrialEventStatus,
    extra: { message?: string; failureType?: FailureType } = {},
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
