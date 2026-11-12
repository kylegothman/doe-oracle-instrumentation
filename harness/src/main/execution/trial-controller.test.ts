import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FailureSignal } from '../../shared/failures'
import { FailureType } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import { Subject } from '../../shared/subjects'
import { TrialStatus, type TrialEvent } from '../../shared/trials'
import type { CapturedAnswer, SubjectAdapter } from '../adapters/subject-adapter'
import type { TrialTimeoutPolicy } from '../config/settings'
import { MetricsRepository } from '../data/metrics-repository'
import { QuestionBank } from './question-bank'
import { SessionManager } from './session-manager'
import { TimingService } from './timing-service'
import { TrialCancelledError, TrialController } from './trial-controller'

const QUESTIONS = new QuestionBank([
  { number: 1, text: 'What is combinatorial testing?' },
  { number: 2, text: 'What makes combinatorial testing cost effective?' },
])
const T0 = Date.UTC(2026, 10, 12, 15, 0, 0, 0)

type Step = 'start' | 'first' | 'completion' | 'capture' | 'dispose'

interface Script {
  /** Timestamps the adapter reports; default to T0 plus small offsets. */
  begin?: number
  first?: number
  end?: number
  answer?: Partial<CapturedAnswer>
  /** Milliseconds each step takes (fake timers), or 'never' for a step that hangs. */
  delays?: Partial<Record<Step, number | 'never'>>
  /** Steps that reject with this message instead of resolving. */
  errors?: Partial<Record<Step, string>>
  /** Signals reported through onFailure right after a step settles, as the real adapter does. */
  signals?: Partial<Record<Step, FailureSignal>>
}

/** An adapter that follows a script, records its calls, and keeps the failure handler it was given. */
class FakeAdapter implements SubjectAdapter {
  readonly calls: string[] = []
  handler: ((signal: FailureSignal) => void) | null = null

  constructor(
    readonly subject: Subject,
    private readonly script: Script = {},
  ) {}

  start(question: Question): Promise<number> {
    this.calls.push(`start:${question.number}`)
    return this.run('start', () => this.script.begin ?? T0 + 1_000)
  }

  waitForFirstResponse(): Promise<number> {
    this.calls.push('first')
    return this.run('first', () => this.script.first ?? T0 + 1_300)
  }

  waitForCompletion(): Promise<number> {
    this.calls.push('completion')
    return this.run('completion', () => this.script.end ?? T0 + 1_900)
  }

  captureAnswer(): Promise<CapturedAnswer> {
    this.calls.push('capture')
    return this.run('capture', () => ({ text: 'An answer.', citations: ['a.pdf · p.1'], ...this.script.answer }))
  }

  onFailure(handler: (signal: FailureSignal) => void): void {
    this.handler = handler
  }

  dispose(): Promise<void> {
    this.calls.push('dispose')
    return this.run('dispose', () => undefined)
  }

  private run<T>(step: Step, value: () => T): Promise<T> {
    const delay = this.script.delays?.[step]
    const error = this.script.errors?.[step]
    const signal = this.script.signals?.[step]
    const settle = (resolve: (v: T) => void, reject: (e: Error) => void): void => {
      if (error) reject(new Error(error))
      else resolve(value())
      if (signal) this.handler?.(signal)
    }
    if (delay === 'never') return new Promise(() => {})
    if (!delay) return new Promise(settle)
    return new Promise((resolve, reject) => setTimeout(() => settle(resolve, reject), delay))
  }
}

function policies(overrides: Partial<Record<Subject, Partial<TrialTimeoutPolicy>>> = {}): Record<Subject, TrialTimeoutPolicy> {
  return {
    [Subject.DOE_ORACLE]: { timeoutMs: 60_000, startsAt: 'trial_start', ...overrides[Subject.DOE_ORACLE] },
    [Subject.COPILOT]: { timeoutMs: 60_000, startsAt: 'submit', ...overrides[Subject.COPILOT] },
    [Subject.GOOGLE]: { timeoutMs: 60_000, startsAt: 'submit', ...overrides[Subject.GOOGLE] },
  }
}

