import { describe, expect, it } from 'vitest'
import { parseUtcTimestamp, trimBlankLines, turnaroundMs, validateExpertAnswerInput, validateExpertInput } from './expert-entry'
import { ResponseSource } from './experts'

describe('parseUtcTimestamp', () => {
  it('reads ISO 8601 UTC with milliseconds', () => {
    expect(parseUtcTimestamp('2026-10-06T14:00:00.000Z')).toBe(Date.UTC(2026, 9, 6, 14))
    expect(parseUtcTimestamp('2026-10-06T14:00:59.999Z')).toBe(Date.UTC(2026, 9, 6, 14, 0, 59, 999))
  })

  it.each(['', '2026-10-06', '2026-10-06T14:00', '2026-10-06T14:00:00Z', '2026-10-06T09:00:00.000-05:00', '2026-02-30T09:00:00.000Z', 'yesterday'])(
    'refuses %j',
    (value) => {
      expect(parseUtcTimestamp(value)).toBeNull()
    },
  )
})

describe('turnaroundMs', () => {
  it('is the first answer minus the outreach, in milliseconds', () => {
    expect(turnaroundMs('2026-10-06T14:00:00.000Z', '2026-10-20T17:00:00.000Z')).toBe(1_220_400_000)
    expect(turnaroundMs('2026-10-06T14:00:00.000Z', '2026-10-06T14:00:00.000Z')).toBe(0)
    expect(turnaroundMs('2026-10-06T14:00:00.000Z', '2026-10-06T13:59:00.000Z')).toBe(-60_000)
  })

  it('is null while a time is missing or unreadable', () => {
    expect(turnaroundMs('2026-10-06T14:00:00.000Z', null)).toBeNull()
    expect(turnaroundMs(null, '2026-10-06T14:00:00.000Z')).toBeNull()
    expect(turnaroundMs('soon', '2026-10-06T14:00:00.000Z')).toBeNull()
  })
})

describe('trimBlankLines', () => {
  it('drops blank lines at the very start and end only', () => {
    expect(trimBlankLines('\n\nAnswer.\n\n')).toBe('Answer.')
    expect(trimBlankLines(' \t\n\r\nAnswer.\r\n  \r\n')).toBe('Answer.')
  })

  it('keeps indentation, trailing spaces, inner blank lines, and inner line endings', () => {
    expect(trimBlankLines('\n  One.  \n\n\tTwo.\r\nThree. \n')).toBe('  One.  \n\n\tTwo.\r\nThree. ')
  })

  it('leaves text with no blank lines at its ends untouched', () => {
    expect(trimBlankLines('  One line. ')).toBe('  One line. ')
    expect(trimBlankLines('')).toBe('')
  })
})

describe('validateExpertInput', () => {
  const input = { expertId: null, name: 'Dr. Wong', source: ResponseSource.EMAIL, outreachTs: '2026-10-06T14:00:00.000Z', firstAnswerTs: null }

  it('accepts a new expert, an update, and empty values the service will judge', () => {
    expect(validateExpertInput(input)).toBeNull()
    expect(validateExpertInput({ ...input, expertId: 'expert-1', firstAnswerTs: '2026-10-20T17:00:00.000Z' })).toBeNull()
    expect(validateExpertInput({ ...input, name: '', outreachTs: null })).toBeNull()
  })

  it.each([
    [null, /expert record is missing/],
    ['Dr. Wong', /expert record is missing/],
    [{ ...input, expertId: undefined }, /expert id must be/],
    [{ ...input, expertId: ' ' }, /expert id must be/],
    [{ ...input, expertId: 7 }, /expert id must be/],
    [{ ...input, name: null }, /name must be text/],
    [{ ...input, source: 1 }, /source must be text/],
    [{ ...input, outreachTs: 1_700_000_000_000 }, /outreach time must be/],
    [{ ...input, outreachTs: undefined }, /outreach time must be/],
    [{ ...input, firstAnswerTs: new Date(0) }, /first answer time must be/],
  ])('refuses %j', (value, problem) => {
    expect(validateExpertInput(value)).toMatch(problem)
  })
})

describe('validateExpertAnswerInput', () => {
  const input = { expertId: 'expert-1', questionNumber: 1, answerText: 'An answer.', replace: false }

  it('accepts an answer, including values the service will judge', () => {
    expect(validateExpertAnswerInput(input)).toBeNull()
    expect(validateExpertAnswerInput({ ...input, questionNumber: 99, answerText: '', replace: true })).toBeNull()
  })

  it.each([
    [undefined, /expert answer is missing/],
    [{ ...input, expertId: '' }, /expert id must be/],
    [{ ...input, expertId: null }, /expert id must be/],
    [{ ...input, questionNumber: '1' }, /question number must be a number/],
    [{ ...input, answerText: ['An answer.'] }, /answer must be text/],
    [{ ...input, replace: undefined }, /replace flag must be true or false/],
    [{ ...input, replace: 'yes' }, /replace flag must be true or false/],
  ])('refuses %j', (value, problem) => {
    expect(validateExpertAnswerInput(value)).toMatch(problem)
  })
})
