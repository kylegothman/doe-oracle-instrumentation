import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FailureType } from '../../shared/failures'
import { Subject } from '../../shared/subjects'
import { TrialStatus, type Trial } from '../../shared/trials'
import { MetricsRepository, type NewTrial } from './metrics-repository'

const CURRENT_SCHEMA_VERSION = 5

/** What saveTrial returns for a NewTrial that leaves the optional fields out. */
function asSaved(trial: NewTrial, testNumber: number): Trial {
  return {
    pageLoadMs: null,
    timeToAnswerMs: null,
    sourceUrl: null,
    keywords: null,
    ...trial,
    testNumber,
    sizeBytes: trial.answerText === null ? 0 : Buffer.byteLength(trial.answerText, 'utf8'),
  }
}

function sampleTrial(overrides: Partial<NewTrial> = {}): NewTrial {
  return {
    trialId: 'trial-1',
    sessionId: 'session-a',
    dataSetName: 'DOE_ORACLE-2026-11-11',
    subject: Subject.DOE_ORACLE,
    questionNumber: 1,
    status: TrialStatus.SUCCESS,
    beginTs: '2026-11-11T02:53:28.530Z',
    firstResponseTs: '2026-11-11T02:53:28.830Z',
    endTs: '2026-11-11T02:53:29.430Z',
    responseMs: 900,
    firstResponseMs: 300,
    answerText: 'Combinatorial testing covers t-way interactions.',
    citations: ['paper-a.pdf · p.3', 'paper-b.pdf · p.12'],
    ...overrides,
  }
}

/**
 * Builds a database exactly as E1 (schema version 1) left it, with one
 * trial saved under E1's vocabulary, so the upgrade path stays tested.
 */
