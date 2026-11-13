import type BetterSqlite3 from 'better-sqlite3'
import type { Session } from '../../shared/session'
import type { Subject } from '../../shared/subjects'
import type { FailureType } from '../../shared/failures'
import { TrialStatus, type Trial, type TrialFailure } from '../../shared/trials'
import type { Expert, ExpertResponse, ResponseSource } from '../../shared/experts'

/** Fields only some subjects or later epics fill in. Left out, they are saved as null. */
type OptionalTrialFields = 'pageLoadMs' | 'timeToAnswerMs' | 'sourceUrl' | 'keywords'

/**
 * A trial to save. The repository assigns the test number and computes the
 * size from the answer; the failure is passed separately.
 */
export type NewTrial = Omit<Trial, 'testNumber' | 'failure' | 'sizeBytes' | OptionalTrialFields> &
  Partial<Pick<Trial, OptionalTrialFields>>

/**
 * An expert answer to save. The repository assigns the response id and test
 * number and computes the size; a new answer is always active.
 */
export type NewExpertResponse = Omit<ExpertResponse, 'responseId' | 'testNumber' | 'sizeBytes' | 'supersededBy' | 'keywords'> &
  Partial<Pick<ExpertResponse, 'keywords'>>

/** What saveExpertResponse stored, and the answer it replaced, if any. */
export interface ExpertResponseSaved {
  saved: ExpertResponse
  /** The previously active answer, now pointing at saved; null when there was none. */
  superseded: ExpertResponse | null
}

/**
 * Thrown by saveExpertResponse when the question already has an active
 * answer and replace was not requested. The Expert Responses page shows the
 * existing answer and asks the Researcher to confirm before saving again
 * with replace: true (UC-5, SD-5).
 */
export class ActiveAnswerExistsError extends Error {
  constructor(readonly existing: ExpertResponse) {
    super(
      `Expert ${existing.expertId} already has an answer to question ${existing.questionNumber} ` +
        `(response ${existing.responseId}); save with replace: true to supersede it`,
    )
    this.name = 'ActiveAnswerExistsError'
  }
}

export interface TrialListFilter {
  sessionId?: string
  subject?: Subject
  /** Newest trials first; defaults to 50. */
  limit?: number
}

interface Migration {
  version: number
  name: string
  up(db: BetterSqlite3.Database): void
}

