import { randomUUID } from 'node:crypto'
import { SUBJECT_CODES, type SubjectId } from '../../shared/subjects'

/**
 * One session per launch of the harness: a UUID that every trial saved
 * during this run carries.
 * TODO(#26): E2 completes session management (status, the session bar, and
 * assigning the ID where the Test Console shows it).
 */
export class SessionManager {
  readonly sessionId: string
  readonly startedAtMs: number

  constructor(options: { sessionId?: string; now?: () => number } = {}) {
    this.sessionId = options.sessionId ?? randomUUID()
    this.startedAtMs = (options.now ?? Date.now)()
  }

  /**
   * The data set name the requirements prescribe: the subject code plus the
   * calendar date of the trial on this machine, for example DOE_ORACLE-2026-11-11.
   */
  buildDataSetName(subject: SubjectId, date: Date): string {
    return `${SUBJECT_CODES[subject]}-${localIsoDate(date)}`
  }
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
