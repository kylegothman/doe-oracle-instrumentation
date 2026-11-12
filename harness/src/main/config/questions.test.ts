import { describe, expect, it } from 'vitest'
import { getQuestion, listQuestions } from './questions'

describe('question config', () => {
  it('holds question 1 with the exact standard text', () => {
    expect(getQuestion(1)).toEqual({ number: 1, text: 'What is combinatorial testing?' })
  })

  it('lists the configured questions', () => {
    expect(listQuestions().map((q) => q.number)).toEqual([1])
  })

  it('rejects a question number that is not configured', () => {
    expect(() => getQuestion(2)).toThrow(/Question 2 is not in the harness config \(known: 1\)/)
  })
})
