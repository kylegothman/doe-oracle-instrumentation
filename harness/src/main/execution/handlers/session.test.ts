import { describe, expect, it } from 'vitest'
import { createGetSessionHandler } from './session'

const session = { sessionId: 'session-1', startedAt: '2026-11-12T01:02:03.456Z', appVersion: '0.1.0' }

describe('session:get handler', () => {
  it('returns the current session once the manager is ready', async () => {
    const handler = createGetSessionHandler(async () => ({ getCurrentSession: () => session }))

    await expect(handler()).resolves.toEqual(session)
  })

  it('passes a failed start through as the error', async () => {
    const handler = createGetSessionHandler(async () => {
      throw new Error('Could not open harness.db')
    })

    await expect(handler()).rejects.toThrow(/Could not open harness.db/)
  })
})
