import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExpertAnswerInput, ExpertInput } from '../../shared/expert-entry'
import { ResponseSource } from '../../shared/experts'
import { ErrorLog } from '../data/error-log'
import { MetricsRepository, WriteQueuedError } from '../data/metrics-repository'
import { ExpertRecordService } from './expert-record-service'

/** The Test Plan's UC-5 example: outreach on 2026-10-06, the first answer 14 days 3 hours later. */
const OUTREACH = '2026-10-06T14:00:00.000Z'
const FIRST_ANSWER = '2026-10-20T17:00:00.000Z'
const FOURTEEN_DAYS_THREE_HOURS_MS = (14 * 24 + 3) * 3_600_000

function expertInput(overrides: Partial<ExpertInput> = {}): ExpertInput {
  return {
    expertId: null,
    name: 'Dr. Wong',
    source: ResponseSource.EMAIL,
    outreachTs: OUTREACH,
    firstAnswerTs: FIRST_ANSWER,
    ...overrides,
  }
}

const SESSION = { sessionId: 'session-a', startedAt: '2026-11-20T15:00:00.000Z', appVersion: '0.2.0' }
const NOW = Date.UTC(2026, 10, 20, 16, 30, 0, 123)

/** A service on this repository, with the session, the 12 questions, the clock, and the ids fixed. */
function serviceOn(repository: MetricsRepository, overrides: Partial<ConstructorParameters<typeof ExpertRecordService>[0]> = {}) {
  let nextId = 0
  return new ExpertRecordService({
    repository,
    session: { getCurrentSession: () => SESSION },
    questions: { size: 12 },
    now: () => NOW,
    expertId: () => `expert-${++nextId}`,
    ...overrides,
  })
}

function answerInput(overrides: Partial<ExpertAnswerInput> = {}): ExpertAnswerInput {
  return {
    expertId: 'expert-1',
    questionNumber: 1,
    answerText: 'Combinatorial testing covers interactions among factors.',
    ...overrides,
  }
}

