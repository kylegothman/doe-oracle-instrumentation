import { describe, expect, it, vi } from 'vitest'
import { Subject } from '../../../shared/subjects'
import type { Trial } from '../../../shared/trials'
import { createListTrialsHandler, createStartTrialHandler } from './trials'

const record = { trialId: 't', testNumber: 1 } as Trial

describe('trial:start handler', () => {
  it('runs the trial through the controller once it is ready', async () => {
    const startTrial = vi.fn(async () => record)
    const handler = createStartTrialHandler(async () => ({ startTrial }))

    await expect(handler(Subject.DOE_ORACLE, 1)).resolves.toBe(record)
    expect(startTrial).toHaveBeenCalledWith(Subject.DOE_ORACLE, 1)
  })

  it('rejects an unknown subject or a bad question number before touching the controller', async () => {
    const startTrial = vi.fn(async () => record)
    const handler = createStartTrialHandler(async () => ({ startTrial }))

    await expect(handler('bing' as Subject, 1)).rejects.toThrow(/Unknown subject "bing"/)
    await expect(handler(Subject.DOE_ORACLE, 0)).rejects.toThrow(/positive integer/)
    await expect(handler(Subject.DOE_ORACLE, 1.5)).rejects.toThrow(/positive integer/)
    expect(startTrial).not.toHaveBeenCalled()
  })

  it('passes a failed database open through as the error', async () => {
    const handler = createStartTrialHandler(async () => {
      throw new Error('Could not open harness.db')
    })

    await expect(handler(Subject.DOE_ORACLE, 1)).rejects.toThrow(/Could not open harness.db/)
  })
})

describe('trials:list handler', () => {
  it('lists all trials when no session is given, and one session when it is', async () => {
    const listTrials = vi.fn(() => [record])
    const handler = createListTrialsHandler(async () => ({ listTrials }))

    await expect(handler()).resolves.toEqual([record])
    expect(listTrials).toHaveBeenLastCalledWith({ limit: 20 })

    await handler('session-1')
    expect(listTrials).toHaveBeenLastCalledWith({ sessionId: 'session-1', limit: 20 })
  })
})
