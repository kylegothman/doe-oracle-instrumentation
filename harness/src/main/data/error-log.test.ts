import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResponseSource } from '../../shared/experts'
import { FailureType } from '../../shared/failures'
import { Subject } from '../../shared/subjects'
import { TrialStatus } from '../../shared/trials'
import { ErrorLog, type PendingOperation, type PendingWriteTarget } from './error-log'
import { ActiveAnswerExistsError, MetricsRepository, WriteQueuedError, type NewTrial } from './metrics-repository'

const FIXED_NOW = new Date('2026-11-14T12:00:00.000Z')

function sampleTrial(overrides: Partial<NewTrial> = {}): NewTrial {
  return {
    trialId: 'trial-1',
    sessionId: 'session-a',
    dataSetName: 'DOE_ORACLE-2026-11-14',
    subject: Subject.DOE_ORACLE,
    questionNumber: 1,
    status: TrialStatus.SUCCESS,
    beginTs: '2026-11-14T11:00:00.000Z',
    firstResponseTs: '2026-11-14T11:00:00.300Z',
    endTs: '2026-11-14T11:00:01.000Z',
    responseMs: 1_000,
    firstResponseMs: 300,
    answerText: 'Combinatorial testing covers t-way interactions.',
    citations: [],
    ...overrides,
  }
}

const trialWrite = (trialId = 'trial-1'): PendingOperation => ({
  operation: 'saveTrial',
  payload: { trial: sampleTrial({ trialId }), failure: null },
})

describe('ErrorLog', () => {
  let dir: string
  let logPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-errorlog-'))
    logPath = join(dir, 'pending-writes.jsonl')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty when there is no log file', () => {
    expect(new ErrorLog(logPath).listPending()).toEqual([])
  })

  it('records a failed save with an id, the error, and when it failed, and appends it to the file as one JSON line', () => {
    const log = new ErrorLog(logPath, () => FIXED_NOW)

    const write = log.record(trialWrite(), new Error('SQLITE_FULL: database or disk is full'))

    expect(write).toMatchObject({ ...trialWrite(), error: 'SQLITE_FULL: database or disk is full', failedAt: FIXED_NOW.toISOString() })
    expect(write.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(log.listPending()).toEqual([write])
    expect(readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([write])
  })

  it('keeps pending writes across a restart', () => {
    const write = new ErrorLog(logPath).record(trialWrite(), new Error('disk I/O error'))

    expect(new ErrorLog(logPath).listPending()).toEqual([write])
  })

  it('skips a line cut short by a crash and keeps the rest', () => {
    const write = new ErrorLog(logPath).record(trialWrite(), new Error('disk I/O error'))
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}{"id":"cut-sh`, 'utf8')

    expect(new ErrorLog(logPath).listPending()).toEqual([write])
  })

  it('removes a write whose retry succeeds, from memory and from the file', () => {
    const log = new ErrorLog(logPath)
    const write = log.record(trialWrite(), new Error('disk I/O error'))
    const target: PendingWriteTarget = { applyPendingWrite: vi.fn() }

    expect(log.retry(write.id, target)).toBe(true)

    expect(target.applyPendingWrite).toHaveBeenCalledWith(expect.objectContaining(trialWrite()))
    expect(log.listPending()).toEqual([])
    expect(new ErrorLog(logPath).listPending()).toEqual([])
  })

  it('keeps a write whose retry fails, with the new error, and keeps when it first failed', () => {
    const log = new ErrorLog(logPath, () => FIXED_NOW)
    const write = log.record(trialWrite(), new Error('disk I/O error'))
    const target: PendingWriteTarget = {
      applyPendingWrite: () => {
        throw new Error('database is locked')
      },
    }

    expect(log.retry(write.id, target)).toBe(false)

    const kept = { ...write, error: 'database is locked' }
    expect(log.listPending()).toEqual([kept])
    expect(new ErrorLog(logPath).listPending()).toEqual([kept])
  })

  it('returns false for an id that is not pending', () => {
    expect(new ErrorLog(logPath).retry('nope', { applyPendingWrite: vi.fn() })).toBe(false)
  })

  it('retries everything oldest first and reports how many succeeded', () => {
    const log = new ErrorLog(logPath)
    log.record(trialWrite('a'), new Error('x'))
    log.record(trialWrite('b'), new Error('x'))
    log.record(trialWrite('c'), new Error('x'))
    const order: string[] = []
    const target: PendingWriteTarget = {
      applyPendingWrite: (write) => {
        const id = write.operation === 'saveTrial' ? write.payload.trial.trialId : '?'
        order.push(id)
        if (id === 'b') throw new Error('still locked')
      },
    }

    expect(log.retryAll(target)).toBe(2)

    expect(order).toEqual(['a', 'b', 'c'])
    expect(log.listPending().map((w) => (w.operation === 'saveTrial' ? w.payload.trial.trialId : '?'))).toEqual(['b'])
  })

  it('hands out copies, so changing a listed write does not change the log', () => {
    const log = new ErrorLog(logPath)
    log.record(trialWrite(), new Error('x'))

    const [listed] = log.listPending()
    if (listed) listed.error = 'changed'

    expect(log.listPending()[0]?.error).toBe('x')
  })
})

/**
 * The repository and the ErrorLog together, with a real database failure:
 * a second connection renames a table, so the repository's next write fails
 * inside SQLite ("no such table"), and renames it back before the retry.
 */
