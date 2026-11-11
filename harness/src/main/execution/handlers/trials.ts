import type { TrialRecord } from '../../../shared/ipc'
import { SUBJECT_IDS, type SubjectId } from '../../../shared/subjects'
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
): (subject: SubjectId, questionNumber: number) => Promise<TrialRecord> {
  return async (subject, questionNumber) => {
    if (!SUBJECT_IDS.includes(subject)) {
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
): (sessionId?: string) => Promise<TrialRecord[]> {
  return async (sessionId) => {
    const filter = sessionId ? { sessionId, limit: LIST_LIMIT } : { limit: LIST_LIMIT }
    return (await repository()).listTrials(filter)
  }
}
