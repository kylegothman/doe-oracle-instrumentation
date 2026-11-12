import type BetterSqlite3 from 'better-sqlite3'
import type { Subject } from '../../shared/subjects'
import type { Trial, TrialStatus } from '../../shared/trials'

/** A trial to save. The repository assigns the test number. */
export type NewTrial = Omit<Trial, 'testNumber'>

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
 * TODO(#29): E3 extends the trials table and adds the export tables here.
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
]

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

  /** Saves a trial with the next test number and returns the stored record. */
  saveTrial(trial: NewTrial): Trial {
    const insert = this.db.prepare(`
      INSERT INTO trials (
        trial_id, test_number, session_id, data_set_name, subject, question_number, status,
        begin_ts, first_response_ts, end_ts, response_ms, first_response_ms, answer_text, citations
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const nextNumber = this.db.prepare('SELECT COALESCE(MAX(test_number), 0) + 1 AS next FROM trials')
    const save = this.db.transaction((input: NewTrial): Trial => {
      const { next } = nextNumber.get() as { next: number }
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
      )
      return { ...input, testNumber: next, citations: [...input.citations] }
    })
    return save(trial)
  }

  /** Lists saved trials, newest first. */
  listTrials(filter: TrialListFilter = {}): Trial[] {
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (filter.sessionId !== undefined) {
      conditions.push('session_id = ?')
      params.push(filter.sessionId)
    }
    if (filter.subject !== undefined) {
      conditions.push('subject = ?')
      params.push(filter.subject)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM trials ${where} ORDER BY test_number DESC LIMIT ?`)
      .all(...params, filter.limit ?? 50) as TrialRow[]
    return rows.map(toTrial)
  }

  close(): void {
    this.db.close()
  }
}

function toTrial(row: TrialRow): Trial {
  return {
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
  }
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