describe('MetricsRepository with an ErrorLog', () => {
  let dir: string
  let dbPath: string
  let log: ErrorLog
  let repository: MetricsRepository
  let raw: Database.Database

  const breakTable = (table: string): void => {
    raw.exec(`ALTER TABLE ${table} RENAME TO ${table}_away`)
  }
  const restoreTable = (table: string): void => {
    raw.exec(`ALTER TABLE ${table}_away RENAME TO ${table}`)
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-queued-'))
    dbPath = join(dir, 'harness.db')
    log = new ErrorLog(join(dir, 'pending-writes.jsonl'), () => FIXED_NOW)
    repository = await MetricsRepository.open(dbPath, { errorLog: log })
    raw = new Database(dbPath)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    raw.close()
    repository.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a trial whose save fails in the database, says so, and saves it on retry', () => {
    breakTable('trials')

    let error: unknown
    try {
      repository.saveTrial(sampleTrial())
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(WriteQueuedError)
    expect((error as Error).message).toMatch(/^Trial trial-1 could not be saved \(no such table: trials\)\. It was kept in the error log/)
    const [pending] = log.listPending()
    expect(pending).toMatchObject({ operation: 'saveTrial', error: 'no such table: trials' })
    expect((error as WriteQueuedError).pendingWrite).toEqual(pending)

    restoreTable('trials')
    expect(log.retry(pending?.id ?? '', repository)).toBe(true)

    expect(repository.listTrials()).toMatchObject([{ trialId: 'trial-1', testNumber: 1 }])
    expect(log.listPending()).toEqual([])
  })

  it('keeps a failed trial together with its failure, and saves both on retry', () => {
    const failure = { type: FailureType.TIMEOUT, message: 'No answer within 60 s', elapsedMs: 60_000 }
    breakTable('failed_requests')

    expect(() => repository.saveTrial(sampleTrial({ status: TrialStatus.FAILED }), failure)).toThrow(WriteQueuedError)
    // The trial row was rolled back with the failure row: nothing half-saved.
    restoreTable('failed_requests')
    expect(repository.listTrials()).toEqual([])

    expect(log.retryAll(repository)).toBe(1)
    expect(repository.listTrials()[0]?.failure).toEqual(failure)
  })

  it('keeps an expert and an expert answer whose saves fail, and saves them on retry', () => {
    const expert = {
      expertId: 'expert-1',
      name: 'Dr. Wong',
      source: ResponseSource.EMAIL,
      outreachTs: null,
      firstAnswerTs: null,
      turnaroundMs: null,
    }
    const answer = {
      expertId: 'expert-1',
      sessionId: 'session-a',
      questionNumber: 1,
      answerText: 'An answer.',
      recordedAt: '2026-11-14T12:00:00.000Z',
    }
    breakTable('experts')
    expect(() => repository.saveExpert(expert)).toThrow(/Expert Dr\. Wong could not be saved/)
    restoreTable('experts')
    breakTable('expert_responses')
    expect(() => repository.saveExpertResponse(answer)).toThrow(/The answer to question 1 could not be saved/)
    restoreTable('expert_responses')

    expect(log.listPending().map((w) => w.operation)).toEqual(['saveExpert', 'saveExpertResponse'])
    expect(log.retryAll(repository)).toBe(2)

    expect(repository.getExpert('expert-1')).toEqual(expert)
    expect(repository.getActiveResponse('expert-1', 1)).toMatchObject({ answerText: 'An answer.', testNumber: 1 })
  })

  it('keeps the write pending when the retry fails again', () => {
    breakTable('trials')
    expect(() => repository.saveTrial(sampleTrial())).toThrow(WriteQueuedError)

    expect(log.retryAll(repository)).toBe(0)

    expect(log.listPending()).toHaveLength(1)
  })

  it('does not keep a save the data itself makes fail, since a retry would fail the same way', () => {
    repository.saveTrial(sampleTrial())

    expect(() => repository.saveTrial(sampleTrial())).toThrow(/UNIQUE constraint failed: trials.trial_id/)
    expect(() => repository.saveTrial(sampleTrial({ trialId: 'x', status: TrialStatus.FAILED }))).toThrow(/no failure was given/)

    expect(log.listPending()).toEqual([])
  })

  it('does not keep an answer refused because the question is already answered', () => {
    repository.saveExpert({ expertId: 'expert-1', name: 'Dr. Wong', source: ResponseSource.EMAIL, outreachTs: null, firstAnswerTs: null, turnaroundMs: null })
    const answer = { expertId: 'expert-1', sessionId: 's', questionNumber: 1, answerText: 'A.', recordedAt: '2026-11-14T12:00:00.000Z' }
    repository.saveExpertResponse(answer)

    expect(() => repository.saveExpertResponse(answer)).toThrow(ActiveAnswerExistsError)

    expect(log.listPending()).toEqual([])
  })

  it('rethrows database errors unchanged when no ErrorLog is given', async () => {
    const plain = await MetricsRepository.open(join(dir, 'plain.db'))
    const plainRaw = new Database(join(dir, 'plain.db'))
    try {
      plainRaw.exec('ALTER TABLE trials RENAME TO trials_away')
      expect(() => plain.saveTrial(sampleTrial())).toThrow(/^no such table: trials$/)
    } finally {
      plainRaw.close()
      plain.close()
    }
  })
})
