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

  it('gives every subject a 60-second limit; the Oracle clock starts with the trial, the others at submit; only Copilot confirms the end', () => {
    const { trialPolicies } = loadSettings({})

    expect(trialPolicies).toEqual({
      [Subject.DOE_ORACLE]: { timeoutMs: 60_000, startsAt: 'trial_start', confirmEnd: false },
      [Subject.COPILOT]: { timeoutMs: 60_000, startsAt: 'submit', confirmEnd: true },
      [Subject.GOOGLE]: { timeoutMs: 60_000, startsAt: 'submit', confirmEnd: false },
    })
  })

  it('overrides every subject limit from HARNESS_TRIAL_TIMEOUT_MS', () => {
    const { trialPolicies } = loadSettings({ HARNESS_TRIAL_TIMEOUT_MS: '5000' })

    expect(trialPolicies[Subject.DOE_ORACLE]).toEqual({ timeoutMs: 5_000, startsAt: 'trial_start', confirmEnd: false })
    expect(trialPolicies[Subject.GOOGLE].timeoutMs).toBe(5_000)
  })

  it('rejects a time limit that is not a positive whole number of milliseconds', () => {
    expect(() => loadSettings({ HARNESS_TRIAL_TIMEOUT_MS: '0' })).toThrow(/positive whole number/)
    expect(() => loadSettings({ HARNESS_TRIAL_TIMEOUT_MS: '2.5' })).toThrow(/positive whole number/)
    expect(() => loadSettings({ HARNESS_TRIAL_TIMEOUT_MS: 'soon' })).toThrow(/positive whole number/)
  })
})

describe('loadSettings: Copilot', () => {
  it('drives Microsoft 365 Copilot Chat by default, with its URL, sign-in hosts, selectors, and waits', () => {
    const { copilot } = loadSettings({})

    expect(copilot.product).toBe('m365')
    expect(copilot.chatUrl).toBe('https://copilot.cloud.microsoft/chat')
    expect(copilot.signInHosts).toContain('login.microsoftonline.com')
    expect(copilot.chatHubPath).toBe('/m365Copilot/Chathub')
    expect(copilot.selectors.input).toBe('[role="textbox"][aria-label="Message Copilot"]')
    expect(copilot.selectors.stopButton).toBe('button[aria-label="Stop generating"]')
    expect(copilot.selectors.reply).toBe('[data-testid="markdown-reply"]')
    expect(copilot.quietPeriodMs).toBe(2_000)
    expect(copilot.submitWaitMs).toBe(300_000)
    expect(copilot.submitConfirmMs).toBe(2_000)
  })

  it('switches to consumer Copilot from HARNESS_COPILOT_PRODUCT without any code change', () => {
    const { copilot } = loadSettings({ HARNESS_COPILOT_PRODUCT: 'consumer' })

    expect(copilot.product).toBe('consumer')
    expect(copilot.chatUrl).toBe('https://copilot.com/chat')
    expect(copilot.signInHosts).toContain('login.live.com')
    // The consumer page showed the same editor, so the selectors match until a send works there.
    expect(copilot.selectors).toEqual(loadSettings({}).copilot.selectors)
  })

  it('ignores a blank product override and rejects an unknown one', () => {
    expect(loadSettings({ HARNESS_COPILOT_PRODUCT: '  ' }).copilot.product).toBe('m365')
    expect(() => loadSettings({ HARNESS_COPILOT_PRODUCT: 'bing' })).toThrow(
      /HARNESS_COPILOT_PRODUCT must be one of m365, consumer, got "bing"/,
    )
  })

  it('gives each product its own settings object, so a caller cannot change the defaults', () => {
    const first = loadSettings({})
    first.copilot.selectors.input = 'textarea'
    first.copilot.signInHosts.push('example.test')

    expect(loadSettings({}).copilot.selectors.input).toBe('[role="textbox"][aria-label="Message Copilot"]')
    expect(loadSettings({}).copilot.signInHosts).not.toContain('example.test')
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
