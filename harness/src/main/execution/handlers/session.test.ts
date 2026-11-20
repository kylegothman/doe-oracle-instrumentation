import { describe, expect, it } from 'vitest'
import { createGetSessionHandler, createListSessionsHandler } from './session'

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

describe('sessions:list handler', () => {
  it('lists the saved sessions once the database is open', async () => {
    const older = { ...session, sessionId: 'session-0', startedAt: '2026-11-10T01:02:03.456Z' }
    const handler = createListSessionsHandler(async () => ({ listSessions: () => [session, older] }))

    await expect(handler()).resolves.toEqual([session, older])
  })

  it('passes a failed database open through as the error', async () => {
    const handler = createListSessionsHandler(async () => {
      throw new Error('Could not open harness.db')
    })

    await expect(handler()).rejects.toThrow(/Could not open harness.db/)
  })
})
