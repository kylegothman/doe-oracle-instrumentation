import { describe, expect, it } from 'vitest'
import { FailureType } from '../../../shared/failures'
import { Subject } from '../../../shared/subjects'
import { TrialStatus, type Trial, type TrialEvent } from '../../../shared/trials'
import {
  adjustedEndMs,
  answerFoundTime,
  answerPreview,
  copyStep,
  noAnswerMessage,
  savedResultsText,
  searchTimes,
  clockTime,
  failureTitle,
  formatMs,
  nextQuestionNumber,
  questionLabel,
  questionLine,
  recordDetails,
  sessionSummary,
  SUBJECT_CHOICES,
  timerCaption,
  trialBadge,
  trialSteps,
  trialTitle,
  waitingBanner,
} from './test-console'

const event = (subject: Subject, status: TrialEvent['status'], elapsedMs: number, extra: Partial<TrialEvent> = {}): TrialEvent => ({
  trialId: 't',
  subject,
  questionNumber: 2,
  status,
  elapsedMs,
  ...extra,
})

const trial = (overrides: Partial<Trial> = {}): Trial => ({
  trialId: 't',
  testNumber: 7,
  sessionId: 's',
  dataSetName: 'DOE_ORACLE-2026-11-19',
  subject: Subject.DOE_ORACLE,
  questionNumber: 4,
  status: TrialStatus.SUCCESS,
  beginTs: '2026-11-19T20:44:02.331Z',
  firstResponseTs: '2026-11-19T20:44:03.438Z',
  endTs: '2026-11-19T20:44:07.143Z',
  responseMs: 4_812,
  firstResponseMs: 1_107,
  answerText: 'An answer.',
  citations: [],
  pageLoadMs: null,
  timeToAnswerMs: null,
  sourceUrl: null,
  sizeBytes: 338,
  keywords: null,
  ...overrides,
})

const limit60 = { timeoutMs: 60_000, startsAt: 'trial_start' as const, confirmEnd: false, answerFound: false, answerLimitMs: null }
const googleLimit = { timeoutMs: 60_000, startsAt: 'submit' as const, confirmEnd: false, answerFound: true, answerLimitMs: 120_000 }

describe('SUBJECT_CHOICES', () => {
  it('offers the three subjects', () => {
    expect(SUBJECT_CHOICES).toEqual([
      { value: Subject.DOE_ORACLE, label: 'DOE Oracle', disabled: false },
      { value: Subject.COPILOT, label: 'Microsoft Copilot', disabled: false },
      { value: Subject.GOOGLE, label: 'Google Search', disabled: false },
    ])
  })
})

describe('Google', () => {
  const beginMs = Date.UTC(2026, 10, 19, 20, 41, 12, 204)
  const loaded = event(Subject.GOOGLE, 'awaiting_confirmation', 9_000, { beginMs, endMs: beginMs + 812 })

  it("walks Google's steps, ending at the results page loading", () => {
    const steps = trialSteps(Subject.GOOGLE, [
      event(Subject.GOOGLE, 'started', 0),
      event(Subject.GOOGLE, 'awaiting_submit', 400),
      event(Subject.GOOGLE, 'first_response', 8_500),
      loaded,
    ])
    expect(steps.map((step) => step.label)).toEqual(['Question filled in on Google', 'You pressed Enter', 'First response', 'Results page loaded'])
    expect(steps.every((step) => step.state === 'done')).toBe(true)
    expect(steps[1]?.time).toBe('20:41:12.204Z')
  })

  it('gives the page-load time and how long the Tester has been searching, from their Enter', () => {
    expect(searchTimes(loaded, googleLimit, beginMs + 38_400)).toEqual({ pageLoadMs: 812, searchingMs: 38_400 })
  })

  it('gives no search times outside the Answer Found wait, or for a subject without it', () => {
    expect(searchTimes(event(Subject.GOOGLE, 'first_response', 1), googleLimit, beginMs)).toBeNull()
    expect(searchTimes(loaded, limit60, beginMs)).toBeNull()
  })

  it('asks for the passage, with the answer limit', () => {
    expect(waitingBanner(loaded, googleLimit)).toEqual({
      title: 'Find the answer on the results page',
      message:
        'Open the organic result that best answers the question. Ignore the AI overview. ' +
        'Highlight the passage that answers it, then click Answer Found, or No Answer Found if no result answers it. ' +
        'After 120 s without either, the trial is saved as no answer found.',
    })
  })

  it('passes on the subject’s own message while waiting, such as the unusual-traffic check', () => {
    expect(waitingBanner(event(Subject.GOOGLE, 'awaiting_submit', 1, { message: 'Google is showing its "unusual traffic" check.' }))).toEqual({
      title: 'Your turn in the Google Search window',
      message: 'Google is showing its "unusual traffic" check.',
    })
  })

  it('tells a saved results page apart from a highlighted passage, by its source', () => {
    const google = (sourceUrl: string | null) => ({ subject: Subject.GOOGLE, sourceUrl })
    expect(savedResultsText(google('https://www.google.com/search?q=What+is+combinatorial+testing%3F&sca_esv=c5'))).toBe(true)
    expect(savedResultsText(google('https://www.google.co.uk/search?q=x'))).toBe(true)
    expect(savedResultsText(google('https://www.nist.gov/programs-projects/combinatorial-testing'))).toBe(false)
    expect(savedResultsText(google('https://example.edu/search'))).toBe(false)
    expect(savedResultsText(google(null))).toBe(false)
    expect(savedResultsText({ subject: Subject.DOE_ORACLE, sourceUrl: 'https://www.google.com/search?q=x' })).toBe(false)
  })

  it('shows when Answer Found was clicked, and why a trial has no answer', () => {
    expect(answerFoundTime({ beginTs: '2026-11-19T20:41:12.204Z', timeToAnswerMs: 38_406 })).toBe('20:41:50.610Z')
    expect(answerFoundTime({ beginTs: '2026-11-19T20:41:12.204Z', timeToAnswerMs: null })).toBe('—')
    expect(noAnswerMessage(googleLimit)).toBe(
      'No Answer Found was clicked, or 120 s passed after the results loaded without Answer Found. Saved as a result, not a failure, with its page-load time.',
    )
  })
})

