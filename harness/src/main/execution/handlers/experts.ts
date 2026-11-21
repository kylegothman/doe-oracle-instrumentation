import {
  validateExpertAnswerInput,
  validateExpertInput,
  type ExpertAnswerInput,
  type ExpertInput,
  type SaveExpertAnswerResult,
  type SaveExpertResult,
} from '../../../shared/expert-entry'
import type { Expert, ExpertResponse } from '../../../shared/experts'
import type { ExpertRecordService } from '../expert-record-service'

/**
 * The handlers behind the Expert Responses page (UC-5). The service is
 * supplied through a promise because the database it saves to is opened
 * after startup. Everything that crossed the IPC bridge is checked for its
 * shape here, before the service is touched; the service then applies the
 * rules and answers with a result the page can show beside the field.
 */

/** Builds the handler for `experts:list`: every saved expert, by name. */
export function createListExpertsHandler(service: () => Promise<Pick<ExpertRecordService, 'listExperts'>>): () => Promise<Expert[]> {
  return async () => (await service()).listExperts()
}

/** Builds the handler for `expert:save`: creates an expert, or updates the one with the given id. */
export function createSaveExpertHandler(
  service: () => Promise<Pick<ExpertRecordService, 'saveExpert'>>,
): (input: ExpertInput) => Promise<SaveExpertResult> {
  return async (input) => {
    const problem = validateExpertInput(input)
    if (problem) throw new Error(problem)
    // Only the known fields go on: anything else that crossed the bridge is dropped.
    const { expertId, name, source, outreachTs, firstAnswerTs } = input
    return (await service()).saveExpert({ expertId, name, source, outreachTs, firstAnswerTs })
  }
}

/** Builds the handler for `expert-answers:list`: an expert's current answers, by question number. */
export function createListExpertAnswersHandler(
  service: () => Promise<Pick<ExpertRecordService, 'listAnswers'>>,
): (expertId: string) => Promise<ExpertResponse[]> {
  return async (expertId) => {
    if (typeof expertId !== 'string' || expertId.trim() === '') {
      throw new Error(`Expert id must be a non-empty string, got ${String(expertId)}`)
    }
    return (await service()).listAnswers(expertId)
  }
}

/** Builds the handler for `expert-answer:save`: saves an answer, or replaces one when asked to. */
export function createSaveExpertAnswerHandler(
  service: () => Promise<Pick<ExpertRecordService, 'saveAnswer'>>,
): (input: ExpertAnswerInput) => Promise<SaveExpertAnswerResult> {
  return async (input) => {
    const problem = validateExpertAnswerInput(input)
    if (problem) throw new Error(problem)
    const { expertId, questionNumber, answerText, replace } = input
    return (await service()).saveAnswer({ expertId, questionNumber, answerText, replace })
  }
}
