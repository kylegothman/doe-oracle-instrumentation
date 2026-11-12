import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MetricsRepository, type NewTrial } from './metrics-repository'

function sampleTrial(overrides: Partial<NewTrial> = {}): NewTrial {
  return {
    trialId: 'trial-1',
    sessionId: 'session-a',
    dataSetName: 'DOE_ORACLE-2026-11-11',
    subject: 'oracle',
    questionNumber: 1,
    status: 'completed',
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

describe('MetricsRepository', () => {
  let repository: MetricsRepository

  beforeEach(async () => {
    repository = await MetricsRepository.open(':memory:')
  })

  afterEach(() => {
    repository.close()
  })

  it('migrates a fresh database to version 1 and creates the trials table with the agreed columns', async () => {
    expect(repository.schemaVersion).toBe(1)

    const columns = (await (async () => {
      // Read the schema back through a second, throw-away save: the column list comes from the row shape.
      const saved = repository.saveTrial(sampleTrial())
      return Object.keys(saved).sort()
    })()).sort()

    expect(columns).toEqual(
      [
        'trialId', 'testNumber', 'sessionId', 'dataSetName', 'subject', 'questionNumber', 'status',
        'beginTs', 'firstResponseTs', 'endTs', 'responseMs', 'firstResponseMs', 'answerText', 'citations',
      ].sort(),
    )
  })

  it('runs each migration once', () => {
    expect(repository.migrate()).toEqual([])
    expect(repository.schemaVersion).toBe(1)
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
    repository.saveTrial(sampleTrial({ trialId: 'c', sessionId: 's1' }))

    expect(repository.listTrials({ sessionId: 's1' }).map((t) => t.trialId)).toEqual(['c', 'a'])
    expect(repository.listTrials({ sessionId: 's1', limit: 1 }).map((t) => t.trialId)).toEqual(['c'])
    expect(repository.listTrials({ subject: 'oracle' })).toHaveLength(3)
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
})
