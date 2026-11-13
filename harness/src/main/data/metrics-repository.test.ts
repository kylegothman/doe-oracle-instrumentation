import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FailureType } from '../../shared/failures'
import { Subject } from '../../shared/subjects'
import { TrialStatus, type Trial } from '../../shared/trials'
import { ResponseSource, type Expert } from '../../shared/experts'
import { ActiveAnswerExistsError, MetricsRepository, type NewExpertResponse, type NewTrial } from './metrics-repository'

const CURRENT_SCHEMA_VERSION = 6

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

function sampleExpert(overrides: Partial<Expert> = {}): Expert {
  return {
    expertId: 'expert-1',
    name: 'Dr. Wong',
    source: ResponseSource.EMAIL,
    outreachTs: '2026-10-06T15:00:00.000Z',
    firstAnswerTs: '2026-11-03T09:30:00.000Z',
    turnaroundMs: 2_399_400_000,
    ...overrides,
  }
}

function sampleAnswer(overrides: Partial<NewExpertResponse> = {}): NewExpertResponse {
  return {
    expertId: 'expert-1',
    sessionId: 'session-a',
    questionNumber: 1,
    answerText: 'Combinatorial testing covers interactions among factors.',
    recordedAt: '2026-11-13T20:00:00.000Z',
    ...overrides,
  }
}