describe('questionLabel and questionLine', () => {
  const questions = [{ number: 1, text: 'What is combinatorial testing?' }]

  it('shows the number and the text, as in the design', () => {
    expect(questionLabel(questions[0]!)).toBe('Q1 · What is combinatorial testing?')
    expect(questionLine(1, questions)).toBe('Q1 · What is combinatorial testing?')
  })

  it('falls back to the number when the text is not known', () => {
    expect(questionLine(5, questions)).toBe('Q5')
  })

  it('cuts a long question at a word in the dropdown, and keeps it whole on the trial cards', () => {
    const long = {
      number: 9,
      text: 'If a system has 4 parameters with 3 values each, how many tests does exhaustive testing need, compared to pairwise testing?',
    }

    expect(questionLabel(long)).toBe('Q9 · If a system has 4 parameters with 3 values each, how many tests does…')
    expect(questionLine(9, [long])).toBe(`Q9 · ${long.text}`)
  })

  it('keeps a word that ends exactly at the limit, and drops punctuation left before the ellipsis', () => {
    const seventy = `${'word '.repeat(13)}words`
    expect(seventy).toHaveLength(70)
    expect(questionLabel({ number: 2, text: `${seventy} and more` })).toBe(`Q2 · ${seventy}…`)
    expect(questionLabel({ number: 3, text: `${'word '.repeat(13)}word, and then some more text` })).toBe(`Q3 · ${'word '.repeat(13)}word…`)
  })

  it('leaves a question of 70 characters or fewer as it is', () => {
    const text = 'Why does combinatorial testing guarantee that all faults are found?'
    expect(questionLabel({ number: 10, text })).toBe(`Q10 · ${text}`)
  })

  it('cuts a single word longer than the limit at the limit', () => {
    expect(questionLabel({ number: 1, text: 'x'.repeat(80) })).toBe(`Q1 · ${'x'.repeat(70)}…`)
  })
})

describe('trialSteps', () => {
  it("walks Copilot's four steps as the events arrive", () => {
    const states = (events: TrialEvent[]) => trialSteps(Subject.COPILOT, events).map((step) => step.state)
    const started = event(Subject.COPILOT, 'started', 0)
    const submit = event(Subject.COPILOT, 'awaiting_submit', 900)
    const first = event(Subject.COPILOT, 'first_response', 6_204)
    const confirm = event(Subject.COPILOT, 'awaiting_confirmation', 14_377, { beginMs: Date.UTC(2026, 10, 19, 20, 32, 5, 118), endMs: Date.UTC(2026, 10, 19, 20, 32, 14, 495) })

    expect(states([started])).toEqual(['current', 'pending', 'pending', 'pending'])
    expect(states([started, submit])).toEqual(['done', 'current', 'pending', 'pending'])
    expect(states([started, submit, first])).toEqual(['done', 'done', 'done', 'current'])
    expect(trialSteps(Subject.COPILOT, [started, submit, first, confirm])).toEqual([
      { label: 'Question filled in on Copilot', state: 'done', time: '—' },
      { label: 'You pressed Enter', state: 'done', time: '20:32:05.118Z' },
      { label: 'First response', state: 'done', time: '+6,204 ms' },
      { label: 'Answer stopped changing', state: 'done', time: '+14,377 ms' },
    ])
  })

  it("walks the Oracle's three steps", () => {
    const started = event(Subject.DOE_ORACLE, 'started', 0)
    expect(trialSteps(Subject.DOE_ORACLE, [started]).map((step) => step.state)).toEqual(['current', 'pending', 'pending'])
    expect(trialSteps(Subject.DOE_ORACLE, [started, event(Subject.DOE_ORACLE, 'first_response', 1_107)])).toEqual([
      { label: 'Question typed and sent', state: 'done', time: '—' },
      { label: 'First response', state: 'done', time: '+1,107 ms' },
      { label: 'Answer complete', state: 'current', time: '' },
    ])
  })
})

