import { describe, expect, it } from 'vitest'
import { ResponseSource, type Expert, type ExpertResponse } from '../../shared/experts'
import { FailureType } from '../../shared/failures'
import { Subject } from '../../shared/subjects'
import { TrialStatus, type Trial } from '../../shared/trials'
import { toExportRows } from './export-rows'
import type { ExportRecord } from './metrics-repository'

function trial(overrides: Partial<Trial> = {}): Trial {
  return {
    trialId: 't1',
    testNumber: 1,
    sessionId: 'session-a',
    dataSetName: 'DOE_ORACLE-2026-11-14',
    subject: Subject.DOE_ORACLE,
    questionNumber: 1,
    status: TrialStatus.SUCCESS,
    beginTs: '2026-11-14T11:00:00.000Z',
    firstResponseTs: '2026-11-14T11:00:00.300Z',
    endTs: '2026-11-14T11:00:01.500Z',
    responseMs: 1_500,
    firstResponseMs: 300,
    answerText: 'Combinatorial testing covers t-way interactions.',
    citations: ['paper-a.pdf · p.3', 'paper-b.pdf · p.12'],
    pageLoadMs: null,
    timeToAnswerMs: null,
    sourceUrl: null,
    sizeBytes: 2_048,
    keywords: null,
    ...overrides,
  }
}

const trialRecord = (t: Trial): ExportRecord => ({ kind: 'TRIAL', testNumber: t.testNumber, trial: t })

const wong: Expert = {
  expertId: 'expert-1',
  name: 'Dr. Wong',
  source: ResponseSource.EMAIL,
  outreachTs: '2026-10-06T15:00:00.000Z',
  firstAnswerTs: '2026-11-03T09:30:00.000Z',
  turnaroundMs: 2_399_400_000,
}

function answer(testNumber: number, questionNumber: number, overrides: Partial<ExpertResponse> = {}): ExportRecord {
  return {
    kind: 'EXPERT',
    testNumber,
    expert: wong,
    response: {
      responseId: testNumber,
      testNumber,
      expertId: wong.expertId,
      sessionId: 'session-b',
      questionNumber,
      answerText: `Answer ${questionNumber}.`,
      sizeBytes: 1_000,
      keywords: null,
      recordedAt: '2026-11-14T12:00:00.000Z',
      supersededBy: null,
      ...overrides,
    },
  }
}

