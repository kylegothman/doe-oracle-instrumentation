import { randomUUID } from 'node:crypto'
import type { Session } from '../../shared/session'
import type { Subject } from '../../shared/subjects'

/** Where sessions are kept: the MetricsRepository. */
export interface SessionStore {
  saveSession(session: Session): void
}

export interface SessionManagerOptions {
  store: SessionStore
  /** Harness version recorded with the session. */
  appVersion: string
  /** Clock for startedAt; defaults to Date.now. */
  now?: () => number
  /** Generates the session id; defaults to a random UUID. Tests fix it. */
  sessionId?: () => string
}

/**
 * One session per launch of the harness (Detailed Design 3.2, story #26).
 * startSession() runs once, when the database is open, and every trial
 * saved afterwards carries the session's ID. The session records only an
 * ID, a start time, and the harness version: nothing about the Tester
 * (NFR-7), which is why the ID is generated rather than typed.
 */
export class SessionManager {
  private current: Session | null = null

  constructor(private readonly options: SessionManagerOptions) {}

  /** Creates this launch's session, saves it, and returns it. Throws if one was already started. */
  startSession(): Session {
    if (this.current) {
      throw new Error(`A session (${this.current.sessionId}) has already been started for this launch`)
    }
    const session: Session = {
      sessionId: (this.options.sessionId ?? randomUUID)(),
      startedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
      appVersion: this.options.appVersion,
    }
    this.options.store.saveSession(session)
    this.current = session
    return session
  }

  /** The session started for this launch. Throws before startSession() has run. */
  getCurrentSession(): Session {
    if (!this.current) {
      throw new Error('No session has been started yet')
    }
    return this.current
  }

  /**
   * The data set name the requirements prescribe: the subject code plus the
   * calendar date of the trial on this machine, for example DOE_ORACLE-2026-11-12.
   */
  buildDataSetName(subject: Subject, date: Date): string {
    return `${subject}-${localIsoDate(date)}`
  }
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