describe('ExpertRecordService: the expert record', () => {
  let repository: MetricsRepository
  let service: ExpertRecordService

  beforeEach(async () => {
    repository = await MetricsRepository.open(':memory:')
    service = serviceOn(repository)
  })

  afterEach(() => {
    repository.close()
  })

  it('creates an expert with a new id and the turnaround in milliseconds', () => {
    const result = service.saveExpert(expertInput())

    const expert = {
      expertId: 'expert-1',
      name: 'Dr. Wong',
      source: ResponseSource.EMAIL,
      outreachTs: OUTREACH,
      firstAnswerTs: FIRST_ANSWER,
      turnaroundMs: FOURTEEN_DAYS_THREE_HOURS_MS,
    }
    expect(result).toEqual({ status: 'SAVED', expert })
    expect(FOURTEEN_DAYS_THREE_HOURS_MS).toBe(1_220_400_000)
    expect(service.listExperts()).toEqual([expert])
  })

  it('generates a UUID for a new expert when no generator is given', () => {
    const result = serviceOn(repository, { expertId: undefined }).saveExpert(expertInput())

    expect(result.status === 'SAVED' && result.expert.expertId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('leaves the turnaround empty until the first answer is entered', () => {
    const result = service.saveExpert(expertInput({ firstAnswerTs: null }))

    expect(result).toMatchObject({ status: 'SAVED', expert: { firstAnswerTs: null, turnaroundMs: null } })
  })

  it('accepts equal times as a turnaround of zero', () => {
    const result = service.saveExpert(expertInput({ firstAnswerTs: OUTREACH }))

    expect(result).toMatchObject({ status: 'SAVED', expert: { turnaroundMs: 0 } })
  })

  it('stores the name without the spaces around it', () => {
    const result = service.saveExpert(expertInput({ name: '  Dr. Wong \n' }))

    expect(result).toMatchObject({ status: 'SAVED', expert: { name: 'Dr. Wong' } })
  })

  it.each([
    ['an empty name', { name: '' }, 'name', /^Name is required/],
    ['a name of spaces', { name: '   ' }, 'name', /^Name is required/],
    ['an unknown source', { source: 'PHONE' as ResponseSource }, 'source', /^Source must be Email or Interview/],
    ['no outreach time', { outreachTs: null }, 'outreachTs', /^Outreach time is required/],
    ['an outreach time that is not a timestamp', { outreachTs: '2026-10-06 09:00' }, 'outreachTs', /^Outreach time is not a valid/],
    ['an outreach date that does not exist', { outreachTs: '2026-02-30T09:00:00.000Z' }, 'outreachTs', /^Outreach time is not a valid/],
    ['a first answer that is not a timestamp', { firstAnswerTs: 'tomorrow' }, 'firstAnswerTs', /^First answer time is not a valid/],
    [
      'a first answer one minute before the outreach',
      { firstAnswerTs: '2026-10-06T13:59:00.000Z' },
      'firstAnswerTs',
      /^First answer time is earlier than the outreach time/,
    ],
  ])('refuses %s, names the field, and saves nothing', (_what, overrides, field, message) => {
    const result = service.saveExpert(expertInput(overrides))

    expect(result).toEqual({ status: 'INVALID', field, message: expect.stringMatching(message) })
    expect(service.listExperts()).toEqual([])
  })

  it('updates the expert with the given id and never adds a second record', () => {
    service.saveExpert(expertInput({ firstAnswerTs: null }))

    const result = service.saveExpert(
      expertInput({ expertId: 'expert-1', name: 'Dr. W. Eric Wong', source: ResponseSource.INTERVIEW, firstAnswerTs: FIRST_ANSWER }),
    )

    const updated = {
      expertId: 'expert-1',
      name: 'Dr. W. Eric Wong',
      source: ResponseSource.INTERVIEW,
      outreachTs: OUTREACH,
      firstAnswerTs: FIRST_ANSWER,
      turnaroundMs: FOURTEEN_DAYS_THREE_HOURS_MS,
    }
    expect(result).toEqual({ status: 'SAVED', expert: updated })
    expect(service.listExperts()).toEqual([updated])
  })

  it('recomputes the turnaround when a time is corrected, and clears it when the first answer is removed', () => {
    service.saveExpert(expertInput())

    const corrected = service.saveExpert(expertInput({ expertId: 'expert-1', firstAnswerTs: '2026-10-07T14:00:00.000Z' }))
    expect(corrected).toMatchObject({ status: 'SAVED', expert: { turnaroundMs: 86_400_000 } })

    const cleared = service.saveExpert(expertInput({ expertId: 'expert-1', firstAnswerTs: null }))
    expect(cleared).toMatchObject({ status: 'SAVED', expert: { turnaroundMs: null } })
    expect(repository.getExpert('expert-1')?.turnaroundMs).toBeNull()
  })

  it('refuses a new expert whose name is already saved, whatever its case or spacing', () => {
    service.saveExpert(expertInput())

    const result = service.saveExpert(expertInput({ name: ' dr.  wong ' }))

    expect(result).toEqual({
      status: 'INVALID',
      field: 'name',
      message: 'Name: an expert named Dr. Wong is already saved. Pick them from the Expert list to update them.',
    })
    expect(service.listExperts()).toHaveLength(1)
  })

  it('refuses renaming an expert to another saved expert\'s name, but lets an expert keep its own', () => {
    service.saveExpert(expertInput())
    service.saveExpert(expertInput({ name: 'Dr. Kuhn' }))

    expect(service.saveExpert(expertInput({ expertId: 'expert-2', name: 'DR. WONG' }))).toMatchObject({ status: 'INVALID', field: 'name' })
    expect(service.saveExpert(expertInput({ expertId: 'expert-1', name: 'dr. wong' }))).toMatchObject({
      status: 'SAVED',
      expert: { expertId: 'expert-1', name: 'dr. wong' },
    })
    expect(service.listExperts().map((expert) => expert.name)).toEqual(['Dr. Kuhn', 'dr. wong'])
  })

  it('throws for an id that is not saved, since that is not a mistake in the form', () => {
    expect(() => service.saveExpert(expertInput({ expertId: 'gone' }))).toThrow(/Expert gone is not saved/)
    expect(service.listExperts()).toEqual([])
  })
})

describe('ExpertRecordService: answers', () => {
  let repository: MetricsRepository
  let service: ExpertRecordService

  beforeEach(async () => {
    repository = await MetricsRepository.open(':memory:')
    service = serviceOn(repository)
    service.saveExpert(expertInput())
  })

  afterEach(() => {
    repository.close()
  })

  it('saves an answer in the current session with no keywords, and lists it', () => {
    const result = service.saveAnswer(answerInput())

    const saved = {
      responseId: 1,
      testNumber: 1,
      expertId: 'expert-1',
      sessionId: 'session-a',
      questionNumber: 1,
      answerText: 'Combinatorial testing covers interactions among factors.',
      sizeBytes: 56,
      keywords: null,
      recordedAt: '2026-11-20T16:30:00.123Z',
      supersededBy: null,
    }
    expect(result).toEqual({ status: 'SAVED', saved })
    expect(service.listAnswers('expert-1')).toEqual([saved])
  })

  it('drops blank lines at the very start and end and keeps everything else as pasted', () => {
    const pasted = '\n  \t\n  First line, indented.\n\nSecond paragraph, with trailing spaces.  \n \n\n'

    const result = service.saveAnswer(answerInput({ answerText: pasted }))

    const stored = '  First line, indented.\n\nSecond paragraph, with trailing spaces.  '
    expect(result).toMatchObject({ status: 'SAVED', saved: { answerText: stored } })
    expect(service.listAnswers('expert-1')[0]?.answerText).toBe(stored)
  })

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['only blank lines', '\n \t\n\r\n'],
  ])('refuses an answer that is %s, names the field, and saves nothing', (_what, answerText) => {
    const result = service.saveAnswer(answerInput({ answerText }))

    expect(result).toEqual({ status: 'INVALID', field: 'answerText', message: expect.stringMatching(/^Answer is empty/) })
    expect(service.listAnswers('expert-1')).toEqual([])
  })

  it.each([0, 13, -1, 1.5, Number.NaN])('refuses question %s: only 1 to 12 exist', (questionNumber) => {
    const result = service.saveAnswer(answerInput({ questionNumber }))

    expect(result).toEqual({ status: 'INVALID', field: 'questionNumber', message: 'Question must be a whole number from 1 to 12.' })
    expect(service.listAnswers('expert-1')).toEqual([])
  })

  it('accepts every question from 1 to 12 and lists the answers by question number', () => {
    for (const questionNumber of [12, 1, 7]) {
      expect(service.saveAnswer(answerInput({ questionNumber }))).toMatchObject({ status: 'SAVED' })
    }

    expect(service.listAnswers('expert-1').map((answer) => answer.questionNumber)).toEqual([1, 7, 12])
  })

  it('throws for an expert that is not saved', () => {
    expect(() => service.saveAnswer(answerInput({ expertId: 'gone' }))).toThrow(/Expert gone is not saved/)
  })

  it('stores the turnaround once, on the expert, and never on an answer', () => {
    const result = service.saveAnswer(answerInput())

    expect(result.status === 'SAVED' && Object.keys(result.saved)).not.toContain('turnaroundMs')
    expect(repository.getExpert('expert-1')?.turnaroundMs).toBe(FOURTEEN_DAYS_THREE_HOURS_MS)
  })

  it('keeps the state for the next launch: the same database gives the same experts and answers', () => {
    service.saveAnswer(answerInput({ questionNumber: 3 }))

    // A new launch: a new service and session over the same database.
    const relaunched = serviceOn(repository, { session: { getCurrentSession: () => ({ ...SESSION, sessionId: 'session-b' }) } })

    expect(relaunched.listExperts()).toMatchObject([{ expertId: 'expert-1', name: 'Dr. Wong' }])
    expect(relaunched.listAnswers('expert-1')).toMatchObject([{ questionNumber: 3, sessionId: 'session-a' }])
  })
})

describe('ExpertRecordService with a failing database', () => {
  let dir: string
  let log: ErrorLog
  let repository: MetricsRepository
  let raw: Database.Database
  let service: ExpertRecordService

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-expert-'))
    const dbPath = join(dir, 'harness.db')
    log = new ErrorLog(join(dir, 'pending-writes.jsonl'))
    repository = await MetricsRepository.open(dbPath, { errorLog: log })
    raw = new Database(dbPath)
    service = serviceOn(repository)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    raw.close()
    repository.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Makes every insert into a table fail in the database itself, as a damaged file would; reads still work. */
  const breakInserts = (table: string): void => {
    raw.exec(`CREATE TRIGGER break_${table} BEFORE INSERT ON ${table} BEGIN INSERT INTO table_that_is_gone VALUES (1); END`)
  }
  const restoreInserts = (table: string): void => {
    raw.exec(`DROP TRIGGER break_${table}`)
  }

  it('keeps an expert whose save fails in the failed-writes log, and a retry saves it', () => {
    breakInserts('experts')

    expect(() => service.saveExpert(expertInput())).toThrow(WriteQueuedError)
    expect(log.listPending()).toMatchObject([{ operation: 'saveExpert', payload: { expert: { expertId: 'expert-1', name: 'Dr. Wong' } } }])

    restoreInserts('experts')
    // Reading also makes the repository's connection notice the trigger is gone.
    expect(service.listExperts()).toEqual([])
    expect(log.retryAll(repository)).toBe(1)
    expect(service.listExperts()).toMatchObject([{ expertId: 'expert-1', name: 'Dr. Wong', turnaroundMs: FOURTEEN_DAYS_THREE_HOURS_MS }])
    expect(log.listPending()).toEqual([])
  })

  it('keeps an answer whose save fails in the failed-writes log, and a retry saves it', () => {
    service.saveExpert(expertInput())
    breakInserts('expert_responses')

    expect(() => service.saveAnswer(answerInput({ answerText: '\nKept for retry.\n' }))).toThrow(WriteQueuedError)
    expect(log.listPending()).toMatchObject([
      { operation: 'saveExpertResponse', payload: { response: { expertId: 'expert-1', questionNumber: 1, answerText: 'Kept for retry.' }, replace: false } },
    ])

    restoreInserts('expert_responses')
    // Reading also makes the repository's connection notice the trigger is gone.
    expect(service.listAnswers('expert-1')).toEqual([])
    expect(log.retryAll(repository)).toBe(1)
    expect(service.listAnswers('expert-1')).toMatchObject([{ questionNumber: 1, answerText: 'Kept for retry.', sessionId: 'session-a' }])
  })
})