describe('TrialController', () => {
  let repository: MetricsRepository
  let events: TrialEvent[]

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    repository = await MetricsRepository.open(':memory:')
    events = []
  })

  afterEach(() => {
    repository.close()
    vi.useRealTimers()
  })

  function startedSession(): SessionManager {
    const session = new SessionManager({ store: repository, appVersion: '0.1.0', sessionId: () => 'session-1' })
    session.startSession()
    return session
  }

  function controllerWith(
    adapters: FakeAdapter[],
    options: { timeouts?: Record<Subject, TrialTimeoutPolicy>; repository?: Pick<MetricsRepository, 'saveTrial'> } = {},
  ) {
    return new TrialController({
      adapters: new Map(adapters.map((adapter) => [adapter.subject, adapter])),
      questions: QUESTIONS,
      timing: new TimingService(),
      repository: options.repository ?? repository,
      session: startedSession(),
      timeouts: options.timeouts ?? policies(),
      events: { sendTrialEvent: (event) => events.push(event) },
    })
  }

  function statuses(): string[] {
    return events.map((event) => event.status)
  }

  it('runs the trial in order, times it, saves it as SUCCESS, sends the events, and disposes the adapter', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { delays: { first: 300, completion: 600 } })
    const controller = controllerWith([adapter])

    const pending = controller.startTrial(Subject.DOE_ORACLE, 1)
    expect(controller.isReady()).toBe(false)
    await vi.advanceTimersByTimeAsync(900)
    const saved = await pending

    expect(adapter.calls).toEqual(['start:1', 'first', 'completion', 'capture', 'dispose'])
    expect(saved).toMatchObject({
      testNumber: 1,
      sessionId: 'session-1',
      dataSetName: `DOE_ORACLE-${localDate(new Date(T0 + 1_000))}`,
      subject: Subject.DOE_ORACLE,
      questionNumber: 1,
      status: TrialStatus.SUCCESS,
      beginTs: '2026-11-12T15:00:01.000Z',
      firstResponseTs: '2026-11-12T15:00:01.300Z',
      endTs: '2026-11-12T15:00:01.900Z',
      responseMs: 900,
      firstResponseMs: 300,
      answerText: 'An answer.',
      citations: ['a.pdf · p.1'],
    })
    expect(repository.listTrials()).toEqual([saved])
    expect(events).toEqual([
      { trialId: saved.trialId, subject: Subject.DOE_ORACLE, questionNumber: 1, status: 'started', elapsedMs: 0 },
      { trialId: saved.trialId, subject: Subject.DOE_ORACLE, questionNumber: 1, status: 'first_response', elapsedMs: 300 },
      { trialId: saved.trialId, subject: Subject.DOE_ORACLE, questionNumber: 1, status: 'completed', elapsedMs: 900 },
    ])
    expect(controller.isReady()).toBe(true)
    expect(controller.runningTrialId).toBeNull()
  })

  it('runs only one trial at a time', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { delays: { completion: 1_000 } })
    const controller = controllerWith([adapter])

    const running = controller.startTrial(Subject.DOE_ORACLE, 1)
    await expect(controller.startTrial(Subject.DOE_ORACLE, 2)).rejects.toThrow(/already running/)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(running).resolves.toMatchObject({ testNumber: 1, questionNumber: 1 })
    expect(repository.listTrials()).toHaveLength(1)
    expect(statuses()).toEqual(['started', 'first_response', 'completed'])
  })

  it('fails the trial as TIMEOUT when the subject clock runs out, keeping the marks it reached', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { delays: { completion: 'never' } })
    const controller = controllerWith([adapter])

    const pending = controller.startTrial(Subject.DOE_ORACLE, 1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(controller.isReady()).toBe(false)
    expect(statuses()).toEqual(['started', 'first_response'])
    await vi.advanceTimersByTimeAsync(1)
    const saved = await pending

    expect(saved).toMatchObject({
      status: TrialStatus.FAILED,
      beginTs: '2026-11-12T15:00:01.000Z',
      firstResponseTs: '2026-11-12T15:00:01.300Z',
      endTs: null,
      responseMs: null,
      firstResponseMs: 300,
      answerText: null,
      citations: [],
    })
    expect(repository.listTrials()).toEqual([saved])
    expect(events.at(-1)).toMatchObject({
      status: 'failed',
      failureType: FailureType.TIMEOUT,
      elapsedMs: 60_000,
      message: 'No answer from DOE Oracle within 60 s',
    })
    expect(adapter.calls).toEqual(['start:1', 'first', 'completion', 'dispose'])
    expect(controller.isReady()).toBe(true)
  })

  it('saves the timeout as a TIMEOUT failure record that reads back with the trial', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { delays: { completion: 'never' } })
    const controller = controllerWith([adapter], { timeouts: policies({ [Subject.DOE_ORACLE]: { timeoutMs: 2_000 } }) })

    const pending = controller.startTrial(Subject.DOE_ORACLE, 1)
    await vi.advanceTimersByTimeAsync(2_000)
    const saved = await pending

    expect(saved.failure).toEqual({ type: FailureType.TIMEOUT, message: 'No answer from DOE Oracle within 2 s', elapsedMs: 2_000 })
    expect(repository.listTrials()[0]?.failure).toEqual(saved.failure)
  })

  it('fails as ERROR_RESPONSE when the adapter reports an error status, keeping the first-response mark', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, {
      delays: { first: 400, completion: 'never' },
      signals: { first: { httpStatus: 500, timedOut: false } },
    })
    const controller = controllerWith([adapter])

    const pending = controller.startTrial(Subject.DOE_ORACLE, 1)
    await vi.advanceTimersByTimeAsync(400)
    const saved = await pending

    expect(saved).toMatchObject({
      status: TrialStatus.FAILED,
      beginTs: '2026-11-12T15:00:01.000Z',
      firstResponseTs: '2026-11-12T15:00:01.300Z',
      firstResponseMs: 300,
      endTs: null,
      failure: { type: FailureType.ERROR_RESPONSE, message: 'DOE Oracle answered with HTTP 500', elapsedMs: 400 },
    })
    expect(statuses()).toEqual(['started', 'first_response', 'failed'])
    expect(events.at(-1)).toMatchObject({ failureType: FailureType.ERROR_RESPONSE, message: 'DOE Oracle answered with HTTP 500' })
    expect(adapter.calls).toEqual(['start:1', 'first', 'completion', 'dispose'])
    expect(controller.isReady()).toBe(true)
  })

  it('fails as UNREACHABLE when the subject cannot be reached, with no marks at all', async () => {
    const message = 'Could not reach the DOE Oracle at http://localhost:5173/chat. Make sure it is running, then try again. (net::ERR_CONNECTION_REFUSED)'
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, {
      errors: { start: message },
      signals: { start: { networkError: message, timedOut: false } },
    })
    const controller = controllerWith([adapter])

    const saved = await controller.startTrial(Subject.DOE_ORACLE, 1)

    expect(saved).toMatchObject({
      status: TrialStatus.FAILED,
      dataSetName: `DOE_ORACLE-${localDate(new Date(T0))}`,
      beginTs: null,
      firstResponseTs: null,
      endTs: null,
      responseMs: null,
      firstResponseMs: null,
      failure: { type: FailureType.UNREACHABLE, message, elapsedMs: 0 },
    })
    expect(repository.listTrials()).toEqual([saved])
    expect(statuses()).toEqual(['started', 'failed'])
  })

  it('fails as EMPTY_ANSWER when the completed answer has no text, keeping all three marks', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { answer: { text: '  \n ', citations: [] } })
    const controller = controllerWith([adapter])

    const saved = await controller.startTrial(Subject.DOE_ORACLE, 1)

    expect(saved).toMatchObject({
      status: TrialStatus.FAILED,
      responseMs: 900,
      firstResponseMs: 300,
      answerText: '  \n ',
      failure: { type: FailureType.EMPTY_ANSWER, message: 'DOE Oracle completed with an empty answer' },
    })
    expect(statuses()).toEqual(['started', 'first_response', 'failed'])
  })

  it('treats a refusal as an answer: the trial succeeds', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { answer: { text: "I can't answer that question.", citations: [] } })
    const controller = controllerWith([adapter])

    const saved = await controller.startTrial(Subject.DOE_ORACLE, 1)

    expect(saved).toMatchObject({ status: TrialStatus.SUCCESS, answerText: "I can't answer that question." })
    expect(saved.failure).toBeUndefined()
  })

  it('ignores a signal that is not a failure by the rules', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { signals: { first: { httpStatus: 200, timedOut: false } } })
    const controller = controllerWith([adapter])

    await expect(controller.startTrial(Subject.DOE_ORACLE, 1)).resolves.toMatchObject({ status: TrialStatus.SUCCESS })
  })

  it('starts the clock at submit for subjects configured that way, so a slow Tester is not a timeout', async () => {
    const adapter = new FakeAdapter(Subject.COPILOT, { delays: { start: 30_000, completion: 'never' } })
    const controller = controllerWith([adapter], { timeouts: policies({ [Subject.COPILOT]: { timeoutMs: 10_000 } }) })

    const pending = controller.startTrial(Subject.COPILOT, 1)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(controller.isReady()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toMatchObject({ status: TrialStatus.FAILED, subject: Subject.COPILOT })
    expect(events.at(-1)).toMatchObject({ status: 'failed', failureType: FailureType.TIMEOUT, elapsedMs: 40_000 })
  })

  it('stops the clock when completion is reached, so a slow capture does not time out', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { delays: { completion: 50_000, capture: 20_000 } })
    const controller = controllerWith([adapter])

    const pending = controller.startTrial(Subject.DOE_ORACLE, 1)
    await vi.advanceTimersByTimeAsync(70_000)

    await expect(pending).resolves.toMatchObject({ status: TrialStatus.SUCCESS, answerText: 'An answer.' })
    expect(statuses()).toEqual(['started', 'first_response', 'completed'])
  })

  it('cancelTrial ends the running trial without saving it and rejects the caller', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { delays: { completion: 'never' } })
    const controller = controllerWith([adapter])

    const pending = controller.startTrial(Subject.DOE_ORACLE, 1)
    pending.catch(() => {})
    await vi.advanceTimersByTimeAsync(5_000)
    const trialId = controller.runningTrialId
    expect(trialId).not.toBeNull()

    await controller.cancelTrial(trialId!)

    expect(controller.isReady()).toBe(true)
    await expect(pending).rejects.toThrow(TrialCancelledError)
    expect(repository.listTrials()).toEqual([])
    expect(adapter.calls).toEqual(['start:1', 'first', 'completion', 'dispose'])
    expect(events.at(-1)).toMatchObject({ trialId, status: 'cancelled', elapsedMs: 5_000 })
  })

  it('cancelTrial refuses an id that is not running', async () => {
    const controller = controllerWith([new FakeAdapter(Subject.DOE_ORACLE)])

    await expect(controller.cancelTrial('nope')).rejects.toThrow(/Trial nope is not running/)
    expect(controller.isReady()).toBe(true)
  })

  it('is ready for the next trial within 5 seconds of a failure even if the adapter will not dispose (NFR-3)', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { delays: { completion: 'never', dispose: 'never' } })
    const controller = controllerWith([adapter], { timeouts: policies({ [Subject.DOE_ORACLE]: { timeoutMs: 1_000 } }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const pending = controller.startTrial(Subject.DOE_ORACLE, 1)
    await vi.advanceTimersByTimeAsync(1_000)
    const failedAt = Date.now()
    expect(controller.isReady()).toBe(false)
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(pending).resolves.toMatchObject({ status: TrialStatus.FAILED })
    expect(controller.isReady()).toBe(true)
    expect(Date.now() - failedAt).toBeLessThanOrEqual(5_000)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not dispose cleanly: gave up after 3 s/))

    // The next trial runs on the same adapter (and times out the same way, with the same dispose cap).
    const next = controller.startTrial(Subject.DOE_ORACLE, 2)
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(next).resolves.toMatchObject({ status: TrialStatus.FAILED, questionNumber: 2 })
    warn.mockRestore()
  })

  it('aborts without saving when the harness itself fails, and reports why', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE, { errors: { start: "Playwright's Chromium is not installed" } })
    const controller = controllerWith([adapter])

    await expect(controller.startTrial(Subject.DOE_ORACLE, 1)).rejects.toThrow(/Chromium is not installed/)

    expect(repository.listTrials()).toEqual([])
    expect(adapter.calls).toEqual(['start:1', 'dispose'])
    expect(events.map((e) => [e.status, e.message])).toEqual([
      ['started', undefined],
      ['aborted', "Playwright's Chromium is not installed"],
    ])
    expect(controller.isReady()).toBe(true)
  })

  it('reports a trial that could not be saved as aborted and stays ready', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE)
    const controller = controllerWith([adapter], {
      repository: {
        saveTrial: () => {
          throw new Error('database is locked')
        },
      },
    })

    await expect(controller.startTrial(Subject.DOE_ORACLE, 1)).rejects.toThrow(/database is locked/)

    expect(events.at(-1)).toMatchObject({ status: 'aborted', message: 'The trial could not be saved: database is locked' })
    expect(controller.isReady()).toBe(true)
  })

  it('rejects a subject without an adapter or an unknown question before sending anything', async () => {
    const adapter = new FakeAdapter(Subject.DOE_ORACLE)
    const controller = controllerWith([adapter])

    await expect(controller.startTrial(Subject.GOOGLE, 1)).rejects.toThrow(/No adapter is registered for Google Search/)
    await expect(controller.startTrial(Subject.DOE_ORACLE, 3)).rejects.toThrow(/Question 3 is not in the question bank/)
    expect(adapter.calls).toEqual([])
    expect(events).toEqual([])
    expect(controller.isReady()).toBe(true)
  })
})

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
