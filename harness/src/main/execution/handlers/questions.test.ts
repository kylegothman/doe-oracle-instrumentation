import { describe, expect, it } from 'vitest'
import { Subject } from '../../../shared/subjects'
import type { TrialPolicy } from '../../config/settings'
import { createGetTrialLimitsHandler, createListQuestionsHandler } from './questions'

describe('questions:list handler', () => {
  it('lists the questions once the bank is loaded', async () => {
    const questions = [
      { number: 1, text: 'What is combinatorial testing?' },
      { number: 2, text: 'What makes combinatorial testing cost effective?' },
    ]
    const handler = createListQuestionsHandler(async () => ({ list: () => questions }))

    await expect(handler()).resolves.toEqual(questions)
  })

  it('passes a questions file that could not be loaded through as the error', async () => {
    const handler = createListQuestionsHandler(async () => {
      throw new Error('The questions config at config/questions.json is not valid JSON')
    })

    await expect(handler()).rejects.toThrow(/questions.json is not valid JSON/)
  })
})

describe('trials:limits handler', () => {
  it("gives each subject's limit, when its clock starts, and what the Tester does at the end", async () => {
    const policies: Record<Subject, TrialPolicy> = {
      [Subject.DOE_ORACLE]: { timeoutMs: 60_000, startsAt: 'trial_start', confirmEnd: false },
      [Subject.COPILOT]: { timeoutMs: 60_000, startsAt: 'submit', confirmEnd: true },
      [Subject.GOOGLE]: { timeoutMs: 45_000, startsAt: 'submit', confirmEnd: false, answerFound: true, answerLimitMs: 120_000 },
    }

    await expect(createGetTrialLimitsHandler(policies)()).resolves.toEqual({
      [Subject.DOE_ORACLE]: { timeoutMs: 60_000, startsAt: 'trial_start', confirmEnd: false, answerFound: false, answerLimitMs: null },
      [Subject.COPILOT]: { timeoutMs: 60_000, startsAt: 'submit', confirmEnd: true, answerFound: false, answerLimitMs: null },
      [Subject.GOOGLE]: { timeoutMs: 45_000, startsAt: 'submit', confirmEnd: false, answerFound: true, answerLimitMs: 120_000 },
    })
  })
})
