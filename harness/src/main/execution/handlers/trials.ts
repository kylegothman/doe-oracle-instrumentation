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
  controller: () => Promise<Pick<TrialController, 'startTrial'>>,
): (subject: Subject, questionNumber: number) => Promise<Trial> {
  return async (subject, questionNumber) => {
    if (!isSubject(subject)) {
      throw new Error(`Unknown subject "${String(subject)}"`)
    }
    if (!Number.isInteger(questionNumber) || questionNumber < 1) {
      throw new Error(`Question number must be a positive integer, got ${String(questionNumber)}`)
    }
    return (await controller()).startTrial(subject, questionNumber)
  }
}

/** Builds the handler for `trial:confirm`: the Tester confirmed the detected end, or corrected it. */
export function createConfirmCompletionHandler(
  controller: () => Promise<Pick<TrialController, 'confirmCompletion'>>,
): (trialId: string, endMs?: number) => Promise<void> {
  return async (trialId, endMs) => {
    requireTrialId(trialId)
    if (endMs !== undefined && (typeof endMs !== 'number' || !Number.isFinite(endMs))) {
      throw new Error(`The corrected end must be a number of epoch milliseconds, got ${String(endMs)}`)
    }
    await (await controller()).confirmCompletion(trialId, endMs)
  }
}

/** Builds the handler for `trial:cancel`: ends the running trial without saving it. */
export function createCancelTrialHandler(
  controller: () => Promise<Pick<TrialController, 'cancelTrial'>>,
): (trialId: string) => Promise<void> {
  return async (trialId) => {
    requireTrialId(trialId)
    await (await controller()).cancelTrial(trialId)
  }
}

function requireTrialId(trialId: unknown): void {
  if (typeof trialId !== 'string' || trialId.trim() === '') {
    throw new Error(`Trial id must be a non-empty string, got ${String(trialId)}`)
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
