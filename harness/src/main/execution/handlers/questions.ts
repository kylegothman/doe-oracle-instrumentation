import type { TrialLimit } from '../../../shared/ipc'
import type { Question } from '../../../shared/questions'
import { SUBJECTS, type Subject } from '../../../shared/subjects'
import type { TrialPolicy } from '../../config/settings'
import type { QuestionBank } from '../question-bank'

/**
 * Builds the handler for `questions:list`: the standard questions, in
 * order, for the Test Console's question dropdown. The bank is supplied
 * through a promise because it is read at startup; a file that could not
 * be loaded rejects with its problem, which the console shows.
 */
export function createListQuestionsHandler(questions: () => Promise<Pick<QuestionBank, 'list'>>): () => Promise<Question[]> {
  return async () => (await questions()).list()
}

/**
 * Builds the handler for `trials:limits`: each subject's time limit, when
 * its clock starts, and whether the Tester confirms the end, so the Test
 * Console can draw its timer against the limit the controller enforces.
 */
export function createGetTrialLimitsHandler(policies: Readonly<Record<Subject, TrialPolicy>>): () => Promise<Record<Subject, TrialLimit>> {
  return async () =>
    Object.fromEntries(
      SUBJECTS.map((subject) => {
        const { timeoutMs, startsAt, confirmEnd } = policies[subject]
        return [subject, { timeoutMs, startsAt, confirmEnd }]
      }),
    ) as Record<Subject, TrialLimit>
}
