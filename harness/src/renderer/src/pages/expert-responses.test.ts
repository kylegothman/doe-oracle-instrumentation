import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ResponseSource, type Expert, type ExpertResponse } from '../../../shared/experts'
import type { Question } from '../../../shared/questions'
import {
  answerQuestionLabel,
  answerTo,
  buildExpertInput,
  defaultExpertId,
  draftNote,
  draftState,
  expertChoices,
  firstOpenQuestion,
  formFor,
  formatTurnaround,
  formTurnaroundMs,
  fromLocalInputValue,
  localDateTime,
  NEW_EXPERT,
  NEW_EXPERT_FORM,
  progressLabel,
  progressSummary,
  questionProgress,
  toLocalInputValue,
  turnaroundDetail,
  withSavedAnswer,
  withSavedExpert,
  type ExpertForm,
} from './expert-responses'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

function expert(overrides: Partial<Expert> = {}): Expert {
  return {
    expertId: 'expert-1',
    name: 'Dr. Wong',
    source: ResponseSource.EMAIL,
    outreachTs: '2026-10-06T14:00:00.000Z',
    firstAnswerTs: '2026-10-20T17:00:00.000Z',
    turnaroundMs: 14 * DAY_MS + 3 * HOUR_MS,
    ...overrides,
  }
}

function answer(questionNumber: number, overrides: Partial<ExpertResponse> = {}): ExpertResponse {
  return {
    responseId: questionNumber,
    testNumber: questionNumber,
    expertId: 'expert-1',
    sessionId: 'session-a',
    questionNumber,
    answerText: `Answer ${questionNumber}.`,
    sizeBytes: 9,
    keywords: null,
    recordedAt: '2026-11-20T16:30:00.000Z',
    supersededBy: null,
    ...overrides,
  }
}

function form(overrides: Partial<ExpertForm> = {}): ExpertForm {
  return { ...NEW_EXPERT_FORM, name: 'Dr. Wong', outreachLocal: '2026-10-06T09:00', firstAnswerLocal: '2026-10-20T12:00', ...overrides }
}

const QUESTIONS: Question[] = Array.from({ length: 12 }, (_, index) => ({ number: index + 1, text: `Question ${index + 1}?` }))

describe('the Expert dropdown', () => {
  it('offers a new expert first, then the saved experts', () => {
    expect(expertChoices([expert(), expert({ expertId: 'expert-2', name: 'Dr. Kuhn' })])).toEqual([
      { value: NEW_EXPERT, label: 'New expert' },
      { value: 'expert-1', label: 'Dr. Wong' },
      { value: 'expert-2', label: 'Dr. Kuhn' },
    ])
  })

  it('opens on the saved expert only when there is exactly one', () => {
    expect(defaultExpertId([])).toBeNull()
    expect(defaultExpertId([expert()])).toBe('expert-1')
    expect(defaultExpertId([expert(), expert({ expertId: 'expert-2' })])).toBeNull()
  })

  it('adds a saved expert in name order and replaces an updated one in place', () => {
    const kuhn = expert({ expertId: 'expert-2', name: 'Dr. Kuhn' })
    const renamed = expert({ name: 'Dr. Adams' })

    expect(withSavedExpert([expert()], kuhn).map((each) => each.name)).toEqual(['Dr. Kuhn', 'Dr. Wong'])
    expect(withSavedExpert([kuhn, expert()], renamed)).toEqual([renamed, kuhn])
  })
})

