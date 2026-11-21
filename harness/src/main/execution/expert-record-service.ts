import { randomUUID } from 'node:crypto'
import { parseUtcTimestamp, turnaroundMs, type ExpertField, type ExpertInput, type SaveExpertResult } from '../../shared/expert-entry'
import { isResponseSource, type Expert } from '../../shared/experts'
import type { MetricsRepository } from '../data/metrics-repository'

export interface ExpertRecordServiceOptions {
  /** Where experts are kept. Its saves go through the failed-writes log, as a trial's do. */
  repository: Pick<MetricsRepository, 'saveExpert' | 'listExperts'>
  /** Generates a new expert's id; defaults to a random UUID. Tests fix it. */
  expertId?: () => string
}

/**
 * Records the human expert's baseline (UC-5, stories #41 to #43): the expert
 * with the turnaround, stored once per expert. It applies every rule to
 * what the Researcher entered and saves through MetricsRepository, so a
 * save that fails in the database is kept in the failed-writes log and can
 * be retried.
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
}

function invalid(field: ExpertField, message: string): { status: 'INVALID'; field: ExpertField; message: string } {
  return { status: 'INVALID', field, message }
}

/** True when two names are the same person's: case and spacing do not count. */
function sameName(a: string, b: string): boolean {
  const fold = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase()
  return fold(a) === fold(b)
}
