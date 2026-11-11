import type { Locator, Page } from 'playwright'
import { openSubjectPage } from '../browser/navigation'
import type { OracleSettings } from '../config/settings'

export interface CapturedAnswer {
  /** The answer as shown: the bubble's full text minus citation lines and buttons. */
  text: string
  /** Citation lines as shown, for example "paper.pdf · p.3". */
  citations: string[]
  /** Where the answer was read from: the chat page URL. */
  sourceUrl?: string
}

/**
 * Where things are on the Oracle chat page (doe-frontend/src/pages/Chat.tsx).
 * The page has no ids or test hooks, so these anchor on attributes that are
 * part of its behaviour: the input's placeholder and the per-answer "Copy"
 * button. An answer bubble is the element whose button row holds that button.
 * The Send button is icon-only with no accessible name; pressing Enter in the
 * input runs the same handler, so the adapter submits with Enter.
 */
export const ORACLE_SELECTORS = {
  input: 'input[placeholder="Ask DOE anything..."]',
  answerBubble: 'div:has(> div > button[title="Copy"])',
  bubbleButtonRow: 'div:has(> button[title="Copy"])',
  citationLine: 'p.text-xs',
  systemMessage: 'div.italic.text-center',
} as const

/** Thrown when the Oracle reports an error or no answer appears in time. */
export class OracleAnswerError extends Error {
  override readonly name = 'OracleAnswerError'
}

export interface OracleAdapterOptions {
  /**
   * How long to wait for the answer before giving up.
   * TODO(#27): the 60-second rule and its failure handling belong to the TrialController in E2.
   */
  answerTimeoutMs?: number
}

const DEFAULT_ANSWER_TIMEOUT_MS = 90_000

/** Shape of the values the in-page watchers return. */
type PageWatchResult = { at: number } | { error: string }

/**
 * Drives the DOE Oracle's chat page: types the question, submits it, waits for
 * the answer, and reads it back. One adapter serves one trial.
 *
 * Timing in this version comes from the page's own clock when the answer
 * bubble appears and when its text is in place. The timing story (#23)
 * moves begin and first response to the browser's network events.
 */
export class OracleAdapter {
  private readonly answerTimeoutMs: number
  private bubblesBefore = 0
  private systemMessagesBefore = 0
  private submitted = false

  constructor(
    private readonly page: Page,
    private readonly settings: OracleSettings,
    options: OracleAdapterOptions = {},
  ) {
    this.answerTimeoutMs = options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS
  }

  /** The chat page URL built from the settings. */
  get chatUrl(): string {
    return new URL(this.settings.chatPath, this.settings.baseUrl).toString()
  }

  /** Opens the chat page and waits until the question input is usable. */
  async open(): Promise<void> {
    await openSubjectPage(this.page, 'oracle', this.chatUrl)
    await this.input().waitFor({ state: 'visible', timeout: 15_000 })
  }

  /** Types the exact question and submits it. Resolves with the begin timestamp (epoch ms). */
  async start(question: string): Promise<number> {
    const input = this.input()
    await input.waitFor({ state: 'visible', timeout: 15_000 })
    this.bubblesBefore = await this.page.locator(ORACLE_SELECTORS.answerBubble).count()
    this.systemMessagesBefore = await this.page.locator(ORACLE_SELECTORS.systemMessage).count()

    await input.fill(question)
    const typed = await input.inputValue()
    if (typed !== question) {
      throw new OracleAnswerError(`The Oracle input holds "${typed}" instead of the question`)
    }

    const beginMs = Date.now()
    await input.press('Enter')
    this.submitted = true
    return beginMs
  }

  /** Resolves when a new answer bubble is on the page, with the page's timestamp. */
  async waitForFirstResponse(): Promise<number> {
    this.assertSubmitted()
    return this.watchPage((args) => {
      const errorText = window.__harnessNewSystemError?.(args)
      if (errorText) return { error: errorText }
      const bubbles = document.querySelectorAll(args.answerBubble)
      return bubbles.length > args.bubblesBefore ? { at: Date.now() } : false
    })
  }

