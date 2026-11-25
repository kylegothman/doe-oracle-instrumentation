import { randomUUID } from 'node:crypto'
import {
  parseUtcTimestamp,
  trimBlankLines,
  turnaroundMs,
  type ExpertAnswerInput,
  type ExpertInput,
  type SaveExpertAnswerResult,
  type SaveExpertResult,
} from '../../shared/expert-entry'
import { isResponseSource, type Expert, type ExpertResponse } from '../../shared/experts'
import { ActiveAnswerExistsError, type MetricsRepository } from '../data/metrics-repository'
import type { QuestionBank } from './question-bank'
import type { SessionManager } from './session-manager'

export interface ExpertRecordServiceOptions {
  /** Where experts and their answers are kept. Its saves go through the failed-writes log, as a trial's do. */
  repository: Pick<MetricsRepository, 'saveExpert' | 'getExpert' | 'listExperts' | 'saveExpertResponse' | 'listExpertResponses'>
  /** This launch's session: every answer records the session it was entered in. */
  session: Pick<SessionManager, 'getCurrentSession'>
  /** The standard questions: an answer must be to one of them. */
  questions: Pick<QuestionBank, 'size'>
  /** Clock for an answer's recordedAt; defaults to Date.now. */
  now?: () => number
  /** Generates a new expert's id; defaults to a random UUID. Tests fix it. */
  expertId?: () => string
}

/**
 * Records the human expert's baseline (UC-5, stories #41 to #43): the expert
 * with the turnaround, stored once per expert and never per answer, and the
 * expert's answer to each standard question. It applies every rule to what
 * the Researcher entered and saves through MetricsRepository, so a save
 * that fails in the database is kept in the failed-writes log and can be
 * retried.
 *
 * An entry that breaks a rule saves nothing and answers INVALID with the
 * field that is wrong. Only a failure the Researcher cannot fix in the form
 * (an expert that is not saved, the database refusing the write) throws.
 */
export class ExpertRecordService {
  constructor(private readonly options: ExpertRecordServiceOptions) {}

  /** Every saved expert, by name. */
  listExperts(): Expert[] {
    return this.options.repository.listExperts()
  }

  /**
   * Saves a new expert, or updates the one with input.expertId. The
   * turnaround is the first answer minus the outreach, in milliseconds,
   * and is null until the first answer is entered.
   */
  saveExpert(input: ExpertInput): SaveExpertResult {
    const name = input.name.trim()
    if (name === '') return invalid('name', 'Name is required.')
    if (!isResponseSource(input.source)) return invalid('source', 'Source must be Email or Interview.')

    if (input.outreachTs === null) return invalid('outreachTs', 'Outreach time is required.')
    const outreachMs = parseUtcTimestamp(input.outreachTs)
    if (outreachMs === null) return invalid('outreachTs', 'Outreach time is not a valid date and time.')
    if (input.firstAnswerTs !== null) {
      const firstAnswerMs = parseUtcTimestamp(input.firstAnswerTs)
      if (firstAnswerMs === null) return invalid('firstAnswerTs', 'First answer time is not a valid date and time.')
      // Equal times are a turnaround of zero, which is accepted.
      if (firstAnswerMs < outreachMs) return invalid('firstAnswerTs', 'First answer time is earlier than the outreach time.')
    }

    const saved = this.options.repository.listExperts()
    if (input.expertId !== null && !saved.some((expert) => expert.expertId === input.expertId)) {
      throw new Error(`Expert ${input.expertId} is not saved, so it cannot be updated`)
    }
    // One record per person: a second expert with the same name is refused.
    const twin = saved.find((expert) => expert.expertId !== input.expertId && sameName(expert.name, name))
    if (twin) {
      return invalid('name', `Name: an expert named ${twin.name} is already saved. Pick them from the Expert list to update them.`)
    }

    const expert: Expert = {
      expertId: input.expertId ?? (this.options.expertId ?? randomUUID)(),
      name,
      source: input.source,
      outreachTs: input.outreachTs,
      firstAnswerTs: input.firstAnswerTs,
      turnaroundMs: turnaroundMs(input.outreachTs, input.firstAnswerTs),
    }
    this.options.repository.saveExpert(expert)
    return { status: 'SAVED', expert }
  }

  /** The expert's current answers, by question number. Replaced answers are left out. */
  listAnswers(expertId: string): ExpertResponse[] {
    return this.options.repository.listExpertResponses(expertId)
  }

  /**
   * Saves the expert's answer to one question, in the current session. The
   * text is stored as pasted apart from blank lines at its very start and
   * end; keywords stay empty.
   *
   * A question that already has an answer is only replaced when
   * input.replace is true: the new answer becomes the active one and the
   * old one is kept as superseded, never overwritten. Without it nothing
   * is saved and the existing answer comes back, for the page to show
   * before it asks (story #43).
   */
  saveAnswer(input: ExpertAnswerInput): SaveExpertAnswerResult {
    if (!this.options.repository.getExpert(input.expertId)) {
      throw new Error(`Expert ${input.expertId} is not saved, so it cannot be given an answer`)
    }
    const questionCount = this.options.questions.size
    if (!Number.isInteger(input.questionNumber) || input.questionNumber < 1 || input.questionNumber > questionCount) {
      return invalid('questionNumber', `Question must be a whole number from 1 to ${questionCount}.`)
    }
    const answerText = trimBlankLines(input.answerText)
    if (answerText.trim() === '') return invalid('answerText', 'Answer is empty. Paste or type the expert\'s answer.')

    try {
      const { saved, superseded } = this.options.repository.saveExpertResponse(
        {
          expertId: input.expertId,
          sessionId: this.options.session.getCurrentSession().sessionId,
          questionNumber: input.questionNumber,
          answerText,
          recordedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
        },
        { replace: input.replace },
      )
      return { status: 'SAVED', saved, superseded }
    } catch (error) {
      if (error instanceof ActiveAnswerExistsError) return { status: 'ANSWER_EXISTS', existing: error.existing }
      throw error
    }
  }
}

function invalid<F extends string>(field: F, message: string): { status: 'INVALID'; field: F; message: string } {
  return { status: 'INVALID', field, message }
}

/** True when two names are the same person's: case and spacing do not count. */
function sameName(a: string, b: string): boolean {
  const fold = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase()
  return fold(a) === fold(b)
}
