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
async function serveFakeOracle(
  page: Page,
  options: { delayMs?: number; status?: number; body?: unknown; abort?: boolean } = {},
): Promise<{ requests: Array<{ method: string; query: unknown; receivedAt: number }> }> {
  const requests: Array<{ method: string; query: unknown; receivedAt: number }> = []
  const delayMs = options.delayMs ?? 250
  await page.route('http://oracle.test/**', async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/chat') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML })
      return
    }
    if (path === '/api/search') {
      requests.push({ method: request.method(), query: request.postDataJSON()?.query, receivedAt: Date.now() })
      if (options.abort) {
        await route.abort('connectionrefused')
        return
      }
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
      const fake = await serveFakeOracle(page, { delayMs: 250 })
      const adapter = new OracleAdapter(page, SETTINGS)
      await adapter.open()

      const beforeStart = Date.now()
      const beginMs = await adapter.start(QUESTION)
      const firstResponseMs = await adapter.waitForFirstResponse()
      const endMs = await adapter.waitForCompletion()
      const answer = await adapter.captureAnswer()

      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]).toMatchObject({ method: 'POST', query: QUESTION })
      // begin is when the POST left the page: after start() was called, and no later than the fake server saw it.
      expect(beginMs).toBeGreaterThanOrEqual(beforeStart)
      expect(beginMs).toBeLessThanOrEqual(fake.requests[0]!.receivedAt)
      // first response is when the response arrived: at least the fake delay after begin, and before the page showed it.
      expect(beginMs).toBeLessThan(firstResponseMs)
      expect(firstResponseMs - beginMs).toBeGreaterThanOrEqual(250)
      expect(firstResponseMs).toBeLessThan(endMs)
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
      await serveFakeOracle(page, { delayMs: 50 })
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
      await serveFakeOracle(page, { delayMs: 50, status: 500, body: { error: 'Internal server error' } })
      const adapter = new OracleAdapter(page, SETTINGS, { answerTimeoutMs: 5_000 })
      await adapter.open()

      await adapter.start(QUESTION)

      await expect(adapter.waitForCompletion()).rejects.toThrow(OracleAnswerError)
      await expect(adapter.waitForCompletion()).rejects.toThrow(/Error searching for .*Internal server error/)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'gives up with a clear error when no response arrives in time',
    async () => {
      await serveFakeOracle(page, { delayMs: 3_000 })
      const adapter = new OracleAdapter(page, SETTINGS, { answerTimeoutMs: 500 })
      await adapter.open()

      await adapter.start(QUESTION)

      await expect(adapter.waitForFirstResponse()).rejects.toThrow(/No response from \/api\/search within 0\.5 s/)
      await expect(adapter.waitForCompletion()).rejects.toThrow(/No answer appeared within 0\.5 s/)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports a request that fails before any response, as when the backend is down',
    async () => {
      await serveFakeOracle(page, { abort: true })
      const adapter = new OracleAdapter(page, SETTINGS, { answerTimeoutMs: 5_000 })
      await adapter.open()

      const beginMs = await adapter.start(QUESTION)

      expect(beginMs).toBeGreaterThan(0)
      await expect(adapter.waitForFirstResponse()).rejects.toThrow(
        /The request to \/api\/search failed before a response arrived \(net::ERR_CONNECTION_REFUSED\)/,
      )
      await expect(adapter.waitForCompletion()).rejects.toThrow(/The Oracle reported an error: Error searching for/)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'fails start() with a clear error if the page never sends the search request',
    async () => {
      await serveFakeOracle(page)
      const adapter = new OracleAdapter(page, SETTINGS, { submitTimeoutMs: 300 })
      await adapter.open()
      // Disable the page's Enter handler so nothing is sent.
      await page.evaluate(() => {
        document.querySelector('input')?.addEventListener('keydown', (e) => e.stopImmediatePropagation(), true)
      })

      await expect(adapter.start(QUESTION)).rejects.toThrow(
        /did not send a request to \/api\/search within 0\.3 s/,
      )
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it('refuses to wait before a question was submitted', async () => {
    await serveFakeOracle(page)
    const adapter = new OracleAdapter(page, SETTINGS)

    await expect(adapter.waitForCompletion()).rejects.toThrow(/start\(question\) must be called/)
  })
})
