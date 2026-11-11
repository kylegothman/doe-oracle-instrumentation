import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright'
import type { TrialRecord } from '../../shared/ipc'
import type { SubjectId } from '../../shared/subjects'
import { OracleAdapter, type CapturedAnswer } from '../adapters/oracle-adapter'
import { getQuestion, type Question } from '../config/questions'
import type { HarnessSettings } from '../config/settings'
import type { MetricsRepository, NewTrial } from '../data/metrics-repository'
import type { SessionManager } from './session-manager'
import type { TimingService } from './timing-service'

/**
 * What the controller needs from an adapter.
 * TODO(#25): E2 turns this into the shared SubjectAdapter interface.
 */
export interface TrialAdapter {
  open(): Promise<void>
  start(question: string): Promise<number>
  waitForFirstResponse(): Promise<number>
  waitForCompletion(): Promise<number>
  captureAnswer(): Promise<CapturedAnswer>
}

export interface TrialControllerDeps {
  settings: HarnessSettings
  browser: { getPage(subject: SubjectId): Promise<Page> }
  timing: TimingService
  repository: Pick<MetricsRepository, 'saveTrial'>
  session: SessionManager
  /** Builds the adapter for a subject's page. Tests inject a scripted one. */
  createAdapter?: (subject: SubjectId, page: Page, settings: HarnessSettings) => TrialAdapter
  /** Looks up a question by number. Tests inject their own. */
  findQuestion?: (questionNumber: number) => Question
}

/**
 * Runs one trial end to end: page, adapter, the three timing marks, capture,
 * and save. One trial at a time.
 * TODO(#27): the 60-second timeout around the waits arrives in E2.
 * TODO(#28): the Failure Detector classifies failures and saves failed trials in E2;
 * until then a failed trial throws and nothing is saved.
 */
export class TrialController {
  private running = false

  constructor(private readonly deps: TrialControllerDeps) {}

  get isRunning(): boolean {
    return this.running
  }

  async runTrial(subject: SubjectId, questionNumber: number): Promise<TrialRecord> {
    if (this.running) {
      throw new Error('A trial is already running. Wait for it to finish, then try again.')
    }
    const question = (this.deps.findQuestion ?? getQuestion)(questionNumber)
    const createAdapter = this.deps.createAdapter ?? createDefaultAdapter
    const { timing, session, repository } = this.deps

    this.running = true
    const trialId = randomUUID()
    try {
      const page = await this.deps.browser.getPage(subject)
      const adapter = createAdapter(subject, page, this.deps.settings)
      await adapter.open()

      const beginMs = timing.mark(trialId, 'begin', await adapter.start(question.text))
      const firstResponseMs = timing.mark(trialId, 'first_response', await adapter.waitForFirstResponse())
      const endMs = timing.mark(trialId, 'end', await adapter.waitForCompletion())
      const answer = await adapter.captureAnswer()

      const trial: NewTrial = {
        trialId,
        sessionId: session.sessionId,
        dataSetName: session.buildDataSetName(subject, new Date(beginMs)),
        subject,
        questionNumber: question.number,
        status: 'completed',
        beginTs: timing.toIso(beginMs),
        firstResponseTs: timing.toIso(firstResponseMs),
        endTs: timing.toIso(endMs),
        responseMs: timing.durationMs(beginMs, endMs),
        firstResponseMs: timing.durationMs(beginMs, firstResponseMs),
        answerText: answer.text,
        citations: answer.citations,
      }
      return repository.saveTrial(trial)
    } finally {
      timing.clear(trialId)
      this.running = false
    }
  }
}

function createDefaultAdapter(subject: SubjectId, page: Page, settings: HarnessSettings): TrialAdapter {
  if (subject === 'oracle') {
    return new OracleAdapter(page, settings.oracle)
  }
  // TODO(#5, #6): the Copilot and Google adapters.
  throw new Error(`No adapter exists for subject "${String(subject)}"`)
}