  /** Resolves when the new bubble has its answer text, with the page's timestamp. */
  async waitForCompletion(): Promise<number> {
    this.assertSubmitted()
    return this.watchPage((args) => {
      const errorText = window.__harnessNewSystemError?.(args)
      if (errorText) return { error: errorText }
      const bubbles = document.querySelectorAll(args.answerBubble)
      if (bubbles.length <= args.bubblesBefore) return false
      const bubble = bubbles[bubbles.length - 1]
      const text = (bubble?.textContent ?? '').trim()
      return text.length > 0 ? { at: Date.now() } : false
    })
  }

  /** Reads the newest answer bubble: its text without citations and buttons, plus the citation lines. */
  async captureAnswer(): Promise<CapturedAnswer> {
    this.assertSubmitted()
    const bubble = this.page.locator(ORACLE_SELECTORS.answerBubble).last()
    const captured = await bubble.evaluate(
      (node, selectors) => {
        const parts: string[] = []
        for (const child of Array.from(node.children)) {
          if (child.matches(selectors.bubbleButtonRow) || child.matches(selectors.citationLine)) continue
          const clone = child.cloneNode(true) as Element
          clone.querySelectorAll(selectors.citationLine).forEach((line) => line.remove())
          const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (text) parts.push(text)
        }
        const citations = Array.from(node.querySelectorAll(selectors.citationLine))
          .map((line) => (line.textContent ?? '').replace(/^\s*📄\s*/u, '').replace(/\s+/g, ' ').trim())
          .filter((line) => line.length > 0)
        return { text: parts.join('\n'), citations }
      },
      { bubbleButtonRow: ORACLE_SELECTORS.bubbleButtonRow, citationLine: ORACLE_SELECTORS.citationLine },
    )
    return { ...captured, sourceUrl: this.page.url() }
  }

  private input(): Locator {
    return this.page.locator(ORACLE_SELECTORS.input)
  }

  private assertSubmitted(): void {
    if (!this.submitted) {
      throw new OracleAnswerError('start(question) must be called before waiting for the answer')
    }
  }

  /**
   * Polls a watcher inside the page once per animation frame until it returns
   * a value. The watcher runs in the page, so its timestamps come from the
   * page's clock at the moment the condition first held.
   */
  private async watchPage(watcher: (args: PageWatchArgs) => PageWatchResult | false): Promise<number> {
    await this.installSystemErrorWatcher()
    const args: PageWatchArgs = {
      answerBubble: ORACLE_SELECTORS.answerBubble,
      systemMessage: ORACLE_SELECTORS.systemMessage,
      bubblesBefore: this.bubblesBefore,
      systemMessagesBefore: this.systemMessagesBefore,
    }
    let handle
    try {
      handle = await this.page.waitForFunction(watcher, args, { polling: 'raf', timeout: this.answerTimeoutMs })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/Timeout \d+ms exceeded/i.test(message)) {
        throw new OracleAnswerError(`No answer appeared within ${Math.round(this.answerTimeoutMs / 1000)} s`)
      }
      throw error
    }
    const result = (await handle.jsonValue()) as PageWatchResult
    if ('error' in result) {
      // TODO(#28): the Failure Detector classifies this and the other failure types in E2.
      throw new OracleAnswerError(`The Oracle reported an error: ${result.error}`)
    }
    return result.at
  }

  /** Defines, once per page, the helper that spots a new system error message. */
  private async installSystemErrorWatcher(): Promise<void> {
    await this.page.evaluate(() => {
      if (window.__harnessNewSystemError) return
      window.__harnessNewSystemError = (args) => {
        const messages = document.querySelectorAll(args.systemMessage)
        if (messages.length <= args.systemMessagesBefore) return null
        const text = (messages[messages.length - 1]?.textContent ?? '').trim()
        return /error/i.test(text) ? text : null
      }
    })
  }
}

interface PageWatchArgs {
  answerBubble: string
  systemMessage: string
  bubblesBefore: number
  systemMessagesBefore: number
}

declare global {
  interface Window {
    /** Installed by the adapter inside the Oracle page; see installSystemErrorWatcher. */
    __harnessNewSystemError?: (args: PageWatchArgs) => string | null
  }
}