describe('local times', () => {
  // Local times that exist both in UTC, where CI runs, and in US Central time, some of them on days the clocks change.
  const ENTERED = [
    '2026-10-06T09:00',
    '2026-10-20T12:00',
    '2026-01-01T00:00',
    '2026-12-31T23:59',
    '2024-02-29T06:30',
    '2026-03-08T01:59',
    '2026-03-08T03:00',
    '2026-03-29T04:00',
    '2026-10-25T01:30',
    '2026-11-01T01:30',
    '2026-11-01T23:00',
  ]

  it.each(ENTERED)('a saved time reads back as the same local time that was entered: %s', (entered) => {
    const stored = fromLocalInputValue(entered)

    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(toLocalInputValue(stored as string)).toBe(entered)
  })

  it('reads back the same local times through the whole form: entered, sent, saved, shown again', () => {
    const entered = form()

    const outcome = buildExpertInput(entered)
    if (!outcome.ok) throw new Error(outcome.message)
    // What the main process saves for this input, and hands back on the next launch.
    const saved = expert({ outreachTs: outcome.input.outreachTs, firstAnswerTs: outcome.input.firstAnswerTs })

    expect(formFor(saved)).toMatchObject({ outreachLocal: '2026-10-06T09:00', firstAnswerLocal: '2026-10-20T12:00' })
  })

  it('stores the local time as the same moment in UTC, with milliseconds', () => {
    expect(fromLocalInputValue('2026-10-06T09:00')).toBe(new Date(2026, 9, 6, 9, 0).toISOString())
    expect(fromLocalInputValue('2026-10-06T09:00:07')).toBe(new Date(2026, 9, 6, 9, 0, 7).toISOString())
    expect(fromLocalInputValue('2026-10-06T09:00:07.5')).toBe(new Date(2026, 9, 6, 9, 0, 7, 500).toISOString())
  })

  it('keeps seconds and milliseconds when the stored time has them', () => {
    expect(toLocalInputValue(new Date(2026, 9, 6, 9, 0, 7).toISOString())).toBe('2026-10-06T09:00:07')
    expect(toLocalInputValue(new Date(2026, 9, 6, 9, 0, 0, 250).toISOString())).toBe('2026-10-06T09:00:00.250')
  })

  it('reads an empty input as no time, and anything that is not a date and time as unreadable', () => {
    expect(fromLocalInputValue('')).toBeNull()
    expect(fromLocalInputValue('2026-10-06')).toBeUndefined()
    expect(fromLocalInputValue('2026-10-06 09:00')).toBeUndefined()
    expect(fromLocalInputValue('2026-02-31T09:00')).toBeUndefined()
    expect(fromLocalInputValue('2026-10-06T24:00')).toBeUndefined()
    expect(fromLocalInputValue('2026-13-01T09:00')).toBeUndefined()
  })

  it('shows nothing for a missing or unreadable stored time', () => {
    expect(toLocalInputValue(null)).toBe('')
    expect(toLocalInputValue('not a time')).toBe('')
  })

  it('shows a stored time as local date and time to the minute', () => {
    expect(localDateTime(new Date(2026, 10, 20, 14, 5, 33).toISOString())).toBe('2026-11-20 14:05')
  })
})

/**
 * The Test Plan's example in the zone the tests are run by hand in. Node
 * applies a TZ set at run time on macOS and Linux; where it does not, the
 * cases are skipped, and the zone-independent cases above still hold.
 */
