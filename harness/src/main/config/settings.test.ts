import { describe, expect, it } from 'vitest'
import { loadSettings, oracleChatUrl } from './settings'

describe('loadSettings', () => {
  it('defaults the Oracle to the local Vite dev server', () => {
    const settings = loadSettings({})

    expect(settings.oracle.baseUrl).toBe('http://localhost:5173')
    expect(settings.oracle.chatPath).toBe('/chat')
    expect(settings.oracle.searchEndpointPath).toBe('/api/search')
  })

  it('lets HARNESS_ORACLE_URL override the base URL and keeps only its origin', () => {
    const settings = loadSettings({ HARNESS_ORACLE_URL: 'http://127.0.0.1:4173/some/path/' })

    expect(settings.oracle.baseUrl).toBe('http://127.0.0.1:4173')
  })

  it('ignores a blank override', () => {
    expect(loadSettings({ HARNESS_ORACLE_URL: '   ' }).oracle.baseUrl).toBe('http://localhost:5173')
  })

  it('rejects an override that is not an http(s) URL', () => {
    expect(() => loadSettings({ HARNESS_ORACLE_URL: 'localhost:5173' })).toThrow(/not a valid URL|http or https/)
    expect(() => loadSettings({ HARNESS_ORACLE_URL: 'ftp://example.com' })).toThrow(/http or https/)
  })
})

describe('oracleChatUrl', () => {
  it('joins the base URL and the chat path', () => {
    expect(oracleChatUrl(loadSettings({}))).toBe('http://localhost:5173/chat')
    expect(oracleChatUrl(loadSettings({ HARNESS_ORACLE_URL: 'http://oracle.test:8080' }))).toBe(
      'http://oracle.test:8080/chat',
    )
  })
})
