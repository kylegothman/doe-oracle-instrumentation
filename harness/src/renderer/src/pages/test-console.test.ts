import { describe, expect, it } from 'vitest'
import { FailureType } from '../../../shared/failures'
import { Subject } from '../../../shared/subjects'
import { TrialStatus, type Trial, type TrialEvent } from '../../../shared/trials'
import {
  adjustedEndMs,
  answerPreview,
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

const limit60 = { timeoutMs: 60_000, startsAt: 'trial_start' as const, confirmEnd: false }

describe('SUBJECT_CHOICES', () => {
  it('offers the three subjects, with Google off until E5', () => {
    expect(SUBJECT_CHOICES).toEqual([
      { value: Subject.DOE_ORACLE, label: 'DOE Oracle', disabled: false },
      { value: Subject.COPILOT, label: 'Microsoft Copilot', disabled: false },
      { value: Subject.GOOGLE, label: 'Google Search (arrives with E5)', disabled: true },
    ])
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
  const copilot = { timeoutMs: 60_000, startsAt: 'submit' as const, confirmEnd: true }

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

describe('waitingBanner', () => {
  it("asks for the Tester's Enter", () => {
    expect(waitingBanner(event(Subject.COPILOT, 'awaiting_submit', 1, { message: 'Press Enter in the Copilot window' }))).toEqual({
      title: 'Press Enter in the Microsoft Copilot window',
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
  it('moves on after a success and stays after anything else', () => {
    expect(nextQuestionNumber({ status: TrialStatus.SUCCESS, questionNumber: 4 }, 12)).toBe(5)
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
