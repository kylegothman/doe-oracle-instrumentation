import type { Page } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSettings } from '../config/settings'
import { MetricsRepository } from '../data/metrics-repository'
import { SessionManager } from './session-manager'
import { TimingService } from './timing-service'
import { TrialController, type TrialAdapter } from './trial-controller'

const QUESTION = { number: 1, text: 'What is combinatorial testing?' }

/** An adapter that answers on a script: fixed timestamps and a fixed answer. */
function scriptedAdapter(script: { begin: number; first: number; end: number; text?: string }) {
  const calls: string[] = []
  const adapter: TrialAdapter = {
    open: vi.fn(async () => {
      calls.push('open')
    }),
    start: vi.fn(async (question: string) => {
      calls.push(`start:${question}`)
      return script.begin
    }),
    waitForFirstResponse: vi.fn(async () => {
      calls.push('first')
      return script.first
    }),
    waitForCompletion: vi.fn(async () => {
      calls.push('end')
      return script.end
    }),
    captureAnswer: vi.fn(async () => {
      calls.push('capture')
      return { text: script.text ?? 'An answer.', citations: ['a.pdf · p.1'], sourceUrl: 'http://oracle.test/chat' }
    }),
  }
  return { adapter, calls }
}

describe('TrialController', () => {
  let repository: MetricsRepository
  const page = {} as Page
  const browser = { getPage: vi.fn(async () => page) }

  beforeEach(async () => {
    repository = await MetricsRepository.open(':memory:')
    browser.getPage.mockClear()
  })

  afterEach(() => {
    repository.close()
  })

  function controllerWith(adapter: TrialAdapter) {
    return new TrialController({
      settings: loadSettings({}),
      browser,
      timing: new TimingService(),
      repository,
      session: new SessionManager({ sessionId: 'session-1' }),
      createAdapter: () => adapter,
      findQuestion: () => QUESTION,
    })
  }

  it('runs the trial in order, times it, and saves the record', async () => {
    const begin = Date.UTC(2026, 10, 11, 2, 53, 28, 530)
    const { adapter, calls } = scriptedAdapter({ begin, first: begin + 300, end: begin + 900 })
    const controller = controllerWith(adapter)

    const saved = await controller.runTrial('oracle', 1)

    expect(calls).toEqual(['open', 'start:What is combinatorial testing?', 'first', 'end', 'capture'])
    expect(browser.getPage).toHaveBeenCalledWith('oracle')
    expect(saved).toMatchObject({
      testNumber: 1,
      sessionId: 'session-1',
      dataSetName: `DOE_ORACLE-${localDate(new Date(begin))}`,
      subject: 'oracle',
      questionNumber: 1,
      status: 'completed',
      beginTs: '2026-11-11T02:53:28.530Z',
      firstResponseTs: '2026-11-11T02:53:28.830Z',
      endTs: '2026-11-11T02:53:29.430Z',
      responseMs: 900,
      firstResponseMs: 300,
      answerText: 'An answer.',
      citations: ['a.pdf · p.1'],
    })
    expect(saved.trialId).toMatch(/^[0-9a-f-]{36}$/)
    expect(repository.listTrials()).toEqual([saved])
    expect(controller.isRunning).toBe(false)
  })

  it('gives each trial the next test number and the same session', async () => {
    const { adapter } = scriptedAdapter({ begin: 1_000, first: 1_100, end: 1_500 })
    const controller = controllerWith(adapter)

    const first = await controller.runTrial('oracle', 1)
    const second = await controller.runTrial('oracle', 1)

    expect([first.testNumber, second.testNumber]).toEqual([1, 2])
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.trialId).not.toBe(first.trialId)
  })

  it('refuses a second trial while one is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { adapter } = scriptedAdapter({ begin: 1_000, first: 1_100, end: 1_500 })
    adapter.waitForCompletion = vi.fn(async () => {
      await gate
      return 1_500
    })
    const controller = controllerWith(adapter)

    const running = controller.runTrial('oracle', 1)
    await expect(controller.runTrial('oracle', 1)).rejects.toThrow(/already running/)
    release()
    await expect(running).resolves.toMatchObject({ testNumber: 1 })
  })

  it('saves nothing and clears its marks when the adapter fails', async () => {
    const { adapter } = scriptedAdapter({ begin: 1_000, first: 1_100, end: 1_500 })
    adapter.waitForCompletion = vi.fn(async () => {
      throw new Error('The Oracle reported an error: Error searching')
    })
    const timing = new TimingService()
    const controller = new TrialController({
      settings: loadSettings({}),
      browser,
      timing,
      repository,
      session: new SessionManager({ sessionId: 's' }),
      createAdapter: () => adapter,
      findQuestion: () => QUESTION,
    })

    await expect(controller.runTrial('oracle', 1)).rejects.toThrow(/Oracle reported an error/)

    expect(repository.listTrials()).toEqual([])
    expect(controller.isRunning).toBe(false)
  })

  it('rejects a question that is not configured before touching the browser', async () => {
    const { adapter } = scriptedAdapter({ begin: 1, first: 2, end: 3 })
    const controller = new TrialController({
      settings: loadSettings({}),
      browser,
      timing: new TimingService(),
      repository,
      session: new SessionManager(),
      createAdapter: () => adapter,
    })

    await expect(controller.runTrial('oracle', 99)).rejects.toThrow(/Question 99 is not in the harness config/)
    expect(browser.getPage).not.toHaveBeenCalled()
  })
})

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