describe('timerCaption', () => {
  const copilot = { timeoutMs: 60_000, startsAt: 'submit' as const, confirmEnd: true, answerFound: false, answerLimitMs: null }

  it('draws the bar against the limit when the limit counts from the trial start', () => {
    expect(timerCaption(limit60, false)).toEqual({ text: 'of 60 s limit', showProgress: true })
  })

  it('says so, and draws no bar, when the limit counts from the Enter', () => {
    expect(timerCaption(copilot, false)).toEqual({
      text: 'since the trial started · the 60 s limit runs from your Enter',
      showProgress: false,
    })
  })

  it('draws the bar against the limit once the response is measured, whichever clock the limit uses', () => {
    expect(timerCaption(copilot, true)).toEqual({ text: 'response time, of 60 s limit', showProgress: true })
  })

  it('draws no bar before the limits are known', () => {
    expect(timerCaption(undefined, false)).toEqual({ text: 'since the trial started', showProgress: false })
  })
})

describe('the copy step, after an Answer Found whose highlight could not be read', () => {
  const beginMs = 1_000_000
  const copying = event(Subject.GOOGLE, 'awaiting_copied_text', 40_000, {
    beginMs,
    endMs: beginMs + 812,
    answerFoundMs: beginMs + 38_400,
    sourceUrl: 'https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=50944',
  })

  it('shows the page load, the time to answer of the Answer Found click, and the page the text comes from', () => {
    expect(copyStep(copying)).toEqual({
      pageLoadMs: 812,
      timeToAnswerMs: 38_400,
      sourceUrl: 'https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=50944',
    })
  })

  it('is not shown for any other status, and stops the searching time', () => {
    expect(copyStep(event(Subject.GOOGLE, 'awaiting_confirmation', 1, { beginMs, endMs: beginMs + 812 }))).toBeNull()
    expect(copyStep(undefined)).toBeNull()
    expect(searchTimes(copying, googleLimit, beginMs + 90_000)).toBeNull()
  })

  it('shows dashes for times the event does not carry', () => {
    expect(copyStep(event(Subject.GOOGLE, 'awaiting_copied_text', 1))).toEqual({ pageLoadMs: null, timeToAnswerMs: null, sourceUrl: null })
  })

  it('tells the Tester to copy the text and that nothing is timed', () => {
    const banner = waitingBanner(copying, googleLimit)
    expect(banner?.title).toBe('The highlighted text could not be read')
    expect(banner?.message).toMatch(/copy the highlighted text \(Ctrl\+C, or Cmd\+C on a Mac\), then click Use Copied Text/)
    expect(banner?.message).toMatch(/no time limit on this step/)
  })

  it("keeps Google's four steps checked off", () => {
    const events = [
      event(Subject.GOOGLE, 'started', 0),
      event(Subject.GOOGLE, 'awaiting_submit', 900),
      event(Subject.GOOGLE, 'first_response', 1_200),
      event(Subject.GOOGLE, 'awaiting_confirmation', 1_900, { beginMs, endMs: beginMs + 812 }),
      copying,
    ]
    expect(trialSteps(Subject.GOOGLE, events).map((step) => step.state)).toEqual(['done', 'done', 'done', 'done'])
  })
})

