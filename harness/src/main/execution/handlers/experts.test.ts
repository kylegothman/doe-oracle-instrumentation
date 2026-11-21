import { describe, expect, it, vi } from 'vitest'
import type { ExpertAnswerInput, ExpertInput, SaveExpertAnswerResult, SaveExpertResult } from '../../../shared/expert-entry'
import { ResponseSource, type Expert, type ExpertResponse } from '../../../shared/experts'
import {
  createListExpertAnswersHandler,
  createListExpertsHandler,
  createSaveExpertAnswerHandler,
  createSaveExpertHandler,
} from './experts'

const expert: Expert = {
  expertId: 'expert-1',
  name: 'Dr. Wong',
  source: ResponseSource.EMAIL,
  outreachTs: '2026-10-06T14:00:00.000Z',
  firstAnswerTs: null,
  turnaroundMs: null,
}
const answer = { responseId: 1, expertId: 'expert-1', questionNumber: 1, answerText: 'An answer.' } as ExpertResponse

const expertInput: ExpertInput = { expertId: null, name: 'Dr. Wong', source: ResponseSource.EMAIL, outreachTs: '2026-10-06T14:00:00.000Z', firstAnswerTs: null }
const answerInput: ExpertAnswerInput = { expertId: 'expert-1', questionNumber: 1, answerText: 'An answer.', replace: false }

describe('experts:list handler', () => {
  it('lists the experts through the service once it is ready', async () => {
    const handler = createListExpertsHandler(async () => ({ listExperts: () => [expert] }))

    await expect(handler()).resolves.toEqual([expert])
  })

  it('passes a failed database open through as the error', async () => {
    const handler = createListExpertsHandler(async () => {
      throw new Error('Could not open harness.db')
    })

    await expect(handler()).rejects.toThrow(/Could not open harness.db/)
  })
})

describe('expert:save handler', () => {
  it('saves through the service and returns its result, saved or refused', async () => {
    const saved: SaveExpertResult = { status: 'SAVED', expert }
    const refused: SaveExpertResult = { status: 'INVALID', field: 'name', message: 'Name is required.' }
    const saveExpert = vi.fn<(input: ExpertInput) => SaveExpertResult>().mockReturnValueOnce(saved).mockReturnValueOnce(refused)
    const handler = createSaveExpertHandler(async () => ({ saveExpert }))

    await expect(handler(expertInput)).resolves.toBe(saved)
    await expect(handler({ ...expertInput, name: '' })).resolves.toBe(refused)
    expect(saveExpert).toHaveBeenNthCalledWith(1, expertInput)
  })

  it('hands the service only the known fields', async () => {
    const saveExpert = vi.fn((): SaveExpertResult => ({ status: 'SAVED', expert }))
    const handler = createSaveExpertHandler(async () => ({ saveExpert }))

    await handler({ ...expertInput, email: 'wong@example.edu', turnaroundMs: 1 } as ExpertInput)

    expect(saveExpert).toHaveBeenCalledWith(expertInput)
  })

  it('rejects a record of the wrong shape before touching the service', async () => {
    const saveExpert = vi.fn((): SaveExpertResult => ({ status: 'SAVED', expert }))
    const handler = createSaveExpertHandler(async () => ({ saveExpert }))

    await expect(handler(undefined as unknown as ExpertInput)).rejects.toThrow(/expert record is missing/)
    await expect(handler({ ...expertInput, name: 7 } as unknown as ExpertInput)).rejects.toThrow(/name must be text/)
    await expect(handler({ ...expertInput, expertId: '' })).rejects.toThrow(/expert id must be a non-empty string, or null/)
    await expect(handler({ ...expertInput, outreachTs: 1_700_000_000_000 } as unknown as ExpertInput)).rejects.toThrow(/outreach time must be/)
    await expect(handler({ ...expertInput, firstAnswerTs: undefined } as unknown as ExpertInput)).rejects.toThrow(/first answer time must be/)
    expect(saveExpert).not.toHaveBeenCalled()
  })

  it('passes the service\'s own failure through as the error', async () => {
    const handler = createSaveExpertHandler(async () => ({
      saveExpert: () => {
        throw new Error('Expert Dr. Wong could not be saved (disk is full). It was kept in the error log and can be retried.')
      },
    }))

    await expect(handler(expertInput)).rejects.toThrow(/kept in the error log and can be retried/)
  })
})

describe('expert-answers:list handler', () => {
  it('lists the expert\'s answers and rejects a missing id first', async () => {
    const listAnswers = vi.fn(() => [answer])
    const handler = createListExpertAnswersHandler(async () => ({ listAnswers }))

    await expect(handler('expert-1')).resolves.toEqual([answer])
    expect(listAnswers).toHaveBeenCalledWith('expert-1')
    await expect(handler(' ')).rejects.toThrow(/Expert id must be a non-empty string/)
    await expect(handler(undefined as unknown as string)).rejects.toThrow(/Expert id must be a non-empty string/)
    expect(listAnswers).toHaveBeenCalledTimes(1)
  })
})

describe('expert-answer:save handler', () => {
  it('saves through the service with the replace flag as given, and returns its result', async () => {
    const exists: SaveExpertAnswerResult = { status: 'ANSWER_EXISTS', existing: answer }
    const saved: SaveExpertAnswerResult = { status: 'SAVED', saved: answer, superseded: null }
    const saveAnswer = vi.fn<(input: ExpertAnswerInput) => SaveExpertAnswerResult>().mockReturnValueOnce(exists).mockReturnValueOnce(saved)
    const handler = createSaveExpertAnswerHandler(async () => ({ saveAnswer }))

    await expect(handler(answerInput)).resolves.toBe(exists)
    await expect(handler({ ...answerInput, replace: true })).resolves.toBe(saved)
    expect(saveAnswer).toHaveBeenNthCalledWith(1, answerInput)
    expect(saveAnswer).toHaveBeenNthCalledWith(2, { ...answerInput, replace: true })
  })

  it('hands the service only the known fields', async () => {
    const saveAnswer = vi.fn((): SaveExpertAnswerResult => ({ status: 'SAVED', saved: answer, superseded: null }))
    const handler = createSaveExpertAnswerHandler(async () => ({ saveAnswer }))

    await handler({ ...answerInput, keywords: 'injected', sessionId: 'other' } as ExpertAnswerInput)

    expect(saveAnswer).toHaveBeenCalledWith(answerInput)
  })

  it('rejects an answer of the wrong shape before touching the service', async () => {
    const saveAnswer = vi.fn((): SaveExpertAnswerResult => ({ status: 'SAVED', saved: answer, superseded: null }))
    const handler = createSaveExpertAnswerHandler(async () => ({ saveAnswer }))

    await expect(handler(null as unknown as ExpertAnswerInput)).rejects.toThrow(/expert answer is missing/)
    await expect(handler({ ...answerInput, expertId: '' })).rejects.toThrow(/expert id must be a non-empty string/)
    await expect(handler({ ...answerInput, questionNumber: '1' } as unknown as ExpertAnswerInput)).rejects.toThrow(/question number must be a number/)
    await expect(handler({ ...answerInput, answerText: null } as unknown as ExpertAnswerInput)).rejects.toThrow(/answer must be text/)
    await expect(handler({ ...answerInput, replace: 'true' } as unknown as ExpertAnswerInput)).rejects.toThrow(/replace flag must be true or false/)
    await expect(handler({ expertId: 'expert-1', questionNumber: 1, answerText: 'An answer.' } as ExpertAnswerInput)).rejects.toThrow(
      /replace flag must be true or false/,
    )
    expect(saveAnswer).not.toHaveBeenCalled()
  })
})
