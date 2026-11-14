import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FailureType, type FailureSignal } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import { Subject } from '../../shared/subjects'
import { SubjectUnreachableError } from '../browser/navigation'
import { loadSettings, type CopilotSettings } from '../config/settings'
import { FailureDetector } from '../execution/failure-detector'
import { startFakeChatHub, type FakeChatHub } from './__fixtures__/fake-chathub'
import {
  COPILOT_SUBMIT_PROMPT,
  CopilotAdapter,
  CopilotAnswerError,
  CopilotSubmitTimeoutError,
  stripZeroWidth,
  type CopilotAdapterOptions,
} from './copilot-adapter'
import { CopilotSignedOutError } from './copilot-session'
import { AdapterDisposedError, type AdapterNotice } from './subject-adapter'

const FIXTURE_HTML = readFileSync(fileURLToPath(new URL('./__fixtures__/copilot-chat.html', import.meta.url)), 'utf8')
const QUESTION: Question = { number: 1, text: 'What is combinatorial testing?' }
const BASE_SETTINGS = loadSettings({}).copilot
const detector = new FailureDetector()
const BROWSER_TEST_TIMEOUT_MS = 30_000
const SIGN_IN_HTML = '<!doctype html><title>Microsoft Copilot | Sign in</title><main><h1>Sign into Copilot</h1><button>Sign in</button></main>'
const OFFLINE_HTML = '<!doctype html><title>Copilot</title><main><img alt="No network connection" src="data:," /><p>No internet connection.</p></main>'

/** The fixture's query parameters; see the comment at the top of copilot-chat.html. */
type FixtureParams = Record<string, string | number>

