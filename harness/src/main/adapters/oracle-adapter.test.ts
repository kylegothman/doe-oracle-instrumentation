import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FailureType, type FailureSignal } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import { Subject } from '../../shared/subjects'
import { SubjectUnreachableError } from '../browser/navigation'
import type { OracleSettings } from '../config/settings'
import { FailureDetector } from '../execution/failure-detector'
import { AdapterDisposedError, OracleAdapter, OracleAnswerError, type OracleAdapterOptions } from './oracle-adapter'

const FIXTURE_HTML = readFileSync(fileURLToPath(new URL('./__fixtures__/oracle-chat.html', import.meta.url)), 'utf8')
const QUESTION: Question = { number: 1, text: 'What is combinatorial testing?' }
const ANSWER = 'Combinatorial testing selects test cases that cover all t-way interactions among input parameters.'
const RESULTS = [
  { quote: 'q1', source: 'Applying_Combinatorial_Testing_in_Industrial_Settings.pdf', page: '3', supports: 'yes' },
  { quote: 'q2', source: 'How does combinatorial testing perform in the real world.pdf', page: '12', supports: 'yes' },
]
const SETTINGS: OracleSettings = { baseUrl: 'http://oracle.test', chatPath: '/chat', searchEndpointPath: '/api/search' }
const detector = new FailureDetector()
const BROWSER_TEST_TIMEOUT_MS = 30_000