/**
 * Schema versions, applied in order inside one transaction each. Add a new
 * entry to change the schema; never edit an applied one.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'create trials',
    up(db) {
      db.exec(`
        CREATE TABLE trials (
          trial_id TEXT PRIMARY KEY,
          test_number INTEGER UNIQUE,
          session_id TEXT,
          data_set_name TEXT,
          subject TEXT,
          question_number INTEGER,
          status TEXT,
          begin_ts TEXT,
          first_response_ts TEXT,
          end_ts TEXT,
          response_ms INTEGER,
          first_response_ms INTEGER,
          answer_text TEXT,
          citations TEXT
        );
        CREATE INDEX trials_session_id ON trials (session_id);
      `)
    },
  },
  {
    // E1 stored the Oracle as "oracle" and a finished trial as "completed".
    // E2's shared enums use the subject codes and the design's status names.
    version: 2,
    name: 'subject and status codes',
    up(db) {
      db.exec(`
        UPDATE trials SET subject = 'DOE_ORACLE' WHERE subject = 'oracle';
        UPDATE trials SET status = 'SUCCESS' WHERE status = 'completed';
      `)
    },
  },
  {
    version: 3,
    name: 'create sessions',
    up(db) {
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          started_at TEXT,
          app_version TEXT
        );
      `)
    },
  },

  {
    version: 4,
    name: 'create failed_requests',
    up(db) {
      db.exec(`
        CREATE TABLE failed_requests (
          trial_id TEXT PRIMARY KEY REFERENCES trials (trial_id),
          failure_type TEXT,
          error_message TEXT,
          elapsed_ms INTEGER
        );
      `)
    },
  },
  {
    // The rest of the Trial fields in Detailed Design Figure 10. Existing
    // trials keep null for the Google-only fields and keywords; their size is
    // computed from the answer they already have (a BLOB's length is its
    // byte count, so this is the UTF-8 size, not the character count).
    version: 5,
    name: 'trial export fields',
    up(db) {
      db.exec(`
        ALTER TABLE trials ADD COLUMN page_load_ms INTEGER;
        ALTER TABLE trials ADD COLUMN time_to_answer_ms INTEGER;
        ALTER TABLE trials ADD COLUMN source_url TEXT;
        ALTER TABLE trials ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE trials ADD COLUMN keywords TEXT;
        UPDATE trials SET size_bytes = COALESCE(LENGTH(CAST(answer_text AS BLOB)), 0);
      `)
    },
  },
  {
    // Detailed Design Table 3. The expert's turnaround is stored once, on the
    // expert. Answers are never overwritten: a replacement is a new row, and
    // the old row's superseded_by points at it. The partial unique index
    // allows only one active (superseded_by IS NULL) answer per expert and
    // question. superseded_by is checked at commit (DEFERRABLE), so a
    // replacement can mark the old row with the new row's id and then insert
    // the new row in the same transaction without breaking that index.
    // The replacement takes over the old row's test_number, so a revised
    // answer keeps its Test # and the export has no gaps; the old row's
    // test_number becomes null (UNIQUE allows any number of nulls).
    version: 6,
    name: 'create experts and expert_responses',
    up(db) {
      db.exec(`
        CREATE TABLE experts (
          expert_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('EMAIL', 'INTERVIEW')),
          outreach_ts TEXT,
          first_answer_ts TEXT,
          turnaround_ms INTEGER
        );
        CREATE TABLE expert_responses (
          response_id INTEGER PRIMARY KEY,
          test_number INTEGER UNIQUE,
          expert_id TEXT NOT NULL REFERENCES experts (expert_id),
          session_id TEXT NOT NULL,
          question_number INTEGER NOT NULL,
          answer_text TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          keywords TEXT,
          recorded_at TEXT NOT NULL,
          superseded_by INTEGER REFERENCES expert_responses (response_id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE INDEX expert_responses_expert_id ON expert_responses (expert_id);
        CREATE UNIQUE INDEX expert_responses_one_active
          ON expert_responses (expert_id, question_number) WHERE superseded_by IS NULL;
      `)
    },
  },
]

interface ExpertRow {
  expert_id: string
  name: string
  source: string
  outreach_ts: string | null
  first_answer_ts: string | null
  turnaround_ms: number | null
}

interface ExpertResponseRow {
  response_id: number
  test_number: number | null
  expert_id: string
  session_id: string
  question_number: number
  answer_text: string
  size_bytes: number
  keywords: string | null
  recorded_at: string
  superseded_by: number | null
}

interface SessionRow {
  session_id: string
  started_at: string
  app_version: string
}

interface TrialRow {
  trial_id: string
  test_number: number
  session_id: string
  data_set_name: string
  subject: string
  question_number: number
  status: string
  begin_ts: string | null
  first_response_ts: string | null
  end_ts: string | null
  response_ms: number | null
  first_response_ms: number | null
  answer_text: string | null
  citations: string | null
  page_load_ms: number | null
  time_to_answer_ms: number | null
  source_url: string | null
  size_bytes: number
  keywords: string | null
  /** From the LEFT JOIN on failed_requests; null for a trial that did not fail. */
  failure_type: string | null
  error_message: string | null
  elapsed_ms: number | null
}

/**
 * Stores trials in SQLite through better-sqlite3. One instance per database
 * file; the main process opens harness.db under app.getPath('userData').
 * Every write is committed before saveTrial returns, so a trial survives
 * the app closing right after it ends.
 */
