import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { OracleSettings } from '../config/settings'
import { OracleAdapter, OracleAnswerError } from './oracle-adapter'

const FIXTURE_HTML = readFileSync(fileURLToPath(new URL('./__fixtures__/oracle-chat.html', import.meta.url)), 'utf8')
const QUESTION = 'What is combinatorial testing?'
const ANSWER = 'Combinatorial testing selects test cases that cover all t-way interactions among input parameters.'
const RESULTS = [
  { quote: 'q1', source: 'Applying_Combinatorial_Testing_in_Industrial_Settings.pdf', page: '3', supports: 'yes' },
  { quote: 'q2', source: 'How does combinatorial testing perform in the real world.pdf', page: '12', supports: 'yes' },
]
const SETTINGS: OracleSettings = { baseUrl: 'http://oracle.test', chatPath: '/chat', searchEndpointPath: '/api/search' }
const BROWSER_TEST_TIMEOUT_MS = 30_000

/** Serves the fixture page and fakes the search endpoint with a delay, recording what the page sent. */
function serveFakeOracle(
  page: Page,
  options: { delayMs?: number; status?: number; body?: unknown } = {},
): { requests: Array<{ method: string; query: unknown }> } {
  const requests: Array<{ method: string; query: unknown }> = []
  const delayMs = options.delayMs ?? 250
  void page.route('http://oracle.test/**', async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/chat') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML })
      return
    }
    if (path === '/api/search') {
      requests.push({ method: request.method(), query: request.postDataJSON()?.query })
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      await route.fulfill({
        status: options.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(options.body ?? { summary: ANSWER, results: RESULTS }),
      })
      return
    }
    await route.fulfill({ status: 404, body: 'not found' })
  })
  return { requests }
}

describe('OracleAdapter against the chat fixture', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch()
  }, BROWSER_TEST_TIMEOUT_MS)

  afterAll(async () => {
    await browser?.close()
  })

  beforeEach(async () => {
    page = await browser.newPage()
  })

  afterEach(async () => {
    await page.close()
  })

  it(
    'types the exact question, submits with Enter, times the answer in order, and captures it',
    async () => {
      const fake = serveFakeOracle(page, { delayMs: 250 })
      const adapter = new OracleAdapter(page, SETTINGS)
      await adapter.open()

      const beginMs = await adapter.start(QUESTION)
      const firstResponseMs = await adapter.waitForFirstResponse()
      const endMs = await adapter.waitForCompletion()
      const answer = await adapter.captureAnswer()

      expect(fake.requests).toEqual([{ method: 'POST', query: QUESTION }])
      expect(beginMs).toBeLessThan(firstResponseMs)
      expect(firstResponseMs).toBeLessThan(endMs)
      expect(firstResponseMs - beginMs).toBeGreaterThanOrEqual(250)
      expect(answer.text).toBe(ANSWER)
      expect(answer.citations).toEqual([
        'Applying_Combinatorial_Testing_in_Industrial_Settings.pdf · p.3',
        'How does combinatorial testing perform in the real world.pdf · p.12',
      ])
      expect(answer.sourceUrl).toBe('http://oracle.test/chat')
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'ignores the greeting bubble that is already on the page',
    async () => {
      serveFakeOracle(page, { delayMs: 50 })
      const adapter = new OracleAdapter(page, SETTINGS)
      await adapter.open()
      expect(await page.locator('button[title="Copy"]').count()).toBe(1)

      await adapter.start(QUESTION)
      await adapter.waitForCompletion()

      expect((await adapter.captureAnswer()).text).toBe(ANSWER)
      expect(await page.locator('button[title="Copy"]').count()).toBe(2)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports the Oracle error message instead of waiting for an answer that never comes',
    async () => {
      serveFakeOracle(page, { delayMs: 50, status: 500, body: { error: 'Internal server error' } })
      const adapter = new OracleAdapter(page, SETTINGS, { answerTimeoutMs: 5_000 })
      await adapter.open()

      await adapter.start(QUESTION)

      await expect(adapter.waitForCompletion()).rejects.toThrow(OracleAnswerError)
      await expect(adapter.waitForCompletion()).rejects.toThrow(/Error searching for .*Internal server error/)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'gives up with a clear error when no answer appears in time',
    async () => {
      serveFakeOracle(page, { delayMs: 3_000 })
      const adapter = new OracleAdapter(page, SETTINGS, { answerTimeoutMs: 500 })
      await adapter.open()

      await adapter.start(QUESTION)

      await expect(adapter.waitForFirstResponse()).rejects.toThrow(/No answer appeared within 1 s/)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it('refuses to wait before a question was submitted', async () => {
    serveFakeOracle(page)
    const adapter = new OracleAdapter(page, SETTINGS)

    await expect(adapter.waitForCompletion()).rejects.toThrow(/start\(question\) must be called/)
  })
})
