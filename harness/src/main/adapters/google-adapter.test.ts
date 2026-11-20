import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FailureType, type FailureSignal } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import { Subject } from '../../shared/subjects'
import { SubjectUnreachableError } from '../browser/navigation'
import { loadSettings, type GoogleSettings } from '../config/settings'
import { FailureDetector } from '../execution/failure-detector'
import { startFakeGoogle, type FakeGoogle } from './__fixtures__/fake-google'
import {
  GOOGLE_CHALLENGE_AFTER_SUBMIT,
  GOOGLE_CHALLENGE_PROMPT,
  GOOGLE_SUBMIT_PROMPT,
  GoogleAdapter,
  GoogleAnswerError,
  GoogleChallengeError,
  GoogleSubmitTimeoutError,
  type GoogleAdapterOptions,
} from './google-adapter'
import { AdapterDisposedError, type AdapterNotice } from './subject-adapter'

const QUESTION: Question = { number: 1, text: 'What is combinatorial testing?' }
const BASE_SETTINGS = loadSettings({}).google
const BROWSER_TEST_TIMEOUT_MS = 30_000
const detector = new FailureDetector()

/**
 * Every test here runs against the saved pages in __fixtures__, served by a
 * local server. The tests press Enter themselves, standing in for the
 * Tester; the adapter never does, and nothing here contacts Google.
 */
