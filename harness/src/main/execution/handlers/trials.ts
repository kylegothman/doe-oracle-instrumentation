import { isSubject, type Subject } from '../../../shared/subjects'
import type { Trial } from '../../../shared/trials'
import type { MetricsRepository } from '../../data/metrics-repository'
import type { TrialController } from '../trial-controller'

/** Trials shown in the UI list. */
const LIST_LIMIT = 20

/**
 * Builds the handler for `trial:start`. The controller is supplied through a
 * promise because the database it saves to is opened after startup.
 */
export function createStartTrialHandler(
  controller: () => Promise<Pick<TrialController, 'runTrial'>>,
): (subject: Subject, questionNumber: number) => Promise<Trial> {
  return async (subject, questionNumber) => {
    if (!isSubject(subject)) {
      throw new Error(`Unknown subject "${String(subject)}"`)
    }
    if (!Number.isInteger(questionNumber) || questionNumber < 1) {
      throw new Error(`Question number must be a positive integer, got ${String(questionNumber)}`)
    }
    return (await controller()).runTrial(subject, questionNumber)
  }
}

/** Builds the handler for `trials:list`: the newest trials, for one session or for all. */
export function createListTrialsHandler(
  repository: () => Promise<Pick<MetricsRepository, 'listTrials'>>,
): (sessionId?: string) => Promise<Trial[]> {
  return async (sessionId) => {
    const filter = sessionId ? { sessionId, limit: LIST_LIMIT } : { limit: LIST_LIMIT }
    return (await repository()).listTrials(filter)
  }
}