describe('MetricsRepository expert methods', () => {
  let repository: MetricsRepository

  beforeEach(async () => {
    repository = await MetricsRepository.open(':memory:')
  })

  afterEach(() => {
    repository.close()
  })

  it('saves an expert and reads it back by id', () => {
    expect(repository.saveExpert(sampleExpert())).toBe('expert-1')

    expect(repository.getExpert('expert-1')).toEqual(sampleExpert())
    expect(repository.getExpert('nope')).toBeNull()
  })

  it('saves an expert before the reply arrives and fills in the timestamps later', () => {
    repository.saveExpert(sampleExpert({ firstAnswerTs: null, turnaroundMs: null }))
    expect(repository.getExpert('expert-1')?.turnaroundMs).toBeNull()

    repository.saveExpert(sampleExpert())

    expect(repository.getExpert('expert-1')).toEqual(sampleExpert())
    expect(repository.listExperts()).toHaveLength(1)
  })

  it('lists experts by name', () => {
    repository.saveExpert(sampleExpert({ expertId: 'b', name: 'Zhang' }))
    repository.saveExpert(sampleExpert({ expertId: 'a', name: 'Adams', source: ResponseSource.INTERVIEW }))

    expect(repository.listExperts().map((e) => e.name)).toEqual(['Adams', 'Zhang'])
  })

  it('saves an answer with the next test number and its size, and reads it back as the active answer', () => {
    repository.saveExpert(sampleExpert())

    const { saved, superseded } = repository.saveExpertResponse(sampleAnswer({ answerText: 'é · →', keywords: 'combinatorial testing' }))

    expect(superseded).toBeNull()
    expect(saved).toEqual({
      ...sampleAnswer({ answerText: 'é · →', keywords: 'combinatorial testing' }),
      responseId: 1,
      testNumber: 1,
      sizeBytes: 9,
      supersededBy: null,
    })
    expect(repository.getActiveResponse('expert-1', 1)).toEqual(saved)
    expect(repository.getActiveResponse('expert-1', 2)).toBeNull()
  })

  it('refuses an answer for an expert that was never saved', () => {
    expect(() => repository.saveExpertResponse(sampleAnswer())).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('refuses a second answer to the same question unless replace is set, and saves nothing', () => {
    repository.saveExpert(sampleExpert())
    const { saved: first } = repository.saveExpertResponse(sampleAnswer())

    let error: unknown
    try {
      repository.saveExpertResponse(sampleAnswer({ answerText: 'A revised answer.' }))
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ActiveAnswerExistsError)
    expect((error as ActiveAnswerExistsError).existing).toEqual(first)
    expect(repository.listExpertResponses('expert-1', { includeSuperseded: true })).toEqual([first])
    expect(repository.nextTestNumber()).toBe(2)
  })

  it('replaces an answer without losing the original, and the revision keeps its test number', () => {
    repository.saveExpert(sampleExpert())
    const { saved: original } = repository.saveExpertResponse(sampleAnswer({ questionNumber: 7 }))
    expect(original.testNumber).toBe(1)

    const { saved: revised, superseded } = repository.saveExpertResponse(
      sampleAnswer({ questionNumber: 7, answerText: 'A revised answer.' }),
      { replace: true },
    )

    expect(revised).toMatchObject({ responseId: 2, testNumber: 1, supersededBy: null, answerText: 'A revised answer.' })
    const kept = { ...original, supersededBy: 2, testNumber: null }
    expect(superseded).toEqual(kept)
    expect(repository.getActiveResponse('expert-1', 7)).toEqual(revised)
    expect(repository.listExpertResponses('expert-1')).toEqual([revised])
    expect(repository.listExpertResponses('expert-1', { includeSuperseded: true })).toEqual([kept, revised])
  })

  it('does not use up a test number when an answer is replaced, so the numbers stay without gaps', () => {
    repository.saveExpert(sampleExpert())
    repository.saveTrial(sampleTrial({ trialId: 'a' }))
    repository.saveExpertResponse(sampleAnswer({ questionNumber: 7 }))
    repository.saveExpertResponse(sampleAnswer({ questionNumber: 7, answerText: 'Revised once.' }), { replace: true })
    repository.saveExpertResponse(sampleAnswer({ questionNumber: 7, answerText: 'Revised twice.' }), { replace: true })
    const next = repository.saveTrial(sampleTrial({ trialId: 'b' }))

    expect(repository.getActiveResponse('expert-1', 7)).toMatchObject({ testNumber: 2, answerText: 'Revised twice.' })
    expect(next.testNumber).toBe(3)
    expect(
      repository.listExpertResponses('expert-1', { includeSuperseded: true }).map((r) => [r.testNumber, r.supersededBy]),
    ).toEqual([
      [null, 2],
      [null, 3],
      [2, null],
    ])
  })

  it('treats replace on an unanswered question as a plain save', () => {
    repository.saveExpert(sampleExpert())

    const { saved, superseded } = repository.saveExpertResponse(sampleAnswer(), { replace: true })

    expect(superseded).toBeNull()
    expect(repository.getActiveResponse('expert-1', 1)).toEqual(saved)
  })

  it('lists only the active answers by question number by default', () => {
    repository.saveExpert(sampleExpert())
    repository.saveExpertResponse(sampleAnswer({ questionNumber: 3 }))
    repository.saveExpertResponse(sampleAnswer({ questionNumber: 1 }))
    repository.saveExpertResponse(sampleAnswer({ questionNumber: 3, answerText: 'Revised.' }), { replace: true })

    expect(repository.listExpertResponses('expert-1').map((r) => [r.questionNumber, r.answerText])).toEqual([
      [1, sampleAnswer().answerText],
      [3, 'Revised.'],
    ])
    expect(repository.listExpertResponses('nobody')).toEqual([])
  })

  it('shares the test number sequence with trials', () => {
    repository.saveExpert(sampleExpert())
    repository.saveTrial(sampleTrial({ trialId: 'a' }))
    const { saved } = repository.saveExpertResponse(sampleAnswer())
    const trial = repository.saveTrial(sampleTrial({ trialId: 'b' }))

    expect([saved.testNumber, trial.testNumber]).toEqual([2, 3])
  })
})

/**
 * Migration 6 on its own, through raw SQL: the repository's expert methods
 * come in a later commit, and these rules must hold whatever code writes.
 */
describe('expert tables (migration 6)', () => {
  let dir: string
  let db: Database.Database

  const insertExpert = (id = 'expert-1', source = 'EMAIL'): void => {
    db.prepare(
      `INSERT INTO experts (expert_id, name, source, outreach_ts, first_answer_ts, turnaround_ms)
       VALUES (?, 'Dr. Wong', ?, '2026-11-01T15:00:00.000Z', '2026-11-03T09:30:00.000Z', 153000000)`,
    ).run(id, source)
  }
  const insertAnswer = (responseId: number, testNumber: number | null, questionNumber = 1, supersededBy: number | null = null): void => {
    db.prepare(
      `INSERT INTO expert_responses (
         response_id, test_number, expert_id, session_id, question_number, answer_text, size_bytes, recorded_at, superseded_by
       ) VALUES (?, ?, 'expert-1', 'session-a', ?, 'An answer.', 10, '2026-11-03T09:31:00.000Z', ?)`,
    ).run(responseId, testNumber, questionNumber, supersededBy)
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-experts-'))
    const filePath = join(dir, 'harness.db')
    const repository = await MetricsRepository.open(filePath)
    repository.close()
    db = new Database(filePath)
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stores an expert with the turnaround once and answers that point back to it', () => {
    insertExpert()
    insertAnswer(1, 1, 1)
    insertAnswer(2, 2, 2)

    expect(db.prepare('SELECT name, source, turnaround_ms FROM experts').get()).toEqual({
      name: 'Dr. Wong',
      source: 'EMAIL',
      turnaround_ms: 153000000,
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM expert_responses WHERE expert_id = ?').get('expert-1')).toEqual({ n: 2 })
  })

  it('accepts only EMAIL or INTERVIEW as the response source', () => {
    insertExpert('expert-1', 'INTERVIEW')

    expect(() => insertExpert('expert-2', 'PHONE')).toThrow(/CHECK constraint failed/)
  })

  it('refuses an answer for an expert that does not exist', () => {
    expect(() => insertAnswer(1, 1)).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('refuses a second active answer to the same question from the same expert', () => {
    insertExpert()
    insertAnswer(1, 1, 3)

    expect(() => insertAnswer(2, 2, 3)).toThrow(/UNIQUE constraint failed/)
  })

  it('refuses two expert answers with the same test number', () => {
    insertExpert()
    insertAnswer(1, 7, 1)

    expect(() => insertAnswer(2, 7, 2)).toThrow(/UNIQUE constraint failed: expert_responses.test_number/)
  })

  it('replaces an answer by superseding the old row in the same transaction, keeping both', () => {
    insertExpert()
    insertAnswer(1, 1, 3)

    db.transaction(() => {
      db.prepare('UPDATE expert_responses SET superseded_by = 2, test_number = NULL WHERE response_id = 1').run()
      insertAnswer(2, 1, 3)
    })()

    const rows = db.prepare('SELECT response_id, test_number, superseded_by FROM expert_responses ORDER BY response_id').all()
    expect(rows).toEqual([
      { response_id: 1, test_number: null, superseded_by: 2 },
      { response_id: 2, test_number: 1, superseded_by: null },
    ])
    // Still only one active answer, so a third one is refused until the second is superseded.
    expect(() => insertAnswer(3, 3, 3)).toThrow(/UNIQUE constraint failed/)
  })

  it('lets any number of superseded answers have no test number', () => {
    insertExpert()
    insertAnswer(3, 1, 3)
    db.transaction(() => {
      insertAnswer(1, null, 3, 3)
      insertAnswer(2, null, 3, 3)
    })()

    expect(db.prepare('SELECT COUNT(*) AS n FROM expert_responses WHERE test_number IS NULL').get()).toEqual({ n: 2 })
  })

  it('rolls back a supersede that points at an answer that was never saved', () => {
    insertExpert()
    insertAnswer(1, 1, 3)

    expect(() =>
      db.transaction(() => {
        db.prepare('UPDATE expert_responses SET superseded_by = 99 WHERE response_id = 1').run()
      })(),
    ).toThrow(/FOREIGN KEY constraint failed/)
    expect(db.prepare('SELECT superseded_by FROM expert_responses WHERE response_id = 1').get()).toEqual({ superseded_by: null })
  })
})

/**
 * Trials and expert answers share one Test # sequence. The expert answers
 * are written through a second connection with raw SQL until the
 * repository's expert methods exist.
 */
describe('shared test numbers', () => {
  let dir: string
  let filePath: string
  let repository: MetricsRepository
  let raw: Database.Database

  const insertExpertAnswer = (testNumber: number, questionNumber: number): void => {
    raw.prepare(
      `INSERT INTO expert_responses (
         test_number, expert_id, session_id, question_number, answer_text, size_bytes, recorded_at
       ) VALUES (?, 'expert-1', 'session-a', ?, 'An answer.', 10, '2026-11-03T09:31:00.000Z')`,
    ).run(testNumber, questionNumber)
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-numbers-'))
    filePath = join(dir, 'harness.db')
    repository = await MetricsRepository.open(filePath)
    raw = new Database(filePath)
    raw.pragma('foreign_keys = ON')
    raw.prepare("INSERT INTO experts (expert_id, name, source) VALUES ('expert-1', 'Dr. Wong', 'EMAIL')").run()
  })

  afterEach(() => {
    raw.close()
    repository.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts at 1 on an empty database', () => {
    expect(repository.nextTestNumber()).toBe(1)
  })

  it('continues after the highest number in either table', () => {
    repository.saveTrial(sampleTrial({ trialId: 'oracle' }))
    repository.saveTrial(sampleTrial({ trialId: 'copilot', subject: Subject.COPILOT }))
    expect(repository.nextTestNumber()).toBe(3)

    insertExpertAnswer(repository.nextTestNumber(), 1)

    // Without the shared sequence this trial would also get 3.
    expect(repository.saveTrial(sampleTrial({ trialId: 'google', subject: Subject.GOOGLE })).testNumber).toBe(4)
    expect(repository.nextTestNumber()).toBe(5)
  })

  it('gives a trial the number after the expert answers when only they exist', () => {
    insertExpertAnswer(1, 1)
    insertExpertAnswer(2, 2)

    expect(repository.saveTrial(sampleTrial()).testNumber).toBe(3)
  })

  it('never gives two rows the same number across both tables', () => {
    for (let question = 1; question <= 4; question++) {
      repository.saveTrial(sampleTrial({ trialId: `trial-${question}`, questionNumber: question }))
      insertExpertAnswer(repository.nextTestNumber(), question)
    }

    const numbers = (
      raw.prepare('SELECT test_number FROM trials UNION ALL SELECT test_number FROM expert_responses').all() as Array<{
        test_number: number
      }>
    ).map((row) => row.test_number)
    expect(numbers).toHaveLength(8)
    expect(new Set(numbers).size).toBe(8)
    expect(Math.max(...numbers)).toBe(8)
  })

  it('picks up where it left off after the app is reopened', async () => {
    repository.saveTrial(sampleTrial({ trialId: 'before-restart' }))
    insertExpertAnswer(repository.nextTestNumber(), 1)
    repository.close()

    repository = await MetricsRepository.open(filePath)

    expect(repository.saveTrial(sampleTrial({ trialId: 'after-restart' })).testNumber).toBe(3)
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
    expect(appliedVersions(filePath)).toEqual([1, 2, 3, 4, 5, 6])

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
