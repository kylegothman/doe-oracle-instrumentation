import { randomUUID } from 'node:crypto'
import type { Question } from '../../shared/questions'
import { SUBJECT_LABELS, type Subject } from '../../shared/subjects'
import { TrialStatus, type Trial } from '../../shared/trials'
import type { SubjectAdapter } from '../adapters/subject-adapter'
import { getQuestion } from '../config/questions'
import type { MetricsRepository, NewTrial } from '../data/metrics-repository'
import type { SessionManager } from './session-manager'
import type { TimingService } from './timing-service'

export interface TrialControllerDeps {
  /** One adapter per subject, held for the whole session. */
  adapters: ReadonlyMap<Subject, SubjectAdapter>
  timing: TimingService
  repository: Pick<MetricsRepository, 'saveTrial'>
  session: Pick<SessionManager, 'getCurrentSession' | 'buildDataSetName'>
  /** Looks up a question by number. Tests inject their own. */
  findQuestion?: (questionNumber: number) => Question
}

/**
 * Runs one trial end to end through a subject's adapter: the three timing
 * marks, capture, and save. One trial at a time.
 * TODO(#27): the per-subject timeout, cancel, and status events arrive next.
 * TODO(#28): the Failure Detector classifies failures and saves failed trials;
 * until then a failed trial throws and nothing is saved.
 */
export class TrialController {
  private running = false

  constructor(private readonly deps: TrialControllerDeps) {}

  get isRunning(): boolean {
    return this.running
  }

  async runTrial(subject: Subject, questionNumber: number): Promise<Trial> {
    if (this.running) {
      throw new Error('A trial is already running. Wait for it to finish, then try again.')
    }
    const adapter = this.deps.adapters.get(subject)
    if (!adapter) {
      throw new Error(`No adapter is registered for ${SUBJECT_LABELS[subject]}`)
    }
    const question = (this.deps.findQuestion ?? getQuestion)(questionNumber)
    const { timing, session, repository } = this.deps

    this.running = true
    const trialId = randomUUID()
    try {
      const beginMs = timing.mark(trialId, 'begin', await adapter.start(question))
      const firstResponseMs = timing.mark(trialId, 'first_response', await adapter.waitForFirstResponse())
      const endMs = timing.mark(trialId, 'end', await adapter.waitForCompletion())
      const answer = await adapter.captureAnswer()

      const trial: NewTrial = {
        trialId,
        sessionId: session.getCurrentSession().sessionId,
        dataSetName: session.buildDataSetName(subject, new Date(beginMs)),
        subject,
        questionNumber: question.number,
        status: TrialStatus.SUCCESS,
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
      await adapter.dispose().catch(() => undefined)
      timing.clear(trialId)
      this.running = false
    }
  }
}
