import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExpertInput } from '../../shared/expert-entry'
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

describe('ExpertRecordService: the expert record', () => {
  let repository: MetricsRepository
  let service: ExpertRecordService
  let nextId: number

  beforeEach(async () => {
    repository = await MetricsRepository.open(':memory:')
    nextId = 0
    service = new ExpertRecordService({ repository, expertId: () => `expert-${++nextId}` })
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
    const result = new ExpertRecordService({ repository }).saveExpert(expertInput())

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
    service = new ExpertRecordService({ repository, expertId: () => 'expert-1' })
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
})