describe('toExportRows', () => {
  it('maps a trial to the 11 TestLogV3 columns, with the session ID as User Email and the UI label as Test Subject', () => {
    const { main } = toExportRows([trialRecord(trial())])

    expect(main).toEqual([
      {
        testNumber: 1,
        questionNumber: 1,
        testSubject: 'DOE Oracle',
        dataSetName: 'DOE_ORACLE-2026-11-14',
        answerText: 'Combinatorial testing covers t-way interactions.',
        responseMs: 1_500,
        userEmail: 'session-a',
        beginTs: '2026-11-14T11:00:00.000Z',
        endTs: '2026-11-14T11:00:01.500Z',
        keywords: null,
        sizeKb: 2,
      },
    ])
  })

  it('labels each subject the way the UI does', () => {
    const { main } = toExportRows([
      trialRecord(trial({ testNumber: 1, subject: Subject.DOE_ORACLE })),
      trialRecord(trial({ testNumber: 2, subject: Subject.COPILOT })),
      trialRecord(trial({ testNumber: 3, subject: Subject.GOOGLE })),
    ])

    expect(main.map((row) => row.testSubject)).toEqual(['DOE Oracle', 'Microsoft Copilot', 'Google Search'])
  })

  it("uses Google's page-load time as its Response Milliseconds", () => {
    const google = trial({ subject: Subject.GOOGLE, responseMs: 9_999, pageLoadMs: 812, timeToAnswerMs: 14_250 })

    expect(toExportRows([trialRecord(google)]).main[0]?.responseMs).toBe(812)
  })

  it('rounds Size Kbytes to 2 decimals of bytes / 1024', () => {
    const sizes = [0, 1, 1_000, 1_024, 1_536, 12_345].map((sizeBytes, i) => trial({ testNumber: i + 1, sizeBytes }))

    expect(toExportRows(sizes.map(trialRecord)).main.map((row) => row.sizeKb)).toEqual([0, 0, 0.98, 1, 1.5, 12.06])
  })

  it('keeps the timings a failed trial reached, leaves the rest empty, and puts its failure type on the supplementary row', () => {
    const failed = trial({
      status: TrialStatus.FAILED,
      endTs: null,
      responseMs: null,
      answerText: null,
      citations: [],
      sizeBytes: 0,
      failure: { type: FailureType.TIMEOUT, message: 'No answer within 60 s', elapsedMs: 60_000 },
    })

    const { main, extra } = toExportRows([trialRecord(failed)])

    expect(main[0]).toMatchObject({ beginTs: '2026-11-14T11:00:00.000Z', endTs: null, responseMs: null, answerText: null, sizeKb: 0 })
    expect(extra[0]).toMatchObject({ firstResponseMs: 300, failureType: FailureType.TIMEOUT, citations: null })
  })

  it('puts the extra trial fields on the supplementary row, with citations joined by "; "', () => {
    const google = trial({
      subject: Subject.GOOGLE,
      pageLoadMs: 812,
      timeToAnswerMs: 14_250,
      sourceUrl: 'https://csrc.nist.gov/projects/automated-combinatorial-testing-for-software',
    })

    const { extra } = toExportRows([trialRecord(trial()), trialRecord({ ...google, testNumber: 2 })])

    expect(extra).toEqual([
      {
        testNumber: 1,
        firstResponseMs: 300,
        pageLoadMs: null,
        timeToAnswerMs: null,
        sourceUrl: null,
        citations: 'paper-a.pdf · p.3; paper-b.pdf · p.12',
        failureType: null,
        responseSource: null,
      },
      {
        testNumber: 2,
        firstResponseMs: 300,
        pageLoadMs: 812,
        timeToAnswerMs: 14_250,
        sourceUrl: 'https://csrc.nist.gov/projects/automated-combinatorial-testing-for-software',
        citations: 'paper-a.pdf · p.3; paper-b.pdf · p.12',
        failureType: null,
        responseSource: null,
      },
    ])
  })

  it('maps an expert answer with Test Subject "Expert", a data set named for the first answer date, and its session as User Email', () => {
    const { main, extra } = toExportRows([answer(5, 1)])

    expect(main[0]).toEqual({
      testNumber: 5,
      questionNumber: 1,
      testSubject: 'Expert',
      dataSetName: 'EXPERT-2026-11-03',
      answerText: 'Answer 1.',
      responseMs: 2_399_400_000,
      userEmail: 'session-b',
      beginTs: '2026-10-06T15:00:00.000Z',
      endTs: '2026-11-03T09:30:00.000Z',
      keywords: null,
      sizeKb: 0.98,
    })
    expect(extra[0]).toEqual({
      testNumber: 5,
      firstResponseMs: null,
      pageLoadMs: null,
      timeToAnswerMs: null,
      sourceUrl: null,
      citations: null,
      failureType: null,
      responseSource: ResponseSource.EMAIL,
    })
  })

  it("puts the turnaround only on the expert's lowest question number, whatever order the rows come in", () => {
    // Test # order puts question 3 first, as when it was entered first.
    const { main } = toExportRows([answer(10, 3), answer(11, 1), answer(12, 2)])

    expect(main.map((row) => [row.questionNumber, row.responseMs, row.beginTs, row.endTs])).toEqual([
      [3, null, null, null],
      [1, 2_399_400_000, '2026-10-06T15:00:00.000Z', '2026-11-03T09:30:00.000Z'],
      [2, null, null, null],
    ])
  })

  it('names the data set just EXPERT and leaves the timing empty while the reply date is not entered', () => {
    const pending = answer(1, 1)
    if (pending.kind === 'EXPERT') pending.expert = { ...wong, firstAnswerTs: null, turnaroundMs: null }

    expect(toExportRows([pending]).main[0]).toMatchObject({ dataSetName: 'EXPERT', responseMs: null, endTs: null })
  })

  it('keeps trials and expert answers in the order given', () => {
    const { main, extra } = toExportRows([trialRecord(trial({ testNumber: 1 })), answer(2, 1), trialRecord(trial({ testNumber: 3 }))])

    expect(main.map((row) => row.testNumber)).toEqual([1, 2, 3])
    expect(extra.map((row) => row.testNumber)).toEqual([1, 2, 3])
  })

  it('returns no rows for no records', () => {
    expect(toExportRows([])).toEqual({ main: [], extra: [] })
  })
})
