import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResponseSource } from '../../../shared/experts'
import { Subject } from '../../../shared/subjects'
import { TrialStatus } from '../../../shared/trials'
import type { PendingWrite, PendingWriteTarget } from '../../data/error-log'
import { createListFailedWritesHandler, createRetryFailedWritesHandler } from './errors'

const base = { error: 'database or disk is full', failedAt: '2026-11-14T12:00:00.000Z' }

const pending: PendingWrite[] = [
  {
    ...base,
    id: 'w1',
    operation: 'saveTrial',
    payload: {
      trial: {
        trialId: 't1',
        sessionId: 's',
        dataSetName: 'COPILOT-2026-11-14',
        subject: Subject.COPILOT,
        questionNumber: 3,
        status: TrialStatus.SUCCESS,
        beginTs: null,
        firstResponseTs: null,
        endTs: null,
        responseMs: null,
        firstResponseMs: null,
        answerText: 'An answer.',
        citations: [],
      },
      failure: null,
    },
  },
  {
    ...base,
    id: 'w2',
    operation: 'saveExpert',
    payload: {
      expert: { expertId: 'e', name: 'Dr. Wong', source: ResponseSource.EMAIL, outreachTs: null, firstAnswerTs: null, turnaroundMs: null },
    },
  },
  {
    ...base,
    id: 'w3',
    operation: 'saveExpertResponse',
    payload: {
      response: { expertId: 'e', sessionId: 's', questionNumber: 7, answerText: 'A.', recordedAt: base.failedAt },
      replace: true,
    },
  },
]

describe('errors:list handler', () => {
  it('summarizes each pending write for the page, without its payload', () => {
    const handler = createListFailedWritesHandler({ listPending: () => pending })

    expect(handler()).toEqual([
      { ...base, id: 'w1', operation: 'saveTrial', description: 'Microsoft Copilot trial, question 3' },
      { ...base, id: 'w2', operation: 'saveExpert', description: 'Expert Dr. Wong' },
      { ...base, id: 'w3', operation: 'saveExpertResponse', description: 'Expert answer to question 7' },
    ])
  })

  it('returns an empty list when nothing is waiting', () => {
    expect(createListFailedWritesHandler({ listPending: () => [] })()).toEqual([])
  })
})

describe('errors:retry handler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries everything against the repository once it is open and returns how many succeeded', async () => {
    const target: PendingWriteTarget = { applyPendingWrite: vi.fn() }
    const retryAll = vi.fn(() => 2)
    const handler = createRetryFailedWritesHandler({ retryAll }, async () => target)

    await expect(handler()).resolves.toBe(2)
    expect(retryAll).toHaveBeenCalledWith(target)
  })

  it('passes a failed database open through as the error, without retrying', async () => {
    const retryAll = vi.fn(() => 0)
    const handler = createRetryFailedWritesHandler({ retryAll }, async () => {
      throw new Error('Could not open harness.db')
    })

    await expect(handler()).rejects.toThrow(/Could not open harness.db/)
    expect(retryAll).not.toHaveBeenCalled()
  })
})
