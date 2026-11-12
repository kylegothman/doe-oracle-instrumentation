import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QuestionBank } from './question-bank'

/** The file the harness ships, relative to this test. */
const SHIPPED_CONFIG = fileURLToPath(new URL('../../../config/questions.json', import.meta.url))

describe('QuestionBank', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-questions-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(content: string): string {
    const path = join(dir, 'questions.json')
    writeFileSync(path, content)
    return path
  }

  it('loads the 12 standard questions from the shipped config, in order', () => {
    const bank = QuestionBank.load(SHIPPED_CONFIG)

    expect(bank.size).toBe(12)
    expect(bank.list().map((q) => q.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(bank.getByNumber(1).text).toBe('What is combinatorial testing?')
    expect(bank.getByNumber(5).text).toBe('Define the IPOG algorithm.')
    expect(bank.getByNumber(9).text).toBe(
      'If a system has 4 parameters with 3 values each, how many tests does exhaustive testing need, compared to pairwise testing?',
    )
    expect(bank.getByNumber(12).text).toBe('What is the global broadband speed test?')
  })

  it('returns copies so callers cannot change the bank', () => {
    const bank = new QuestionBank([{ number: 1, text: 'One?' }])

    bank.getByNumber(1).text = 'changed'
    bank.list()[0]!.text = 'changed'

    expect(bank.getByNumber(1).text).toBe('One?')
  })

  it('throws for a number that is not in the bank', () => {
    const bank = new QuestionBank([{ number: 1, text: 'One?' }, { number: 2, text: 'Two?' }])

    expect(() => bank.getByNumber(3)).toThrow(/Question 3 is not in the question bank \(1 to 2\)/)
    expect(() => bank.getByNumber(0)).toThrow(/Question 0 is not/)
  })

  it('names the file when it cannot be read or is not JSON', () => {
    expect(() => QuestionBank.load(join(dir, 'missing.json'))).toThrow(/Could not read the questions config at .*missing\.json/)
    expect(() => QuestionBank.load(writeConfig('{ not json'))).toThrow(/is not valid JSON/)
  })

  it('rejects a config whose shape or numbering is wrong', () => {
    expect(() => QuestionBank.load(writeConfig('{"items": []}'))).toThrow(/expected an object with a "questions" array/)
    expect(() => QuestionBank.load(writeConfig('{"questions": []}'))).toThrow(/the question bank is empty/)
    expect(() => QuestionBank.load(writeConfig('{"questions": [{"number": 1, "text": ""}]}'))).toThrow(/question 1 needs a non-empty "text"/)
    expect(() => QuestionBank.load(writeConfig('{"questions": [{"number": 2, "text": "Two?"}]}'))).toThrow(
      /numbered 1 to 1 in order; entry 1 is number 2/,
    )
    expect(() =>
      QuestionBank.load(writeConfig('{"questions": [{"number": 1, "text": "One?"}, {"number": 1, "text": "Again?"}]}')),
    ).toThrow(/entry 2 is number 1/)
    expect(() => QuestionBank.load(writeConfig('{"questions": [{"text": "No number"}]}'))).toThrow(/entry 1 needs a positive whole "number"/)
  })
})
