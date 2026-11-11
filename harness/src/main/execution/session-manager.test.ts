import { describe, expect, it } from 'vitest'
import { SessionManager } from './session-manager'

describe('SessionManager', () => {
  it('generates one UUID per launch', () => {
    const first = new SessionManager()
    const second = new SessionManager()

    expect(first.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second.sessionId).not.toBe(first.sessionId)
  })

  it('accepts a fixed session id and clock for tests', () => {
    const session = new SessionManager({ sessionId: 'fixed', now: () => 1_000 })

    expect(session.sessionId).toBe('fixed')
    expect(session.startedAtMs).toBe(1_000)
  })

  it('builds the data set name from the subject code and the local date', () => {
    const session = new SessionManager()

    expect(session.buildDataSetName('oracle', new Date(2026, 10, 11, 23, 59, 59))).toBe('DOE_ORACLE-2026-11-11')
    expect(session.buildDataSetName('oracle', new Date(2026, 0, 5, 0, 0, 1))).toBe('DOE_ORACLE-2026-01-05')
  })
})
