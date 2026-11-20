import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Subject } from '../../shared/subjects'
import { TrialStatus, type TrialEvent } from '../../shared/trials'
import { startFakeGoogle, type FakeGoogle } from '../adapters/__fixtures__/fake-google'
import { GoogleAdapter } from '../adapters/google-adapter'
import type { SubjectAdapter } from '../adapters/subject-adapter'
import { loadSettings } from '../config/settings'
import { MetricsRepository } from '../data/metrics-repository'
import { QuestionBank } from './question-bank'
import { SessionManager } from './session-manager'
import { TimingService } from './timing-service'
import { TrialController } from './trial-controller'

const SETTINGS = loadSettings({})
const BROWSER_TEST_TIMEOUT_MS = 30_000
const COPIED = 'IPOG extends a covering array one parameter at a time.'

/**
 * The copy step from end to end in the main process: the real Trial
 * Controller and Google adapter against the saved Google pages, with a
 * clipboard the test fills. The tests press Enter themselves, standing in
 * for the Tester; nothing here contacts Google.
 */
describe('a Google trial whose highlight cannot be read', () => {
  let browser: Browser
  let google: FakeGoogle
  let context: BrowserContext
  let page: Page
  let repository: MetricsRepository
  let events: TrialEvent[]
  let clipboard: { text: string; readText: () => Promise<string> }
  let controller: TrialController

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
    context = await browser.newContext()
    page = await context.newPage()
    repository = await MetricsRepository.open(':memory:')
    events = []
    clipboard = { text: '', readText: async () => clipboard.text }
    const session = new SessionManager({ store: repository, appVersion: '0.2.0', sessionId: () => 'session-1' })
    session.startSession()
    const adapter = new GoogleAdapter({ getPage: async () => page }, { ...SETTINGS.google, searchUrl: `${google.origin}/` })
    controller = new TrialController({
      adapters: new Map<Subject, SubjectAdapter>([[Subject.GOOGLE, adapter]]),
      questions: new QuestionBank([{ number: 1, text: 'Define the IPOG algorithm.' }]),
      timing: new TimingService(),
      repository,
      session,
      policies: SETTINGS.trialPolicies,
      events: { sendTrialEvent: (event) => events.push(event) },
      clipboard,
    })
  })

  afterEach(async () => {
    if (controller?.runningTrialId) await controller.cancelTrial(controller.runningTrialId).catch(() => {})
    await context.close()
    repository.close()
  })

  const reached = (status: TrialEvent['status']) => expect.poll(() => events.some((event) => event.status === status), { timeout: 10_000 }).toBe(true)

  /** Runs the trial until the results have loaded and the Tester is asked for the answer. */
  async function resultsLoaded(): Promise<{ pending: Promise<unknown>; trialId: string }> {
    const pending = controller.startTrial(Subject.GOOGLE, 1)
    pending.catch(() => {})
    await reached('awaiting_submit')
    await page.locator(SETTINGS.google.selectors.input).first().press('Enter')
    await reached('awaiting_confirmation')
    return { pending, trialId: controller.runningTrialId! }
  }

  it(
    'asks for the copied text when the answer is in a result opened in the same tab, then saves it with the Answer Found time and that page',
    async () => {
      const { pending, trialId } = await resultsLoaded()
      // The Tester opens a result whose highlight the harness cannot read, as with a PDF, and clicks Answer Found.
      await page.locator('#result-1 a').click()
      await page.waitForURL('**/result/one')
      const clickedAt = Date.now()
      await controller.confirmCompletion(trialId)

      const step = events.at(-1)!
      expect(step).toMatchObject({ status: 'awaiting_copied_text', sourceUrl: `${google.origin}/result/one` })
      expect(step.answerFoundMs).toBeGreaterThanOrEqual(clickedAt)
      expect(repository.listTrials()).toEqual([])

      // Nothing copied yet: the Tester stays on the step.
      expect(await controller.readCopiedText(trialId)).toBe('')
      // They copy the text, a while later, and confirm what they are shown.
      await page.waitForTimeout(300)
      clipboard.text = `${COPIED}\r\n`
      expect(await controller.readCopiedText(trialId)).toBe(COPIED)
      await controller.confirmCompletion(trialId)
      const saved = await pending

      expect(saved).toMatchObject({
        subject: Subject.GOOGLE,
        questionNumber: 1,
        status: TrialStatus.SUCCESS,
        answerText: COPIED,
        sourceUrl: `${google.origin}/result/one`,
        // The time to answer is the Answer Found click, not the confirm 300 ms later.
        timeToAnswerMs: step.answerFoundMs! - step.beginMs!,
      })
      expect(repository.listTrials()).toEqual([saved])
      expect(events.at(-1)?.status).toBe('completed')
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'asks for the copied text when the result was opened in a new tab, where the whole results page used to be saved',
    async () => {
      const { pending, trialId } = await resultsLoaded()
      const tab = await context.newPage()
      await tab.goto(`${google.origin}/result/one`)
      await controller.confirmCompletion(trialId)

      expect(events.at(-1)).toMatchObject({ status: 'awaiting_copied_text', sourceUrl: `${google.origin}/result/one` })
      clipboard.text = COPIED
      await controller.readCopiedText(trialId)
      await controller.confirmCompletion(trialId)

      await expect(pending).resolves.toMatchObject({ status: TrialStatus.SUCCESS, answerText: COPIED, sourceUrl: `${google.origin}/result/one` })
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'saves a passage highlighted on the results page at once, with no copy step',
    async () => {
      const { pending, trialId } = await resultsLoaded()
      await page.evaluate(() => {
        const range = document.createRange()
        range.selectNodeContents(document.querySelector('#snippet-3')!)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
      })
      clipboard.text = 'Never read.'
      await controller.confirmCompletion(trialId)

      await expect(pending).resolves.toMatchObject({
        status: TrialStatus.SUCCESS,
        answerText: 'Pairwise testing is the 2-way case of combinatorial testing.',
        sourceUrl: 'https://example.net/pairwise',
      })
      expect(events.map((event) => event.status)).not.toContain('awaiting_copied_text')
    },
    BROWSER_TEST_TIMEOUT_MS,
  )
})