/** Serves the fixture page and fakes the search endpoint with a delay, recording what the page sent. */
async function serveFakeOracle(
  page: Page,
  options: { delayMs?: number; status?: number; body?: unknown; abort?: boolean; chatDown?: boolean } = {},
): Promise<{ requests: Array<{ method: string; query: unknown; receivedAt: number }> }> {
  const requests: Array<{ method: string; query: unknown; receivedAt: number }> = []
  const delayMs = options.delayMs ?? 250
  await page.route('http://oracle.test/**', async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/chat') {
      if (options.chatDown) {
        await route.abort('connectionrefused')
        return
      }
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
  let signals: FailureSignal[]

  beforeAll(async () => {
    browser = await chromium.launch()
  }, BROWSER_TEST_TIMEOUT_MS)

  afterAll(async () => {
    await browser?.close()
  })

  beforeEach(async () => {
    page = await browser.newPage()
    signals = []
  })

  afterEach(async () => {
    await page.close()
  })

  /** An adapter on the test page that records every failure signal in `signals`. */
  function adapterWith(options: OracleAdapterOptions = {}): OracleAdapter {
    const adapter = new OracleAdapter({ getPage: async () => page }, SETTINGS, options)
    adapter.onFailure((signal) => signals.push(signal))
    return adapter
  }

  it(
    'opens the chat, types the exact question, submits with Enter, times the answer in order, and captures it',
    async () => {
      const fake = await serveFakeOracle(page, { delayMs: 250 })
      const adapter = adapterWith()

      const beforeStart = Date.now()
      const beginMs = await adapter.start(QUESTION)
      const firstResponseMs = await adapter.waitForFirstResponse()
      const endMs = await adapter.waitForCompletion()
      const answer = await adapter.captureAnswer()

      expect(adapter.subject).toBe(Subject.DOE_ORACLE)
      expect(page.url()).toBe('http://oracle.test/chat')
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]).toMatchObject({ method: 'POST', query: QUESTION.text })
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
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'ignores the greeting bubble that is already on the page',
    async () => {
      await serveFakeOracle(page, { delayMs: 50 })
      const adapter = adapterWith()

      await adapter.start(QUESTION)
      await adapter.waitForCompletion()

      expect((await adapter.captureAnswer()).text).toBe(ANSWER)
      expect(await page.locator('button[title="Copy"]').count()).toBe(2)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'runs a second trial on the same adapter from a freshly loaded chat page',
    async () => {
      const fake = await serveFakeOracle(page, { delayMs: 50 })
      const adapter = adapterWith()

      await adapter.start(QUESTION)
      await adapter.waitForCompletion()
      await adapter.dispose()
      await adapter.start({ number: 2, text: 'What makes combinatorial testing cost effective?' })
      await adapter.waitForCompletion()

      expect(fake.requests.map((r) => r.query)).toEqual([QUESTION.text, 'What makes combinatorial testing cost effective?'])
      // The page was reloaded between trials, so only the greeting and one answer are on it.
      expect(await page.locator('button[title="Copy"]').count()).toBe(2)
      expect((await adapter.captureAnswer()).text).toBe(ANSWER)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports a 500 from the search endpoint as an error response, with first response still stamped',
    async () => {
      await serveFakeOracle(page, { delayMs: 50, status: 500, body: { error: 'Internal server error' } })
      const adapter = adapterWith({ answerTimeoutMs: 5_000 })

      const beginMs = await adapter.start(QUESTION)
      const firstResponseMs = await adapter.waitForFirstResponse()

      expect(firstResponseMs).toBeGreaterThanOrEqual(beginMs)
      expect(signals).toEqual([{ httpStatus: 500, timedOut: false }])
      expect(detector.classify(signals[0]!)).toBe(FailureType.ERROR_RESPONSE)
      // The page shows its own error line and no answer ever comes.
      await expect(adapter.waitForCompletion()).rejects.toThrow(OracleAnswerError)
      await expect(adapter.waitForCompletion()).rejects.toThrow(/Error searching for .*Internal server error/)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports an answer bubble that stays empty as an empty answer, with end stamped when it appeared',
    async () => {
      await serveFakeOracle(page, { delayMs: 50, body: { summary: '', results: [] } })
      const adapter = adapterWith()

      await adapter.start(QUESTION)
      const firstResponseMs = await adapter.waitForFirstResponse()
      const endMs = await adapter.waitForCompletion()
      const answer = await adapter.captureAnswer()

      expect(endMs).toBeGreaterThanOrEqual(firstResponseMs)
      expect(answer).toEqual({ text: '', citations: [], sourceUrl: 'http://oracle.test/chat' })
      expect(signals).toEqual([{ answerText: '', timedOut: false }])
      expect(detector.classify(signals[0]!)).toBe(FailureType.EMPTY_ANSWER)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'treats a refusal as an answer and reports no failure',
    async () => {
      await serveFakeOracle(page, { delayMs: 50, body: { summary: "I can't answer that question.", results: [] } })
      const adapter = adapterWith()

      await adapter.start(QUESTION)
      await adapter.waitForCompletion()

      expect((await adapter.captureAnswer()).text).toBe("I can't answer that question.")
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'gives up with a clear error when its own answer bound is set and no response arrives in time',
    async () => {
      await serveFakeOracle(page, { delayMs: 3_000 })
      const adapter = adapterWith({ answerTimeoutMs: 500 })

      await adapter.start(QUESTION)

      await expect(adapter.waitForFirstResponse()).rejects.toThrow(/No response from \/api\/search within 0\.5 s/)
      await expect(adapter.waitForCompletion()).rejects.toThrow(/No answer appeared within 0\.5 s/)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports a request that fails before any response as a network failure, as when the backend is down',
    async () => {
      await serveFakeOracle(page, { abort: true })
      const adapter = adapterWith({ answerTimeoutMs: 5_000 })

      const beginMs = await adapter.start(QUESTION)

      expect(beginMs).toBeGreaterThan(0)
      await expect(adapter.waitForFirstResponse()).rejects.toThrow(
        /The request to \/api\/search failed before a response arrived \(net::ERR_CONNECTION_REFUSED\)/,
      )
      expect(signals).toEqual([
        {
          networkError: 'The request to /api/search failed before a response arrived (net::ERR_CONNECTION_REFUSED)',
          timedOut: false,
        },
      ])
      expect(detector.classify(signals[0]!)).toBe(FailureType.UNREACHABLE)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports the frontend being down as a network failure from start()',
    async () => {
      await serveFakeOracle(page, { chatDown: true })
      const adapter = adapterWith()

      await expect(adapter.start(QUESTION)).rejects.toThrow(SubjectUnreachableError)
      expect(signals).toHaveLength(1)
      expect(signals[0]).toMatchObject({ timedOut: false })
      expect(signals[0]?.networkError).toMatch(
        /Could not reach the DOE Oracle at http:\/\/oracle\.test\/chat.*\(net::ERR_CONNECTION_REFUSED\)/,
      )
      expect(detector.classify(signals[0]!)).toBe(FailureType.UNREACHABLE)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports the page showing an error before any request left as a network failure',
    async () => {
      await serveFakeOracle(page)
      const adapter = adapterWith({ submitTimeoutMs: 5_000 })
      // Make the page fail before fetch: its search handler throws, so it shows the error line and sends nothing.
      await page.route('http://oracle.test/chat', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: FIXTURE_HTML.replace("const response = await fetch(", "throw new TypeError('Failed to fetch'); const response = await fetch("),
        }),
      )

      await expect(adapter.start(QUESTION)).rejects.toThrow(/could not send the search request: Error searching for .*Failed to fetch/)
      expect(signals).toHaveLength(1)
      expect(detector.classify(signals[0]!)).toBe(FailureType.UNREACHABLE)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'fails start() with a clear error if the page never sends the search request',
    async () => {
      await serveFakeOracle(page)
      const adapter = adapterWith({ submitTimeoutMs: 300 })
      // Disable the page's Enter handler so nothing is sent.
      await page.route('http://oracle.test/chat', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: FIXTURE_HTML.replace('</script>', "document.querySelector('input').addEventListener('keydown', (e) => e.stopImmediatePropagation(), true)</script>"),
        }),
      )

      await expect(adapter.start(QUESTION)).rejects.toThrow(
        /did not send a request to \/api\/search within 0\.3 s/,
      )
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'explains when the page at the Oracle URL is not the Oracle chat',
    async () => {
      await page.route('http://oracle.test/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Something else</title><p>Not the Oracle</p>' }),
      )
      const adapter = adapterWith()

      await expect(adapter.start(QUESTION)).rejects.toThrow(
        /The page at http:\/\/oracle\.test\/chat loaded but does not look like the DOE Oracle chat/,
      )
      expect(signals[0]?.networkError).toMatch(/does not look like the DOE Oracle chat/)
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  )

  it(
    'dispose() settles a pending wait at once and leaves the adapter ready for another trial',
    async () => {
      const fake = await serveFakeOracle(page, { delayMs: 3_000 })
      const adapter = adapterWith()
      await adapter.start(QUESTION)
      const pending = adapter.waitForCompletion()
      pending.catch(() => {})

      const disposedAt = Date.now()
      await adapter.dispose()
      await expect(pending).rejects.toThrow(AdapterDisposedError)
      expect(Date.now() - disposedAt).toBeLessThan(1_500)

      await adapter.dispose()
      await expect(adapter.waitForCompletion()).rejects.toThrow(/start\(question\) must be called/)
      fake.requests.length = 0
      await adapter.start(QUESTION)
      expect(fake.requests).toHaveLength(1)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it('refuses to wait before a question was submitted', async () => {
    await serveFakeOracle(page)
    const adapter = adapterWith()

    await expect(adapter.waitForCompletion()).rejects.toThrow(/start\(question\) must be called/)
    await expect(adapter.waitForFirstResponse()).rejects.toThrow(/start\(question\) must be called/)
  })
})