describe('CopilotAdapter against the chat fixture', () => {
  let browser: Browser
  let page: Page
  let signals: FailureSignal[]
  let notices: AdapterNotice[]
  let hub: FakeChatHub

  beforeAll(async () => {
    browser = await chromium.launch()
  }, BROWSER_TEST_TIMEOUT_MS)

  afterAll(async () => {
    await browser?.close()
  })

  beforeEach(async () => {
    page = await browser.newPage()
    signals = []
    notices = []
    hub = await startFakeChatHub({ html: FIXTURE_HTML })
  })

  afterEach(async () => {
    await page.close()
    await hub.close()
  })

  /** Serves another page, or a refused connection, at the chat URL instead of the fixture. */
  async function serve(options: { html?: string; chatDown?: boolean }): Promise<void> {
    await page.route(`${hub.chatUrl}**`, async (route) => {
      if (options.chatDown) {
        await route.abort('connectionrefused')
        return
      }
      await route.fulfill({ status: 200, contentType: 'text/html', body: options.html ?? FIXTURE_HTML })
    })
  }

  /** Settings pointing the adapter at the fixture with the given parameters. `socket: 1` makes the page open the ChatHub socket. */
  function settingsFor(params: FixtureParams = {}): CopilotSettings {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (key === 'socket') query.set('hub', hub.url)
      else query.set(key, String(value))
    }
    return { ...BASE_SETTINGS, chatUrl: `${hub.chatUrl}?${query.toString()}` }
  }

  function chatUrlPattern(): string {
    return hub.chatUrl.replace(/[.]/g, '\\.')
  }

  /** An adapter on the test page that records every failure signal and notice. */
  function adapterWith(params: FixtureParams = {}, options: CopilotAdapterOptions = {}): CopilotAdapter {
    const adapter = new CopilotAdapter({ getPage: async () => page }, settingsFor(params), { submitConfirmMs: 500, ...options })
    adapter.onFailure((signal) => signals.push(signal))
    adapter.onNotice((notice) => notices.push(notice))
    return adapter
  }

  /** Waits until the adapter has typed the question and asked for Enter. */
  async function typed(): Promise<void> {
    await expect.poll(() => notices.length, { timeout: 10_000 }).toBe(1)
  }

  /** The Tester pressing Enter in the editor. The adapter itself never does this. */
  async function pressEnter(): Promise<number> {
    const at = Date.now()
    await page.locator(BASE_SETTINGS.selectors.input).press('Enter')
    return at
  }

  function editorText(): Promise<string> {
    return page.locator(BASE_SETTINGS.selectors.input).innerText()
  }

  it(
    'types the exact question without sending it, resolves start() only after the Tester presses Enter, and stamps begin when the editor cleared',
    async () => {
      const fake = hub
      const adapter = adapterWith({ firstMs: 300, socket: 1 })

      let settled = false
      const pending = adapter.start(QUESTION)
      pending.then(() => (settled = true)).catch(() => (settled = true))
      await typed()

      expect(notices).toEqual([{ status: 'awaiting_submit', message: COPILOT_SUBMIT_PROMPT }])
      // The editor appends zero-width characters after the text, as Copilot's does; the adapter strips them.
      const typedText = await editorText()
      expect(typedText).toMatch(/[\u200B\u200C]/)
      expect(stripZeroWidth(typedText)).toBe(QUESTION.text)
      expect(await page.locator('button[aria-label="Send"]').count()).toBe(1)
      await page.waitForTimeout(400)
      expect(settled).toBe(false)
      expect(fake.received).toEqual([])

      const enterAt = await pressEnter()
      const beginMs = await pending
      const firstResponseMs = await adapter.waitForFirstResponse()

      expect(adapter.subject).toBe(Subject.COPILOT)
      // begin is the editor clearing: after Enter, and no later than the request frame reached the hub
      // (the page confirms the send before the socket has even opened, so the frame may still be in flight).
      expect(beginMs).toBeGreaterThanOrEqual(enterAt)
      await expect.poll(() => fake.requestsAt.length, { timeout: 5_000 }).toBe(1)
      expect(beginMs).toBeLessThanOrEqual(fake.requestsAt[0]!)
      expect(fake.received.some((frame) => frame.includes('"source":"officeweb"') && frame.includes(QUESTION.text))).toBe(true)
      // first response is the first text of the answer, which the fixture shows 300 ms after the send.
      expect(firstResponseMs - beginMs).toBeGreaterThanOrEqual(250)
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'confirms the send from the page alone when no ChatHub socket is opened',
    async () => {
      const adapter = adapterWith({ firstMs: 100 })

      const pending = adapter.start(QUESTION)
      await typed()
      const enterAt = await pressEnter()
      const beginMs = await pending

      expect(beginMs).toBeGreaterThanOrEqual(enterAt)
      expect(await adapter.waitForFirstResponse()).toBeGreaterThan(beginMs)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'aborts when the question is changed before it is sent',
    async () => {
      const adapter = adapterWith()

      const pending = adapter.start(QUESTION)
      await typed()
      await page.locator(BASE_SETTINGS.selectors.input).press('End')
      await page.keyboard.type(' please')

      await expect(pending).rejects.toThrow(CopilotAnswerError)
      // The first typed character is enough: the watcher catches the edit as it happens.
      await expect(pending).rejects.toThrow(/changed before it was sent \(it now reads "What is combinatorial testing\? p/)
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'aborts when the editor is cleared and no send follows, as when the Tester deletes the text',
    async () => {
      const adapter = adapterWith({ deleteOnly: 1 })

      const pending = adapter.start(QUESTION)
      await typed()
      await pressEnter()

      await expect(pending).rejects.toThrow(/removed from the Copilot input without being sent/)
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'gives up with a clear error when the Tester never presses Enter within the submit wait',
    async () => {
      const adapter = adapterWith({}, { submitWaitMs: 600 })

      const pending = adapter.start(QUESTION)
      await typed()

      await expect(pending).rejects.toThrow(CopilotSubmitTimeoutError)
      await expect(pending).rejects.toThrow(/not sent within 0\.6 s: no Enter in the Copilot window/)
      expect(signals).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'aborts as signed out, without a failure signal, when the chat page is the sign-in page',
    async () => {
      await serve({ html: SIGN_IN_HTML })
      const adapter = adapterWith({}, { pageOpenTimeoutMs: 1_000 })

      await expect(adapter.start(QUESTION)).rejects.toThrow(CopilotSignedOutError)
      await expect(adapter.start(QUESTION)).rejects.toThrow(new RegExp(`not signed in \\(the browser is at ${chatUrlPattern()}\\)`))
      expect(signals).toEqual([])
      expect(notices).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reports the chat page being unreachable, and the offline screen, as network failures from start()',
    async () => {
      await serve({ chatDown: true })
      const adapter = adapterWith({}, { pageOpenTimeoutMs: 1_000 })

      await expect(adapter.start(QUESTION)).rejects.toThrow(SubjectUnreachableError)
      expect(signals).toHaveLength(1)
      expect(signals[0]?.networkError).toMatch(new RegExp(`Could not reach the Microsoft Copilot at ${chatUrlPattern()}.*ERR_CONNECTION_REFUSED`))
      expect(detector.classify(signals[0]!)).toBe(FailureType.UNREACHABLE)

      await page.unroute(`${hub.chatUrl}**`)
      await serve({ html: OFFLINE_HTML })
      signals.length = 0
      await expect(adapter.start(QUESTION)).rejects.toThrow(/Copilot shows "No internet connection"/)
      expect(signals).toHaveLength(1)
      expect(detector.classify(signals[0]!)).toBe(FailureType.UNREACHABLE)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'explains when the page at the chat URL is not the Copilot chat',
    async () => {
      await serve({ html: '<!doctype html><title>Something else</title><p>Not Copilot</p>' })
      const adapter = adapterWith({}, { pageOpenTimeoutMs: 800 })

      await expect(adapter.start(QUESTION)).rejects.toThrow(/does not look like the Copilot chat: its question input did not appear within 0\.8 s/)
      expect(signals[0]?.networkError).toMatch(/does not look like the Copilot chat/)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'dispose() while waiting for Enter settles start() at once and leaves the adapter ready for another trial',
    async () => {
      const adapter = adapterWith()
      const pending = adapter.start(QUESTION)
      pending.catch(() => {})
      await typed()

      const disposedAt = Date.now()
      await adapter.dispose()
      await expect(pending).rejects.toThrow(AdapterDisposedError)
      expect(Date.now() - disposedAt).toBeLessThan(1_500)

      await adapter.dispose()
      await expect(adapter.waitForFirstResponse()).rejects.toThrow(/start\(question\) must be called/)
      const again = adapter.start(QUESTION)
      await expect.poll(() => notices.length, { timeout: 10_000 }).toBe(2)
      await pressEnter()
      await expect(again).resolves.toBeGreaterThan(0)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it('refuses to wait before the Tester has sent a question', async () => {
    const adapter = adapterWith()

    await expect(adapter.waitForFirstResponse()).rejects.toThrow(/start\(question\) must be called/)
  })
})