describe('local times in US Central time', () => {
  let central = false

  beforeAll(() => {
    vi.stubEnv('TZ', 'America/Chicago')
    central = new Date(2026, 0, 1).getTimezoneOffset() === 360 && new Date(2026, 6, 1).getTimezoneOffset() === 300
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('stores 2026-10-06 09:00 Central as 14:00 UTC, and the Test Plan turnaround is 14 days 3 hours', ({ skip }) => {
    skip(!central, 'this platform does not apply a TZ set at run time')

    const entered = form({ outreachLocal: '2026-10-06T09:00', firstAnswerLocal: '2026-10-20T12:00' })

    expect(buildExpertInput(entered)).toMatchObject({
      ok: true,
      input: { outreachTs: '2026-10-06T14:00:00.000Z', firstAnswerTs: '2026-10-20T17:00:00.000Z' },
    })
    expect(formatTurnaround(formTurnaroundMs(entered))).toBe('14 days 3 hours')
  })

  it('counts real elapsed time across the clocks going back: 14 days 3 hours on the clock is one hour more', ({ skip }) => {
    skip(!central, 'this platform does not apply a TZ set at run time')

    // 2026-11-01 is the day the clocks go back, so this span holds a 25-hour day.
    const entered = form({ outreachLocal: '2026-10-25T09:00', firstAnswerLocal: '2026-11-08T12:00' })

    expect(formTurnaroundMs(entered)).toBe(14 * DAY_MS + 4 * HOUR_MS)
  })

  it('refuses the hour that is skipped when the clocks go forward, and names the field', ({ skip }) => {
    skip(!central, 'this platform does not apply a TZ set at run time')

    expect(fromLocalInputValue('2026-03-08T02:30')).toBeUndefined()
    expect(buildExpertInput(form({ firstAnswerLocal: '2026-03-08T02:30' }))).toEqual({
      ok: false,
      field: 'firstAnswerTs',
      message: "First answer time is not a time that exists on this computer's clock. Check the date and the hour.",
    })
  })

  it('reads the hour that happens twice as the first of the two, and shows it back unchanged', ({ skip }) => {
    skip(!central, 'this platform does not apply a TZ set at run time')

    expect(fromLocalInputValue('2026-11-01T01:30')).toBe('2026-11-01T06:30:00.000Z')
    expect(toLocalInputValue('2026-11-01T06:30:00.000Z')).toBe('2026-11-01T01:30')
  })
})

describe('buildExpertInput', () => {
  it('sends the form as it is, with the times as UTC timestamps', () => {
    expect(buildExpertInput(form({ expertId: 'expert-1', source: ResponseSource.INTERVIEW }))).toEqual({
      ok: true,
      input: {
        expertId: 'expert-1',
        name: 'Dr. Wong',
        source: ResponseSource.INTERVIEW,
        outreachTs: new Date(2026, 9, 6, 9, 0).toISOString(),
        firstAnswerTs: new Date(2026, 9, 20, 12, 0).toISOString(),
      },
    })
  })

  it('leaves an empty name and missing times for the main process to refuse', () => {
    expect(buildExpertInput({ ...NEW_EXPERT_FORM })).toEqual({
      ok: true,
      input: { expertId: null, name: '', source: ResponseSource.EMAIL, outreachTs: null, firstAnswerTs: null },
    })
  })

  it('refuses a half-entered time, which the input reports as empty, and names the field', () => {
    expect(buildExpertInput(form({ outreachLocal: '', outreachIncomplete: true }))).toEqual({
      ok: false,
      field: 'outreachTs',
      message: 'Outreach time is incomplete. Enter both the date and the time.',
    })
    expect(buildExpertInput(form({ firstAnswerLocal: '', firstAnswerIncomplete: true }))).toEqual({
      ok: false,
      field: 'firstAnswerTs',
      message: 'First answer time is incomplete. Enter both the date and the time, or clear the field.',
    })
  })

  it('refuses a time that is not a date and time', () => {
    expect(buildExpertInput(form({ outreachLocal: '2026-02-31T09:00' }))).toMatchObject({ ok: false, field: 'outreachTs' })
  })
})

describe('the turnaround', () => {
  it('reads in days and hours', () => {
    expect(formatTurnaround(14 * DAY_MS + 3 * HOUR_MS)).toBe('14 days 3 hours')
    expect(formatTurnaround(1_220_400_000)).toBe('14 days 3 hours')
    expect(formatTurnaround(DAY_MS + HOUR_MS)).toBe('1 day 1 hour')
    expect(formatTurnaround(2 * DAY_MS)).toBe('2 days 0 hours')
  })

  it('rounds down to whole hours once it is a day or more, or an hour or more', () => {
    expect(formatTurnaround(14 * DAY_MS + 3 * HOUR_MS + 59 * 60_000)).toBe('14 days 3 hours')
    expect(formatTurnaround(5 * HOUR_MS + 30 * 60_000)).toBe('5 hours')
  })

  it('reads in minutes under an hour, and zero is 0 hours', () => {
    expect(formatTurnaround(25 * 60_000)).toBe('25 minutes')
    expect(formatTurnaround(60_000)).toBe('1 minute')
    expect(formatTurnaround(59_999)).toBe('0 hours')
    expect(formatTurnaround(0)).toBe('0 hours')
  })

  it('is a dash while there is no first answer, or the times are the wrong way round', () => {
    expect(formatTurnaround(null)).toBe('—')
    expect(formatTurnaround(-60_000)).toBe('—')
    expect(turnaroundDetail(null)).toBe('')
    expect(turnaroundDetail(-60_000)).toBe('')
  })

  it('shows the stored milliseconds beside it', () => {
    expect(turnaroundDetail(1_220_400_000)).toBe('1,220,400,000 ms')
    expect(turnaroundDetail(0)).toBe('0 ms')
  })

  it('follows the form before it is saved', () => {
    expect(formTurnaroundMs(form({ firstAnswerLocal: '2026-10-06T10:30' }))).toBe(90 * 60_000)
    expect(formTurnaroundMs(form({ firstAnswerLocal: '2026-10-06T09:00' }))).toBe(0)
    expect(formTurnaroundMs(form({ firstAnswerLocal: '2026-10-06T08:59' }))).toBe(-60_000)
    expect(formTurnaroundMs(form({ firstAnswerLocal: '' }))).toBeNull()
    expect(formTurnaroundMs(form({ outreachLocal: '' }))).toBeNull()
    expect(formTurnaroundMs(form({ firstAnswerIncomplete: true }))).toBeNull()
  })
})

describe('progress', () => {
  const progress = questionProgress(QUESTIONS, [answer(1), answer(2), answer(7)])

  it('marks each of the 12 questions answered or open', () => {
    expect(progress).toHaveLength(12)
    expect(progress.filter((question) => question.answered).map((question) => question.number)).toEqual([1, 2, 7])
    expect(progress.filter((question) => !question.answered).map((question) => question.number)).toEqual([3, 4, 5, 6, 8, 9, 10, 11, 12])
  })

  it('counts only the standard questions', () => {
    expect(progressLabel(questionProgress(QUESTIONS, [answer(1), answer(13)]))).toBe('1 of 12 answered')
  })

  it('says how many are answered and which are open', () => {
    expect(progressLabel(progress)).toBe('3 of 12 answered')
    expect(progressSummary(progress)).toBe('3 answered, 9 open. Open: Q3, Q4, Q5, Q6, Q8, Q9, Q10, Q11, Q12.')
    expect(progressSummary(questionProgress(QUESTIONS, QUESTIONS.map((question) => answer(question.number))))).toBe(
      '12 answered, 0 open. Every question has an answer.',
    )
    expect(progressSummary(questionProgress(QUESTIONS, []))).toMatch(/^0 answered, 12 open\. Open: Q1, .*Q12\.$/)
    expect(progressSummary([])).toBe('No questions are loaded.')
  })

  it('opens on the first open question, or the first question when all are answered', () => {
    expect(firstOpenQuestion(progress)).toBe(3)
    expect(firstOpenQuestion(questionProgress(QUESTIONS, QUESTIONS.map((question) => answer(question.number))))).toBe(1)
    expect(firstOpenQuestion([])).toBe(1)
  })

  it('lists a question as on the Test Console, marked when it is answered', () => {
    const question = { number: 2, text: 'What is a covering array?' }

    expect(answerQuestionLabel(question, false)).toBe('Q2 · What is a covering array?')
    expect(answerQuestionLabel(question, true)).toBe('Q2 · What is a covering array? (answered)')
  })
})

describe('answers', () => {
  it('finds the active answer to a question', () => {
    const answers = [answer(1), answer(2, { supersededBy: 9 }), answer(2, { responseId: 9, answerText: 'Revised.' })]

    expect(answerTo(answers, 2)?.answerText).toBe('Revised.')
    expect(answerTo(answers, 3)).toBeUndefined()
  })

  it('puts a saved answer in place of the one it replaces, in question order', () => {
    const revised = answer(2, { responseId: 9, answerText: 'Revised.' })

    expect(withSavedAnswer([answer(1), answer(2), answer(5)], revised)).toEqual([answer(1), revised, answer(5)])
    expect(withSavedAnswer([answer(5)], answer(3))).toEqual([answer(3), answer(5)])
  })

  it('tells an empty box, a new answer, the saved answer, and a changed one apart', () => {
    const saved = answer(1, { answerText: 'The saved answer.' })

    expect(draftState('', undefined)).toBe('empty')
    expect(draftState(' \n ', undefined)).toBe('empty')
    expect(draftState('A first answer.', undefined)).toBe('new')
    expect(draftState('The saved answer.', saved)).toBe('saved')
    expect(draftState('The saved answer, revised.', saved)).toBe('changed')
    expect(draftState('', saved)).toBe('changed')
  })

  it('does not count blank lines at the ends as a change, since they are not stored', () => {
    const saved = answer(1, { answerText: 'The saved answer.' })

    expect(draftState('\n\nThe saved answer.\n \n', saved)).toBe('saved')
    expect(draftState(' The saved answer.', saved)).toBe('changed')
  })

  it('has a note for every state', () => {
    expect(draftNote('empty')).toMatch(/No answer saved/)
    expect(draftNote('new')).toMatch(/Not saved yet/)
    expect(draftNote('saved')).toMatch(/saved answer/)
    expect(draftNote('changed')).toMatch(/Differs from the saved answer/)
  })
})