describe('waitingBanner', () => {
  it("asks for the Tester's Enter", () => {
    expect(waitingBanner(event(Subject.COPILOT, 'awaiting_submit', 1, { message: 'Press Enter in the Copilot window' }))).toEqual({
      title: 'Your turn in the Microsoft Copilot window',
      message: 'Press Enter in the Copilot window',
    })
  })

  it('asks to confirm the end, with the detected response time', () => {
    expect(waitingBanner(event(Subject.COPILOT, 'awaiting_confirmation', 1, { beginMs: 1_000, endMs: 10_377 }))).toEqual({
      title: 'Microsoft Copilot stopped streaming',
      message:
        'Check the answer in the browser window. Confirm it is complete, or use Adjust if it was still loading. The detected response time is 9.377 s from your Enter.',
    })
  })

  it('shows nothing while the trial waits on nobody', () => {
    expect(waitingBanner(event(Subject.DOE_ORACLE, 'first_response', 1))).toBeNull()
    expect(waitingBanner(undefined)).toBeNull()
  })
})

describe('sessionSummary', () => {
  it('counts the trials and the failed ones, as in the design', () => {
    const failed = trial({ status: TrialStatus.FAILED, failure: { type: FailureType.TIMEOUT, message: 'x', elapsedMs: 60_000 } })
    expect(sessionSummary([trial(), trial(), trial(), failed])).toBe('4 trials · 1 failed')
    expect(sessionSummary([trial()])).toBe('1 trial')
    expect(sessionSummary([])).toBe('No trials yet in this session.')
  })
})

describe('trialBadge and failureTitle', () => {
  const timeout = { type: FailureType.TIMEOUT, message: 'No answer within 60000 ms', elapsedMs: 60_000 }

  it('shows Success, the failure type, or No answer found', () => {
    expect(trialBadge(trial())).toEqual({ label: 'Success', tone: 'success' })
    expect(trialBadge(trial({ status: TrialStatus.FAILED, failure: timeout }))).toEqual({ label: 'Timeout', tone: 'danger' })
    expect(trialBadge(trial({ status: TrialStatus.NO_ANSWER_FOUND }))).toEqual({ label: 'No answer found', tone: 'warning' })
  })

  it("says a timeout in the limit's words, and any other failure with its message", () => {
    expect(failureTitle(timeout, limit60)).toBe('Timeout: no answer within 60 s')
    expect(failureTitle({ type: FailureType.UNREACHABLE, message: 'net::ERR_CONNECTION_REFUSED', elapsedMs: 300 }, limit60)).toBe(
      'Unreachable: net::ERR_CONNECTION_REFUSED',
    )
  })
})

describe('the result card text', () => {
  it('titles the trial with its test number and subject', () => {
    expect(trialTitle(trial())).toBe('Trial #7 · DOE Oracle')
  })

  it('formats times as the design does', () => {
    expect(formatMs(4_812)).toBe('4,812 ms')
    expect(formatMs(60_000)).toBe('60,000 ms')
    expect(formatMs(null)).toBe('—')
    expect(clockTime('2026-11-19T20:44:02.331Z')).toBe('20:44:02.331Z')
    expect(clockTime(null)).toBe('—')
  })

  it('gives the size in KB with 2 decimals, and the keywords or that there are none yet', () => {
    expect(recordDetails(trial())).toBe('Size 0.33 KB · Keywords: none yet')
    expect(recordDetails(trial({ keywords: 'exhaustive, combinatorial, testing' }))).toBe('Size 0.33 KB · Keywords: exhaustive, combinatorial, testing')
  })

  it('cuts a long answer to a preview', () => {
    expect(answerPreview('x'.repeat(500))).toBe(`${'x'.repeat(400)}…`)
    expect(answerPreview(null)).toBe('(no answer text)')
  })
})

describe('nextQuestionNumber', () => {
  it('moves on after a result, no answer found included, and stays after a failure', () => {
    expect(nextQuestionNumber({ status: TrialStatus.SUCCESS, questionNumber: 4 }, 12)).toBe(5)
    expect(nextQuestionNumber({ status: TrialStatus.NO_ANSWER_FOUND, questionNumber: 4 }, 12)).toBe(5)
    expect(nextQuestionNumber({ status: TrialStatus.FAILED, questionNumber: 4 }, 12)).toBe(4)
  })

  it('stays on the last question', () => {
    expect(nextQuestionNumber({ status: TrialStatus.SUCCESS, questionNumber: 12 }, 12)).toBe(12)
  })
})

describe('adjustedEndMs', () => {
  it('turns seconds after the Enter into epoch milliseconds', () => {
    expect(adjustedEndMs(1_000, '8.950')).toBe(9_950)
    expect(adjustedEndMs(1_000, '0')).toBe(1_000)
  })

  it('refuses text that is not a number of seconds, 0 or more', () => {
    expect(adjustedEndMs(1_000, '')).toBeNull()
    expect(adjustedEndMs(1_000, 'soon')).toBeNull()
    expect(adjustedEndMs(1_000, '-1')).toBeNull()
  })
})