function createE1Database(filePath: string): void {
  const db = new Database(filePath)
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 'create trials', '2026-11-11T16:00:00.000Z');
    CREATE TABLE trials (
      trial_id TEXT PRIMARY KEY, test_number INTEGER UNIQUE, session_id TEXT, data_set_name TEXT,
      subject TEXT, question_number INTEGER, status TEXT, begin_ts TEXT, first_response_ts TEXT,
      end_ts TEXT, response_ms INTEGER, first_response_ms INTEGER, answer_text TEXT, citations TEXT
    );
    CREATE INDEX trials_session_id ON trials (session_id);
    INSERT INTO trials VALUES (
      'e1-trial', 1, 'e1-session', 'DOE_ORACLE-2026-11-11', 'oracle', 1, 'completed',
      '2026-11-11T16:28:12.439Z', '2026-11-11T16:28:34.786Z', '2026-11-11T16:28:34.822Z', 22383, 22347,
      'Combinatorial testing is a test design technique.', '["Applying_Combinatorial_Testing_in_Industrial_Settings · p.1"]'
    );
  `)
  db.close()
}

/** The migration versions recorded in a database file. Opens and closes its own connection: Windows cannot delete a file that is still open. */
function appliedVersions(filePath: string): number[] {
  const db = new Database(filePath, { readonly: true })
  try {
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
    return rows.map((row) => row.version)
  } finally {
    db.close()
  }
}

describe('MetricsRepository', () => {
  let repository: MetricsRepository

  beforeEach(async () => {
    repository = await MetricsRepository.open(':memory:')
  })

  afterEach(() => {
    repository.close()
  })

  it('migrates a fresh database to the current version and creates the trials table with the agreed columns', () => {
    expect(repository.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)

    const saved = repository.saveTrial(sampleTrial())

    expect(Object.keys(saved).sort()).toEqual(
      [
        'trialId', 'testNumber', 'sessionId', 'dataSetName', 'subject', 'questionNumber', 'status',
        'beginTs', 'firstResponseTs', 'endTs', 'responseMs', 'firstResponseMs', 'answerText', 'citations',
        'pageLoadMs', 'timeToAnswerMs', 'sourceUrl', 'sizeBytes', 'keywords',
      ].sort(),
    )
  })

  it('runs each migration once', () => {
    expect(repository.migrate()).toEqual([])
    expect(repository.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('saves a trial with the next test number and reads it back unchanged', () => {
    const saved = repository.saveTrial(sampleTrial())

    expect(saved.testNumber).toBe(1)
    expect(repository.listTrials()).toEqual([asSaved(sampleTrial(), 1)])
  })

  it('saves and reads back the Google-only fields and keywords', () => {
    const google = sampleTrial({
      subject: Subject.GOOGLE,
      pageLoadMs: 812,
      timeToAnswerMs: 14_250,
      sourceUrl: 'https://csrc.nist.gov/projects/automated-combinatorial-testing-for-software',
      keywords: 'combinatorial testing',
    })

    const saved = repository.saveTrial(google)

    expect(saved).toMatchObject({ pageLoadMs: 812, timeToAnswerMs: 14_250, keywords: 'combinatorial testing' })
    expect(repository.listTrials()).toEqual([saved])
  })

  it('saves the optional fields as null when a subject leaves them out', () => {
    repository.saveTrial(sampleTrial())

    expect(repository.listTrials()[0]).toMatchObject({ pageLoadMs: null, timeToAnswerMs: null, sourceUrl: null, keywords: null })
  })

  it('computes the size as the UTF-8 byte length of the answer, not its character count', () => {
    // "é" and "·" take two bytes each in UTF-8, "→" takes three.
    const saved = repository.saveTrial(sampleTrial({ answerText: 'é · →' }))

    expect(saved.sizeBytes).toBe(9)
    expect(repository.listTrials()[0]?.sizeBytes).toBe(9)
  })

  it('gives a trial with no answer a size of 0', () => {
    const saved = repository.saveTrial(sampleTrial({ answerText: null }))

    expect(saved.sizeBytes).toBe(0)
  })

  it('numbers trials sequentially across sessions', () => {
    repository.saveTrial(sampleTrial({ trialId: 'a', sessionId: 's1' }))
    repository.saveTrial(sampleTrial({ trialId: 'b', sessionId: 's2' }))
    const third = repository.saveTrial(sampleTrial({ trialId: 'c', sessionId: 's1' }))

    expect(third.testNumber).toBe(3)
    expect(repository.listTrials().map((t) => t.testNumber)).toEqual([3, 2, 1])
  })

  it('filters by session and subject and honours the limit', () => {
    repository.saveTrial(sampleTrial({ trialId: 'a', sessionId: 's1' }))
    repository.saveTrial(sampleTrial({ trialId: 'b', sessionId: 's2' }))
    repository.saveTrial(sampleTrial({ trialId: 'c', sessionId: 's1', subject: Subject.COPILOT }))

    expect(repository.listTrials({ sessionId: 's1' }).map((t) => t.trialId)).toEqual(['c', 'a'])
    expect(repository.listTrials({ sessionId: 's1', limit: 1 }).map((t) => t.trialId)).toEqual(['c'])
    expect(repository.listTrials({ subject: Subject.DOE_ORACLE })).toHaveLength(2)
    expect(repository.listTrials({ subject: Subject.COPILOT })).toHaveLength(1)
    expect(repository.listTrials({ sessionId: 'nope' })).toEqual([])
  })

  it('stores citations as a JSON array and tolerates an empty one', () => {
    repository.saveTrial(sampleTrial({ trialId: 'none', citations: [] }))

    expect(repository.listTrials()[0]?.citations).toEqual([])
  })

  it('keeps null timing fields as null', () => {
    repository.saveTrial(sampleTrial({ firstResponseTs: null, firstResponseMs: null }))

    const [trial] = repository.listTrials()
    expect(trial?.firstResponseTs).toBeNull()
    expect(trial?.firstResponseMs).toBeNull()
  })

  it('refuses to save the same trial id twice', () => {
    repository.saveTrial(sampleTrial())

    expect(() => repository.saveTrial(sampleTrial())).toThrow(/UNIQUE constraint failed: trials.trial_id/)
    expect(repository.listTrials()).toHaveLength(1)
  })

  it('reports the file it opened', () => {
    expect(repository.filePath).toBe(':memory:')
  })

  it('saves a failed trial with its failure and reads both back together', () => {
    const failure = { type: FailureType.TIMEOUT, message: 'No answer from DOE Oracle within 60 s', elapsedMs: 60_000 }
    const failed = sampleTrial({ trialId: 'failed-1', status: TrialStatus.FAILED, endTs: null, responseMs: null, answerText: null, citations: [] })

    const saved = repository.saveTrial(failed, failure)

    expect(saved).toEqual({ ...asSaved(failed, 1), failure })
    expect(repository.listTrials()).toEqual([saved])
    expect(repository.listTrials({ sessionId: 'session-a' })[0]?.failure).toEqual(failure)
  })

  it('lists successful and failed trials together, newest first, with the failure only where there is one', () => {
    repository.saveTrial(sampleTrial({ trialId: 'ok' }))
    repository.saveTrial(sampleTrial({ trialId: 'bad', status: TrialStatus.FAILED }), {
      type: FailureType.ERROR_RESPONSE,
      message: 'DOE Oracle answered with HTTP 500',
      elapsedMs: 1_200,
    })

    const [newest, oldest] = repository.listTrials()
    expect(newest?.trialId).toBe('bad')
    expect(newest?.failure).toEqual({ type: FailureType.ERROR_RESPONSE, message: 'DOE Oracle answered with HTTP 500', elapsedMs: 1_200 })
    expect(oldest?.trialId).toBe('ok')
    expect(oldest?.failure).toBeUndefined()
    expect(repository.listTrials({ subject: Subject.DOE_ORACLE, limit: 1 }).map((t) => t.trialId)).toEqual(['bad'])
  })

  it('refuses a FAILED trial without a failure, and a failure on a trial that did not fail', () => {
    expect(() => repository.saveTrial(sampleTrial({ status: TrialStatus.FAILED }))).toThrow(/FAILED but no failure was given/)
    expect(() =>
      repository.saveTrial(sampleTrial(), { type: FailureType.TIMEOUT, message: 'x', elapsedMs: 1 }),
    ).toThrow(/status is SUCCESS, not FAILED/)
    expect(repository.listTrials()).toEqual([])
  })

  it('enforces that a failure belongs to a saved trial', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec('CREATE TABLE trials (trial_id TEXT PRIMARY KEY); CREATE TABLE failed_requests (trial_id TEXT PRIMARY KEY REFERENCES trials (trial_id))')
    expect(() => db.prepare('INSERT INTO failed_requests VALUES (?)').run('orphan')).toThrow(/FOREIGN KEY constraint failed/)
    db.close()
  })

  it('saves a session and reads it back by id', () => {
    const session = { sessionId: 'session-a', startedAt: '2026-11-12T01:02:03.456Z', appVersion: '0.1.0' }

    repository.saveSession(session)

    expect(repository.getSession('session-a')).toEqual(session)
    expect(repository.getSession('nope')).toBeNull()
  })

  it('refuses to save the same session id twice', () => {
    const session = { sessionId: 'session-a', startedAt: '2026-11-12T01:02:03.456Z', appVersion: '0.1.0' }
    repository.saveSession(session)

    expect(() => repository.saveSession(session)).toThrow(/UNIQUE constraint failed: sessions.session_id/)
  })
})

describe('MetricsRepository migrations from an E1 database', () => {
  let dir: string
  let upgraded: MetricsRepository | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-e1-'))
  })

  afterEach(() => {
    upgraded?.close()
    upgraded = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('applies the later migrations in order and rewrites E1 rows into the shared vocabulary', async () => {
    const filePath = join(dir, 'harness.db')
    createE1Database(filePath)

    upgraded = await MetricsRepository.open(filePath)

    expect(upgraded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(appliedVersions(filePath)).toEqual([1, 2, 3, 4, 5])

    const [trial] = upgraded.listTrials()
    expect(trial).toMatchObject({
      trialId: 'e1-trial',
      testNumber: 1,
      subject: Subject.DOE_ORACLE,
      status: TrialStatus.SUCCESS,
      responseMs: 22383,
      citations: ['Applying_Combinatorial_Testing_in_Industrial_Settings · p.1'],
      // Migration 5 fills the size from the existing answer and leaves the rest null.
      sizeBytes: Buffer.byteLength('Combinatorial testing is a test design technique.', 'utf8'),
      pageLoadMs: null,
      timeToAnswerMs: null,
      sourceUrl: null,
      keywords: null,
    })
    // A trial saved after the upgrade continues the numbering, and the new tables are usable.
    expect(upgraded.saveTrial(sampleTrial({ trialId: 'e2-trial' })).testNumber).toBe(2)
    upgraded.saveSession({ sessionId: 'e2-session', startedAt: '2026-11-12T00:00:00.000Z', appVersion: '0.1.0' })
    expect(upgraded.getSession('e2-session')?.appVersion).toBe('0.1.0')
    const failed = upgraded.saveTrial(sampleTrial({ trialId: 'e2-failed', status: TrialStatus.FAILED }), {
      type: FailureType.UNREACHABLE,
      message: 'net::ERR_CONNECTION_REFUSED',
      elapsedMs: 15,
    })
    expect(failed.testNumber).toBe(3)
    expect(upgraded.listTrials()[0]?.failure?.type).toBe(FailureType.UNREACHABLE)
  })
})
