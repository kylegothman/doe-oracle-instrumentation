import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Question } from '../../shared/questions'
import { Subject } from '../../shared/subjects'
import { SubjectUnreachableError } from '../browser/navigation'
import { loadSettings, type GoogleSettings } from '../config/settings'
import {
  GOOGLE_SUBMIT_PROMPT,
  GoogleAdapter,
  GoogleAnswerError,
  GoogleSubmitTimeoutError,
  type GoogleAdapterOptions,
} from './google-adapter'
import { AdapterDisposedError, type AdapterNotice } from './subject-adapter'

const FIXTURE_HTML = readFileSync(fileURLToPath(new URL('./__fixtures__/google-search.html', import.meta.url)), 'utf8')
const QUESTION: Question = { number: 1, text: 'R32 GT-R fuel system modifications' }
const BASE_SETTINGS = loadSettings({}).google
const BROWSER_TEST_TIMEOUT_MS = 30_000

describe('GoogleAdapter against the search fixture', () => {
  let browser: Browser
  let page: Page
  let notices: AdapterNotice[]
  let mockServerUrl: string
  let closeServer: () => Promise<void>

  beforeAll(async () => {
    browser = await chromium.launch()
    // Simple local HTTP server for serving the static fixture with proper navigation events
    const http = await import('node:http')
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(FIXTURE_HTML)
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 8080
    mockServerUrl = `http://localhost:${port}`
    closeServer = () => new Promise((resolve) => server.close(() => resolve()))
  }, BROWSER_TEST_TIMEOUT_MS)

  afterAll(async () => {
    await browser?.close()
    await closeServer?.()
  })

  beforeEach(async () => {
    page = await browser.newPage()
    notices = []
  })

  afterEach(async () => {
    await page.close()
  })

  function settingsFor(overrides: Partial<GoogleSettings> = {}): GoogleSettings {
    return {
      ...BASE_SETTINGS,
      searchUrl: mockServerUrl,
      pageLoadTimeoutMs: 2_000,
      answerFoundTimeoutMs: 1_000,
      ...overrides,
    }
  }

  function adapterWith(settings = settingsFor(), options: GoogleAdapterOptions = {}): GoogleAdapter {
    const adapter = new GoogleAdapter({ getPage: async () => page }, settings, options)
    adapter.onNotice((notice) => notices.push(notice))
    return adapter
  }

  async function typed(adapter: GoogleAdapter): Promise<number> {
    const pending = adapter.start(QUESTION)
    await expect.poll(() => notices.length, { timeout: 5_000 }).toBe(1)
    return pending as unknown as Promise<number>
  }

  async function pressEnter(): Promise<number> {
    const at = Date.now()
    await page.locator(BASE_SETTINGS.selectors.input).press('Enter')
    return at
  }

  it('types the query, prompts Tester, and records start time on load', async () => {
    const adapter = adapterWith()
    let settled = false
    const pending = adapter.start(QUESTION)
    pending.then(() => (settled = true)).catch(() => (settled = true))

    await expect.poll(() => notices.length).toBe(1)
    expect(notices).toEqual([{ status: 'awaiting_submit', message: GOOGLE_SUBMIT_PROMPT }])

    const inputLocator = page.locator(BASE_SETTINGS.selectors.input)
    const inputValue = await inputLocator.inputValue()
    expect(inputValue).toBe(QUESTION.text)

    await page.waitForTimeout(200)
    expect(settled).toBe(false)

    const enterAt = await pressEnter()
    const beginMs = await pending

    expect(adapter.subject).toBe(Subject.GOOGLE)
    expect(beginMs).toBeGreaterThanOrEqual(enterAt)

    const firstResponseMs = await adapter.waitForFirstResponse()
    expect(firstResponseMs).toBeGreaterThanOrEqual(beginMs)

    const endMs = await adapter.waitForCompletion()
    expect(endMs).toBeGreaterThanOrEqual(firstResponseMs)

    const answer = await adapter.captureAnswer()
    expect(answer.sourceUrl).toBe(mockServerUrl)

    await adapter.dispose()
  }, BROWSER_TEST_TIMEOUT_MS)

  it('gives up with a clear error when the Tester never presses Enter within the page load timeout', async () => {
    const adapter = adapterWith(settingsFor({ pageLoadTimeoutMs: 500 }))
    const pending = adapter.start(QUESTION)

    await expect.poll(() => notices.length).toBe(1)
    await expect(pending).rejects.toThrow(GoogleSubmitTimeoutError)
    await expect(pending).rejects.toThrow(/Search page load timed out/)

    await adapter.dispose()
  }, BROWSER_TEST_TIMEOUT_MS)

  it('reports unreachable network errors cleanly', async () => {
    const adapter = adapterWith(settingsFor({ searchUrl: 'http://localhost:65535' })) // Invalid closed port
    let capturedSignal: any = null
    adapter.onFailure((signal) => {
      capturedSignal = signal
    })

    await expect(adapter.start(QUESTION)).rejects.toThrow(SubjectUnreachableError)
    expect(capturedSignal?.networkError).toMatch(/ERR_CONNECTION_REFUSED/)

    await adapter.dispose()
  }, BROWSER_TEST_TIMEOUT_MS)

  it('dispose() while waiting settles start() at once', async () => {
    const adapter = adapterWith()
    const pending = adapter.start(QUESTION)
    pending.catch(() => {})

    await expect.poll(() => notices.length).toBe(1)
    await adapter.dispose()

    await expect(pending).rejects.toThrow(AdapterDisposedError)
  }, BROWSER_TEST_TIMEOUT_MS)
})