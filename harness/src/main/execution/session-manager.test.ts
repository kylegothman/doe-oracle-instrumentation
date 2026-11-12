import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../../shared/session'
import { Subject } from '../../shared/subjects'
import { SessionManager } from './session-manager'

function managerWith(overrides: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  const saved: Session[] = []
  const manager = new SessionManager({
    store: { saveSession: (session) => saved.push(session) },
    appVersion: '0.1.0',
    ...overrides,
  })
  return { manager, saved }
}

describe('SessionManager', () => {
  it('starts one session per launch with a UUID, the start time, and the app version, and saves it', () => {
    const { manager, saved } = managerWith({ now: () => Date.UTC(2026, 10, 12, 1, 2, 3, 456) })

    const session = manager.startSession()

    expect(session.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(session.startedAt).toBe('2026-11-12T01:02:03.456Z')
    expect(session.appVersion).toBe('0.1.0')
    expect(saved).toEqual([session])
    expect(manager.getCurrentSession()).toBe(session)
  })

  it('generates a different id on every launch', () => {
    const first = managerWith().manager.startSession()
    const second = managerWith().manager.startSession()

    expect(second.sessionId).not.toBe(first.sessionId)
  })

  it('refuses to start a second session in the same launch', () => {
    const { manager } = managerWith({ sessionId: () => 'fixed' })
    manager.startSession()

    expect(() => manager.startSession()).toThrow(/A session \(fixed\) has already been started/)
  })

  it('has no current session before startSession() runs', () => {
    const { manager } = managerWith()

    expect(() => manager.getCurrentSession()).toThrow(/No session has been started yet/)
  })

  it('does not start a session the store could not save', () => {
    const manager = new SessionManager({
      store: {
        saveSession: vi.fn(() => {
          throw new Error('disk full')
        }),
      },
      appVersion: '0.1.0',
    })

    expect(() => manager.startSession()).toThrow(/disk full/)
    expect(() => manager.getCurrentSession()).toThrow(/No session/)
  })

  it('records nothing that identifies the Tester (NFR-7)', () => {
    const session = managerWith().manager.startSession()

    expect(Object.keys(session).sort()).toEqual(['appVersion', 'sessionId', 'startedAt'])
  })

  it('builds the data set name from the subject code and the local date', () => {
    const { manager } = managerWith()

    expect(manager.buildDataSetName(Subject.DOE_ORACLE, new Date(2026, 10, 11, 23, 59, 59))).toBe('DOE_ORACLE-2026-11-11')
    expect(manager.buildDataSetName(Subject.COPILOT, new Date(2026, 0, 5, 0, 0, 1))).toBe('COPILOT-2026-01-05')
    expect(manager.buildDataSetName(Subject.GOOGLE, new Date(2026, 0, 5))).toBe('GOOGLE-2026-01-05')
  })
})