export class MetricsRepository {
  private constructor(
    private readonly db: BetterSqlite3.Database,
    readonly filePath: string,
  ) {}

  /** Opens (creating if needed) the database at filePath, or ':memory:', and applies pending migrations. */
  static async open(filePath: string): Promise<MetricsRepository> {
    // Loaded lazily so a broken native module surfaces as an error from
    // this call, not a crash at import time.
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(filePath)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    // Off by default in SQLite; failed_requests.trial_id must point at a trial.
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `)
    const repository = new MetricsRepository(db, filePath)
    repository.migrate()
    return repository
  }

  /** The highest migration version applied, 0 for an empty database. */
  get schemaVersion(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as {
      version: number
    }
    return row.version
  }

  /** Applies every migration above the current version. Returns the versions applied. */
  migrate(): number[] {
    const applied: number[] = []
    const record = this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    for (const migration of MIGRATIONS) {
      if (migration.version <= this.schemaVersion) continue
      this.db.transaction(() => {
        migration.up(this.db)
        record.run(migration.version, migration.name, new Date().toISOString())
      })()
      applied.push(migration.version)
    }
    return applied
  }

  /**
   * The Test # the next saved row gets. Trials and expert answers share one
   * sequence, so every row in the TestLogV3 export has a unique Test #: this
   * is one more than the highest number in either table, 1 for an empty
   * database. Call it inside the transaction that saves the row, so nothing
   * can take the number in between.
   */
  nextTestNumber(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(n), 0) + 1 AS next FROM (
           SELECT MAX(test_number) AS n FROM trials
           UNION ALL
           SELECT MAX(test_number) AS n FROM expert_responses
         )`,
      )
      .get() as { next: number }
    return row.next
  }

  /**
   * Saves a trial with the next test number and returns the stored record.
   * A FAILED trial is saved together with its failure (a failed_requests
   * row) in one transaction; any other status takes no failure.
   */
  saveTrial(trial: NewTrial, failure?: TrialFailure): Trial {
    if ((trial.status === TrialStatus.FAILED) !== (failure !== undefined)) {
      throw new Error(
        failure
          ? `A failure was given for trial ${trial.trialId} but its status is ${trial.status}, not FAILED`
          : `Trial ${trial.trialId} is FAILED but no failure was given`,
      )
    }
    const insert = this.db.prepare(`
      INSERT INTO trials (
        trial_id, test_number, session_id, data_set_name, subject, question_number, status,
        begin_ts, first_response_ts, end_ts, response_ms, first_response_ms, answer_text, citations,
        page_load_ms, time_to_answer_ms, source_url, size_bytes, keywords
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFailure = this.db.prepare(`
      INSERT INTO failed_requests (trial_id, failure_type, error_message, elapsed_ms) VALUES (?, ?, ?, ?)
    `)
    const save = this.db.transaction((input: NewTrial, failed?: TrialFailure): Trial => {
      const next = this.nextTestNumber()
      const stored: Omit<Trial, 'testNumber' | 'failure'> = {
        ...input,
        citations: [...input.citations],
        pageLoadMs: input.pageLoadMs ?? null,
        timeToAnswerMs: input.timeToAnswerMs ?? null,
        sourceUrl: input.sourceUrl ?? null,
        sizeBytes: utf8ByteLength(input.answerText),
        keywords: input.keywords ?? null,
      }
      insert.run(
        input.trialId,
        next,
        input.sessionId,
        input.dataSetName,
        input.subject,
        input.questionNumber,
        input.status,
        input.beginTs,
        input.firstResponseTs,
        input.endTs,
        input.responseMs,
        input.firstResponseMs,
        input.answerText,
        JSON.stringify(input.citations),
        stored.pageLoadMs,
        stored.timeToAnswerMs,
        stored.sourceUrl,
        stored.sizeBytes,
        stored.keywords,
      )
      if (failed) {
        insertFailure.run(input.trialId, failed.type, failed.message, failed.elapsedMs)
      }
      const saved: Trial = { ...stored, testNumber: next }
      return failed ? { ...saved, failure: { ...failed } } : saved
    })
    return save(trial, failure)
  }

  /** Lists saved trials, newest first. */
  listTrials(filter: TrialListFilter = {}): Trial[] {
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (filter.sessionId !== undefined) {
      conditions.push('t.session_id = ?')
      params.push(filter.sessionId)
    }
    if (filter.subject !== undefined) {
      conditions.push('t.subject = ?')
      params.push(filter.subject)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT t.*, f.failure_type, f.error_message, f.elapsed_ms
         FROM trials t LEFT JOIN failed_requests f ON f.trial_id = t.trial_id
         ${where} ORDER BY t.test_number DESC LIMIT ?`,
      )
      .all(...params, filter.limit ?? 50) as TrialRow[]
    return rows.map(toTrial)
  }

  /** Records this launch's session. Throws if the id was saved before. */
  saveSession(session: Session): void {
    this.db
      .prepare('INSERT INTO sessions (session_id, started_at, app_version) VALUES (?, ?, ?)')
      .run(session.sessionId, session.startedAt, session.appVersion)
  }

  /** The session with this id, or null when none was saved. */
  getSession(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined
    return row ? { sessionId: row.session_id, startedAt: row.started_at, appVersion: row.app_version } : null
  }

  /**
   * Saves an expert, or updates the one with the same id: the Researcher
   * can enter the name and source first and the timestamps once the reply
   * arrives. Returns the expert id.
   */
  saveExpert(expert: Expert): string {
    this.db
      .prepare(
        `INSERT INTO experts (expert_id, name, source, outreach_ts, first_answer_ts, turnaround_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (expert_id) DO UPDATE SET
           name = excluded.name,
           source = excluded.source,
           outreach_ts = excluded.outreach_ts,
           first_answer_ts = excluded.first_answer_ts,
           turnaround_ms = excluded.turnaround_ms`,
      )
      .run(expert.expertId, expert.name, expert.source, expert.outreachTs, expert.firstAnswerTs, expert.turnaroundMs)
    return expert.expertId
  }

  /** The expert with this id, or null when none was saved. */
  getExpert(expertId: string): Expert | null {
    const row = this.db.prepare('SELECT * FROM experts WHERE expert_id = ?').get(expertId) as ExpertRow | undefined
    return row ? toExpert(row) : null
  }

  /** Every saved expert, by name. */
  listExperts(): Expert[] {
    const rows = this.db.prepare('SELECT * FROM experts ORDER BY name, expert_id').all() as ExpertRow[]
    return rows.map(toExpert)
  }

  /**
   * Saves an expert's answer with the next test number. If the question
   * already has an active answer, this throws ActiveAnswerExistsError unless
   * replace is true; with replace, the new answer is saved with the old
   * one's test number, and the old one is kept with its supersededBy
   * pointing at the new one and no test number, in one transaction.
   */
  saveExpertResponse(response: NewExpertResponse, options: { replace?: boolean } = {}): ExpertResponseSaved {
    const save = this.db.transaction((input: NewExpertResponse): ExpertResponseSaved => {
      const existing = this.getActiveResponse(input.expertId, input.questionNumber)
      if (existing && !options.replace) throw new ActiveAnswerExistsError(existing)

      const { nextId } = this.db
        .prepare('SELECT COALESCE(MAX(response_id), 0) + 1 AS nextId FROM expert_responses')
        .get() as { nextId: number }
      const saved: ExpertResponse = {
        ...input,
        responseId: nextId,
        // A revised answer keeps the Test # of the one it replaces.
        testNumber: existing?.testNumber ?? this.nextTestNumber(),
        sizeBytes: utf8ByteLength(input.answerText),
        keywords: input.keywords ?? null,
        supersededBy: null,
      }
      // Update the old answer first: the one-active-answer index and the
      // unique test number would both refuse the insert otherwise.
      // superseded_by is checked when this commits.
      if (existing) {
        this.db
          .prepare('UPDATE expert_responses SET superseded_by = ?, test_number = NULL WHERE response_id = ?')
          .run(nextId, existing.responseId)
      }
      this.db
        .prepare(
          `INSERT INTO expert_responses (
             response_id, test_number, expert_id, session_id, question_number,
             answer_text, size_bytes, keywords, recorded_at, superseded_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          saved.responseId,
          saved.testNumber,
          saved.expertId,
          saved.sessionId,
          saved.questionNumber,
          saved.answerText,
          saved.sizeBytes,
          saved.keywords,
          saved.recordedAt,
        )
      return { saved, superseded: existing ? { ...existing, supersededBy: nextId, testNumber: null } : null }
    })
    return save(response)
  }

  /** The expert's current answer to a question, or null when it has none. */
  getActiveResponse(expertId: string, questionNumber: number): ExpertResponse | null {
    const row = this.db
      .prepare('SELECT * FROM expert_responses WHERE expert_id = ? AND question_number = ? AND superseded_by IS NULL')
      .get(expertId, questionNumber) as ExpertResponseRow | undefined
    return row ? toExpertResponse(row) : null
  }

  /**
   * The expert's answers by question number. Only active answers unless
   * includeSuperseded is set; then each question's answers follow in the
   * order they were saved.
   */
  listExpertResponses(expertId: string, options: { includeSuperseded?: boolean } = {}): ExpertResponse[] {
    const active = options.includeSuperseded ? '' : 'AND superseded_by IS NULL'
    const rows = this.db
      .prepare(`SELECT * FROM expert_responses WHERE expert_id = ? ${active} ORDER BY question_number, response_id`)
      .all(expertId) as ExpertResponseRow[]
    return rows.map(toExpertResponse)
  }

  close(): void {
    this.db.close()
  }
}

function toExpert(row: ExpertRow): Expert {
  return {
    expertId: row.expert_id,
    name: row.name,
    source: row.source as ResponseSource,
    outreachTs: row.outreach_ts,
    firstAnswerTs: row.first_answer_ts,
    turnaroundMs: row.turnaround_ms,
  }
}

function toExpertResponse(row: ExpertResponseRow): ExpertResponse {
  return {
    responseId: row.response_id,
    testNumber: row.test_number,
    expertId: row.expert_id,
    sessionId: row.session_id,
    questionNumber: row.question_number,
    answerText: row.answer_text,
    sizeBytes: row.size_bytes,
    keywords: row.keywords,
    recordedAt: row.recorded_at,
    supersededBy: row.superseded_by,
  }
}

function toTrial(row: TrialRow): Trial {
  const trial: Trial = {
    trialId: row.trial_id,
    testNumber: row.test_number,
    sessionId: row.session_id,
    dataSetName: row.data_set_name,
    subject: row.subject as Subject,
    questionNumber: row.question_number,
    status: row.status as TrialStatus,
    beginTs: row.begin_ts,
    firstResponseTs: row.first_response_ts,
    endTs: row.end_ts,
    responseMs: row.response_ms,
    firstResponseMs: row.first_response_ms,
    answerText: row.answer_text,
    citations: parseCitations(row.citations),
    pageLoadMs: row.page_load_ms,
    timeToAnswerMs: row.time_to_answer_ms,
    sourceUrl: row.source_url,
    sizeBytes: row.size_bytes,
    keywords: row.keywords,
  }
  if (row.failure_type !== null) {
    trial.failure = {
      type: row.failure_type as FailureType,
      message: row.error_message ?? '',
      elapsedMs: row.elapsed_ms ?? 0,
    }
  }
  return trial
}

/** Size Kbytes in the export is derived from this, so it counts bytes, not characters. */
function utf8ByteLength(text: string | null): number {
  return text === null ? 0 : Buffer.byteLength(text, 'utf8')
}

function parseCitations(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
