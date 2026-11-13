import { describe, expect, it } from 'vitest'
import { Subject } from '../../shared/subjects'
import { loadSettings, oracleChatUrl } from './settings'

describe('loadSettings', () => {
  it('uses the config defaults when nothing is set', () => {
    const settings = loadSettings({})

    expect(settings.oracle.baseUrl).toBe('http://localhost:5173')
    expect(settings.oracle.chatPath).toBe('/chat')
    expect(settings.oracle.searchEndpointPath).toBe('/api/search')
  })

  it('overrides the Oracle origin from HARNESS_ORACLE_URL and drops any path', () => {
    const settings = loadSettings({ HARNESS_ORACLE_URL: 'http://127.0.0.1:4173/some/path' })

    expect(settings.oracle.baseUrl).toBe('http://127.0.0.1:4173')
  })

  it('ignores a blank override', () => {
    expect(loadSettings({ HARNESS_ORACLE_URL: '   ' }).oracle.baseUrl).toBe('http://localhost:5173')
  })

  it('rejects an override that is not an http(s) URL', () => {
    expect(() => loadSettings({ HARNESS_ORACLE_URL: 'localhost:5173' })).toThrow(/not a valid URL|must use http/)
    expect(() => loadSettings({ HARNESS_ORACLE_URL: 'ftp://oracle.test' })).toThrow(/must use http or https/)
  })

  it('gives every subject a 60-second limit; the Oracle clock starts with the trial, the others at submit', () => {
    const { trialTimeouts } = loadSettings({})

    expect(trialTimeouts).toEqual({
      [Subject.DOE_ORACLE]: { timeoutMs: 60_000, startsAt: 'trial_start' },
      [Subject.COPILOT]: { timeoutMs: 60_000, startsAt: 'submit' },
      [Subject.GOOGLE]: { timeoutMs: 60_000, startsAt: 'submit' },
    })
  })

  it('overrides every subject limit from HARNESS_TRIAL_TIMEOUT_MS', () => {
    const { trialTimeouts } = loadSettings({ HARNESS_TRIAL_TIMEOUT_MS: '5000' })

    expect(trialTimeouts[Subject.DOE_ORACLE]).toEqual({ timeoutMs: 5_000, startsAt: 'trial_start' })
    expect(trialTimeouts[Subject.GOOGLE].timeoutMs).toBe(5_000)
  })

  it('rejects a time limit that is not a positive whole number of milliseconds', () => {
    expect(() => loadSettings({ HARNESS_TRIAL_TIMEOUT_MS: '0' })).toThrow(/positive whole number/)
    expect(() => loadSettings({ HARNESS_TRIAL_TIMEOUT_MS: '2.5' })).toThrow(/positive whole number/)
    expect(() => loadSettings({ HARNESS_TRIAL_TIMEOUT_MS: 'soon' })).toThrow(/positive whole number/)
  })
})

describe('oracleChatUrl', () => {
  it('joins the chat path onto the base URL', () => {
    expect(oracleChatUrl(loadSettings({}))).toBe('http://localhost:5173/chat')
    expect(oracleChatUrl(loadSettings({ HARNESS_ORACLE_URL: 'http://oracle.test:8080' }))).toBe(
      'http://oracle.test:8080/chat',
    )
  })
})