describe('GoogleAdapter against the saved search and results pages', () => {
  let browser: Browser
  let google: FakeGoogle
  let page: Page
  let notices: AdapterNotice[]
  let signals: FailureSignal[]
  let adapter: GoogleAdapter | null

  beforeAll(async () => {
    browser = await chromium.launch()
    google = await startFakeGoogle()
  }, BROWSER_TEST_TIMEOUT_MS)

  afterAll(async () => {
    await browser?.close()
    await google?.close()
  })

  beforeEach(async () => {
    google.reset()
    page = await browser.newPage()
    notices = []
    signals = []
    adapter = null
  })

  afterEach(async () => {
    await adapter?.dispose()
    await page.close()
  })

  function settingsFor(overrides: Partial<GoogleSettings> = {}): GoogleSettings {
    return { ...BASE_SETTINGS, searchUrl: `${google.origin}/`, ...overrides }
  }

  function adapterWith(settings = settingsFor(), options: GoogleAdapterOptions = {}): GoogleAdapter {
    const created = new GoogleAdapter({ getPage: async () => page }, settings, options)
    created.onNotice((notice) => notices.push(notice))
    created.onFailure((signal) => signals.push(signal))
    adapter = created
    return created
  }

  /**
   * Starts a trial and waits until the question is typed and the Tester has
   * been told to press Enter. The pending start() comes back inside an
   * object: an async function that returned the promise itself would wait
   * for it, that is, for an Enter nobody has pressed yet.
   */
  async function typed(created: GoogleAdapter): Promise<{ pending: Promise<number> }> {
    const pending = created.start(QUESTION)
    pending.catch(() => {})
    await expect.poll(() => notices.length, { timeout: 10_000 }).toBe(1)
    return { pending }
  }

  /** The Tester's Enter. Resolves with the moment just before the key went down. */
  async function pressEnter(): Promise<number> {
    const at = Date.now()
    await page.locator(BASE_SETTINGS.selectors.input).first().press('Enter')
    return at
  }

  /** Runs a trial up to the results page having loaded. */
  async function loadedResults(created: GoogleAdapter): Promise<{ beginMs: number; firstResponseMs: number; endMs: number }> {
    const { pending } = await typed(created)
    await pressEnter()
    const beginMs = await pending
    const firstResponseMs = await created.waitForFirstResponse()
    const endMs = await created.waitForCompletion()
    return { beginMs, firstResponseMs, endMs }
  }

  /** Highlights an element's text, as the Tester does by dragging over a passage. */
  async function highlight(selector: string): Promise<void> {
    await page.evaluate((target) => {
      const node = document.querySelector(target)
      if (!node) throw new Error(`Nothing matches ${target}`)
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }, selector)
  }

  it(
    'types the exact question, tells the Tester to press Enter, and does not begin until they do',
    async () => {
      const created = adapterWith()
      let settled = false
      const pending = created.start(QUESTION)
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      )

      await expect.poll(() => notices.length, { timeout: 10_000 }).toBe(1)
      expect(notices).toEqual([{ status: 'awaiting_submit', message: GOOGLE_SUBMIT_PROMPT }])
      expect(await page.locator(BASE_SETTINGS.selectors.input).first().inputValue()).toBe(QUESTION.text)

      // The home page loaded long ago. Nothing the Tester does, or does not do, before Enter starts the trial.
      await page.waitForLoadState('load')
      await page.waitForTimeout(400)
      expect(settled).toBe(false)
      expect(google.searches).toHaveLength(0)

      const enterAt = await pressEnter()
      const beginMs = await pending
      const afterBegin = Date.now()

      expect(created.subject).toBe(Subject.GOOGLE)
      expect(google.searches.map((search) => search.query)).toEqual([QUESTION.text])
      expect(beginMs).toBeGreaterThanOrEqual(enterAt)
      expect(beginMs).toBeLessThanOrEqual(afterBegin)
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'takes first response from the server answering the search, and the end from the results page finishing loading',
    async () => {
      google.options.searchDelayMs = 300
      google.options.assetDelayMs = 350
      const created = adapterWith()

      const { beginMs, firstResponseMs, endMs } = await loadedResults(created)

      // The server held its answer for 300 ms, then an image held the load event for 350 ms more.
      expect(firstResponseMs - beginMs).toBeGreaterThanOrEqual(280)
      expect(endMs - firstResponseMs).toBeGreaterThanOrEqual(330)
      expect(endMs).toBeLessThanOrEqual(Date.now())
      expect(await page.evaluate(() => document.readyState)).toBe('complete')
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'stamps first response at the first answer when the search is redirected, and still ends at the load',
    async () => {
      google.options.redirectSearch = true
      const created = adapterWith()

      const { beginMs, firstResponseMs, endMs } = await loadedResults(created)

      expect(google.searches).toHaveLength(2)
      expect(firstResponseMs).toBeGreaterThanOrEqual(beginMs)
      expect(endMs).toBeGreaterThanOrEqual(firstResponseMs)
      expect(new URL(page.url()).searchParams.get('redirected')).toBe('1')
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'gives up with a clear error when the Tester never presses Enter within the submit wait',
    async () => {
      const created = adapterWith(settingsFor(), { submitWaitMs: 400 })
      const { pending } = await typed(created)

      await expect(pending).rejects.toThrow(GoogleSubmitTimeoutError)
      await expect(pending).rejects.toThrow(/not submitted within 0\.4 s: no Enter in the Google window/)
      // Not a failure of Google: nothing is reported, so the controller aborts the trial without saving.
      expect(signals).toEqual([])
      expect(google.searches).toHaveLength(0)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'aborts when the search that was sent is not the question',
    async () => {
      const created = adapterWith()
      const { pending } = await typed(created)

      await page.locator(BASE_SETTINGS.selectors.input).first().pressSequentially(' and more')
      await pressEnter()

      await expect(pending).rejects.toThrow(GoogleAnswerError)
      await expect(pending).rejects.toThrow(/was "What is combinatorial testing\? and more", not the question/)
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports a home page that cannot be reached as a network error',
    async () => {
      const created = adapterWith(settingsFor({ searchUrl: await closedPortUrl() }))

      await expect(created.start(QUESTION)).rejects.toThrow(SubjectUnreachableError)

      expect(signals).toHaveLength(1)
      expect(signals[0]?.networkError).toMatch(/ERR_CONNECTION_REFUSED/)
      expect(detector.classify(signals[0] as FailureSignal)).toBe(FailureType.UNREACHABLE)
      expect(notices).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports an error status from the search as an error response, keeping the first-response stamp',
    async () => {
      google.options.searchStatus = 503
      const created = adapterWith()
      const { pending } = await typed(created)
      await pressEnter()
      const beginMs = await pending

      const firstResponseMs = await created.waitForFirstResponse()

      expect(firstResponseMs).toBeGreaterThanOrEqual(beginMs)
      expect(signals).toEqual([{ httpStatus: 503, timedOut: false }])
      expect(detector.classify(signals[0] as FailureSignal)).toBe(FailureType.ERROR_RESPONSE)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports a search that gets no response as a network error',
    async () => {
      google.options.dropSearch = true
      const created = adapterWith()
      const { pending } = await typed(created)
      await pressEnter()
      await pending

      await expect(created.waitForFirstResponse()).rejects.toThrow(/failed before the results page loaded/)

      expect(signals).toHaveLength(1)
      expect(detector.classify(signals[0] as FailureSignal)).toBe(FailureType.UNREACHABLE)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'dispose() while waiting for Enter settles start() at once',
    async () => {
      const created = adapterWith()
      const { pending } = await typed(created)

      await created.dispose()

      await expect(pending).rejects.toThrow(AdapterDisposedError)
      await expect(created.waitForFirstResponse()).rejects.toThrow(GoogleAnswerError)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'dispose() while the results load rejects the pending wait, and the adapter runs the next trial',
    async () => {
      google.options.assetDelayMs = 5_000
      const created = adapterWith()
      const { pending } = await typed(created)
      await pressEnter()
      await pending
      await created.waitForFirstResponse()
      const completion = created.waitForCompletion()
      completion.catch(() => {})

      await created.dispose()
      await expect(completion).rejects.toThrow(AdapterDisposedError)

      google.reset()
      notices = []
      const again = await loadedResults(created)
      expect(again.endMs).toBeGreaterThanOrEqual(again.beginMs)
      expect(google.searches).toHaveLength(1)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  describe('captureAnswer', () => {
    it(
      'with nothing highlighted reads the results, without the AI overview or the menus, and gives the results page as the source',
      async () => {
        const created = adapterWith()
        await loadedResults(created)

        const answer = await created.captureAnswer()

        expect(answer.text).toContain('Combinatorial testing | CSRC')
        expect(answer.text).toContain('Combinatorial testing covers all t-way combinations of input parameter values.')
        expect(answer.text).toContain('Practical Combinatorial Testing')
        expect(answer.text).toContain('Pairwise testing is the 2-way case of combinatorial testing.')
        // The AI overview: its heading, its text, and the pages it lists.
        expect(answer.text).not.toMatch(/AI Overview/i)
        expect(answer.text).not.toContain('Generated summary')
        expect(answer.text).not.toContain('A page the overview drew on')
        // Google's menus and footer.
        expect(answer.text).not.toContain('Images')
        expect(answer.text).not.toContain('Sign in')
        expect(answer.text).not.toContain('Privacy')
        expect(answer.citations).toEqual([])
        expect(answer.sourceUrl).toBe(page.url())
        expect(new URL(answer.sourceUrl ?? '').pathname).toBe('/search')
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'leaves the page as it was after reading it',
      async () => {
        const created = adapterWith()
        await loadedResults(created)
        const before = await page.evaluate(() => document.body.innerHTML)

        await created.captureAnswer()

        expect(await page.evaluate(() => document.body.innerHTML)).toBe(before)
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'saves the highlighted passage and the URL of the result it came from, not the search page',
      async () => {
        const created = adapterWith()
        await loadedResults(created)

        await highlight('#snippet-3')
        const third = await created.captureAnswer()
        expect(third.text).toBe('Pairwise testing is the 2-way case of combinatorial testing.')
        expect(third.sourceUrl).toBe('https://example.net/pairwise')

        // A link Google wrapped as /url?q=<target> gives the target.
        await highlight('#snippet-2')
        const second = await created.captureAnswer()
        expect(second.text).toBe('A guide to covering arrays and how many tests a t-way suite needs.')
        expect(second.sourceUrl).toBe('https://example.org/practical-combinatorial-testing')

        await highlight('#result-1 h3')
        const first = await created.captureAnswer()
        expect(first.text).toBe('Combinatorial testing | CSRC')
        expect(first.sourceUrl).toBe(`${google.origin}/result/one`)
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'gives a passage highlighted between results the result just before it',
      async () => {
        const created = adapterWith()
        await loadedResults(created)

        await highlight('#people-also-ask .related-question')
        const answer = await created.captureAnswer()

        expect(answer.text).toBe('What is pairwise testing?')
        expect(answer.sourceUrl).toBe(`${google.origin}/result/one`)
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'never captures a passage highlighted in the AI overview: the results are read instead',
      async () => {
        const created = adapterWith()
        await loadedResults(created)

        await highlight('#ai-text')
        const answer = await created.captureAnswer()

        expect(answer.text).not.toContain('Generated summary')
        expect(answer.text).toContain('Combinatorial testing | CSRC')
        expect(answer.sourceUrl).toBe(page.url())
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'ignores a passage highlighted outside the results, such as the menus',
      async () => {
        const created = adapterWith()
        await loadedResults(created)

        await highlight('#top-nav')
        const answer = await created.captureAnswer()

        expect(answer.text).not.toContain('Sign in')
        expect(answer.text).toContain('Combinatorial testing | CSRC')
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'cuts an AI overview that has no heading when its container is configured',
      async () => {
        google.options.results = 'ai-without-heading'
        const selectors = { ...BASE_SETTINGS.selectors, aiOverview: '#ai-overview' }
        const created = adapterWith(settingsFor({ selectors }))
        await loadedResults(created)

        const unhighlighted = await created.captureAnswer()
        expect(unhighlighted.text).not.toContain('Generated summary')
        expect(unhighlighted.text).toContain('Practical Combinatorial Testing')

        await highlight('#ai-text')
        const highlighted = await created.captureAnswer()
        expect(highlighted.text).not.toContain('Generated summary')
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'reads every result when the page has no AI overview',
      async () => {
        google.options.results = 'no-ai-overview'
        const created = adapterWith()
        await loadedResults(created)

        const answer = await created.captureAnswer()

        expect(answer.text.startsWith('Combinatorial testing | CSRC')).toBe(true)
        expect(answer.text).toContain('Pairwise testing explained')
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'leaves an empty answer empty when the page shows no results',
      async () => {
        google.options.results = 'empty'
        const created = adapterWith()
        await loadedResults(created)

        const answer = await created.captureAnswer()

        expect(answer.text).toBe('')
        expect(detector.classify({ answerText: answer.text, timedOut: false })).toBe(FailureType.EMPTY_ANSWER)
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'on a page the Tester opened from a result, saves the passage highlighted there with that page as the source',
      async () => {
        const created = adapterWith()
        await loadedResults(created)

        await page.locator('#result-1 a').click()
        await page.waitForURL('**/result/one')
        await highlight('#passage')
        const answer = await created.captureAnswer()

        expect(answer.text).toBe('Most failures are triggered by one or two parameters interacting.')
        expect(answer.sourceUrl).toBe(`${google.origin}/result/one`)

        // With nothing highlighted there, nothing is made up.
        await page.evaluate(() => window.getSelection()?.removeAllRanges())
        expect((await created.captureAnswer()).text).toBe('')
      },
      BROWSER_TEST_TIMEOUT_MS,
    )
  })

  describe("Google's unusual-traffic check", () => {
    it(
      'in place of the search page: tells the Tester in plain words, waits for them to solve it, then runs the trial with nothing timed before Enter',
      async () => {
        google.options.challenge = 'home'
        const created = adapterWith()
        let settled = false
        const pending = created.start(QUESTION)
        void pending.then(
          () => (settled = true),
          () => (settled = true),
        )

        await expect.poll(() => notices.length, { timeout: 10_000 }).toBe(1)
        expect(notices).toEqual([{ status: 'awaiting_submit', message: GOOGLE_CHALLENGE_PROMPT }])
        expect(GOOGLE_CHALLENGE_PROMPT).toMatch(/unusual traffic/)
        expect(GOOGLE_CHALLENGE_PROMPT).toMatch(/Solve it yourself in the Google window, or cancel/)

        // The harness waits and touches nothing on the check.
        await page.waitForTimeout(400)
        expect(settled).toBe(false)
        expect(google.challengesSolved).toBe(0)
        expect(new URL(page.url()).pathname).toBe('/sorry/index')

        // The Tester solves it by hand; Google sends the page on to the search page.
        await page.locator('#solve').click()
        await expect.poll(() => notices.length, { timeout: 10_000 }).toBe(2)
        expect(notices[1]).toEqual({ status: 'awaiting_submit', message: GOOGLE_SUBMIT_PROMPT })
        expect(await page.locator(BASE_SETTINGS.selectors.input).first().inputValue()).toBe(QUESTION.text)
        expect(google.challengesSolved).toBe(1)
        expect(settled).toBe(false)

        const enterAt = await pressEnter()
        const beginMs = await pending
        expect(beginMs).toBeGreaterThanOrEqual(enterAt)
        await created.waitForFirstResponse()
        await created.waitForCompletion()
        expect((await created.captureAnswer()).text).toContain('Combinatorial testing | CSRC')
        expect(signals).toEqual([])
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'in place of the search page and never solved: the trial is aborted, nothing is reported, and the check is left alone',
      async () => {
        google.options.challenge = 'home'
        const created = adapterWith(settingsFor(), { submitWaitMs: 500 })
        const pending = created.start(QUESTION)
        pending.catch(() => {})

        await expect(pending).rejects.toThrow(GoogleChallengeError)
        await expect(pending).rejects.toThrow(/still showing after 0\.5 s.*nothing was saved/)

        expect(notices).toEqual([{ status: 'awaiting_submit', message: GOOGLE_CHALLENGE_PROMPT }])
        expect(signals).toEqual([])
        expect(google.challengesSolved).toBe(0)
        expect(google.searches).toHaveLength(0)
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'in place of the results: the trial ends unsaved with the message to solve it and run again, and no failure is reported',
      async () => {
        const created = adapterWith()
        const { pending } = await typed(created)
        google.options.challenge = 'search'
        await pressEnter()
        const beginMs = await pending
        const firstResponseMs = await created.waitForFirstResponse()
        expect(firstResponseMs).toBeGreaterThanOrEqual(beginMs)

        const completion = created.waitForCompletion()
        await expect(completion).rejects.toThrow(GoogleChallengeError)
        await expect(completion).rejects.toThrow(GOOGLE_CHALLENGE_AFTER_SUBMIT)
        expect(GOOGLE_CHALLENGE_AFTER_SUBMIT).toMatch(/this trial was not saved.*run the trial again/)

        // Not ERROR_RESPONSE for the 429, not anything else: the controller aborts the trial without saving it.
        expect(signals).toEqual([])
        expect(google.challengesSolved).toBe(0)
        expect(new URL(page.url()).pathname).toBe('/sorry/index')
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'treats HTTP 429 from the search itself the same way',
      async () => {
        google.options.searchStatus = 429
        const created = adapterWith()
        const { pending } = await typed(created)
        await pressEnter()
        await pending
        await created.waitForFirstResponse()

        await expect(created.waitForCompletion()).rejects.toThrow(GoogleChallengeError)
        expect(signals).toEqual([])
      },
      BROWSER_TEST_TIMEOUT_MS,
    )

    it(
      'runs the next trial once the Tester has solved a check that ended the last one',
      async () => {
        const created = adapterWith()
        const first = await typed(created)
        google.options.challenge = 'search'
        await pressEnter()
        await first.pending
        await expect(created.waitForCompletion()).rejects.toThrow(GoogleChallengeError)
        await created.dispose()

        // The Tester solves it in the window, with no trial running, then starts the trial again.
        await page.locator('#solve').click()
        await page.waitForURL('**/search?**')
        google.searches.length = 0
        notices = []

        const again = await loadedResults(created)
        expect(again.endMs).toBeGreaterThanOrEqual(again.beginMs)
        expect(google.searches.map((search) => search.query)).toEqual([QUESTION.text])
        expect(notices).toEqual([{ status: 'awaiting_submit', message: GOOGLE_SUBMIT_PROMPT }])
      },
      BROWSER_TEST_TIMEOUT_MS,
    )
  })

  it(
    'refuses to wait for results before the Tester has pressed Enter',
    async () => {
      const created = adapterWith()

      await expect(created.waitForFirstResponse()).rejects.toThrow(GoogleAnswerError)
      await expect(created.waitForCompletion()).rejects.toThrow(GoogleAnswerError)
      await expect(created.captureAnswer()).rejects.toThrow(GoogleAnswerError)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )
})

/** A URL on this machine that nothing listens on: a port a server just gave back. */
async function closedPortUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}/`
}
