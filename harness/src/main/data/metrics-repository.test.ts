import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Subject } from '../../shared/subjects'
import { TrialStatus } from '../../shared/trials'
import { MetricsRepository, type NewTrial } from './metrics-repository'

const CURRENT_SCHEMA_VERSION = 3

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
    expect(repository.listTrials()).toEqual([{ ...sampleTrial(), testNumber: 1 }])
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
    const applied = new Database(filePath, { readonly: true })
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    expect(applied.map((row) => row.version)).toEqual([1, 2, 3])

    const [trial] = upgraded.listTrials()
    expect(trial).toMatchObject({
      trialId: 'e1-trial',
      testNumber: 1,
      subject: Subject.DOE_ORACLE,
      status: TrialStatus.SUCCESS,
      responseMs: 22383,
      citations: ['Applying_Combinatorial_Testing_in_Industrial_Settings · p.1'],
    })
    // A trial saved after the upgrade continues the numbering, and the new tables are usable.
    expect(upgraded.saveTrial(sampleTrial({ trialId: 'e2-trial' })).testNumber).toBe(2)
    upgraded.saveSession({ sessionId: 'e2-session', startedAt: '2026-11-12T00:00:00.000Z', appVersion: '0.1.0' })
    expect(upgraded.getSession('e2-session')?.appVersion).toBe('0.1.0')
  })
})
