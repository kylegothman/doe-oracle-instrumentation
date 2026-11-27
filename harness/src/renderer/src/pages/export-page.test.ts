import { describe, expect, it } from 'vitest'
import type { ExportResult } from '../../../shared/export'
import { Subject } from '../../../shared/subjects'
import type { TrialEvent } from '../../../shared/trials'
import {
  buildFilter,
  exportsEverySession,
  describeExport,
  describeMatches,
  describePendingSaves,
  describeRetry,
  endsTrial,
  runningTrialWarning,
  sessionLabel,
  SUBJECT_CHOICES,
  toDayValue,
  type FilterInput,
} from './export-page'

const bySession: FilterInput = { mode: 'session', sessionId: 'session-a', fromDay: '', toDay: '', subject: 'ALL' }
const byRange: FilterInput = { mode: 'range', sessionId: null, fromDay: '2026-11-10', toDay: '2026-11-14', subject: 'ALL' }

/** Local midnight of a day, as the ISO timestamp the filter carries. */
const midnight = (year: number, month: number, day: number): string => new Date(year, month - 1, day).toISOString()

describe('buildFilter', () => {
  it('filters by the chosen session only, with no dates', () => {
    expect(buildFilter(bySession)).toEqual({ ok: true, filter: { sessionId: 'session-a', from: null, to: null, subject: null } })
  })

  it('passes the subject through, and EXPERT for only the expert answers', () => {
    expect(buildFilter({ ...bySession, subject: Subject.COPILOT })).toMatchObject({ filter: { subject: Subject.COPILOT } })
    expect(buildFilter({ ...bySession, subject: 'EXPERT' })).toMatchObject({ filter: { subject: 'EXPERT' } })
  })

  it('exports the expert answers from every session in Session mode, so a restart does not hide them (TC-UC5-07)', () => {
    const expertOnly = { sessionId: null, from: null, to: null, subject: 'EXPERT' }
    expect(buildFilter({ ...bySession, subject: 'EXPERT' })).toEqual({ ok: true, filter: expertOnly })
    // Even before any session is listed: the answers do not depend on one.
    expect(buildFilter({ ...bySession, sessionId: null, subject: 'EXPERT' })).toEqual({ ok: true, filter: expertOnly })
    // Every other subject choice still keeps to the chosen session.
    expect(buildFilter({ ...bySession, subject: 'ALL' })).toMatchObject({ filter: { sessionId: 'session-a' } })
    expect(buildFilter({ ...bySession, subject: Subject.DOE_ORACLE })).toMatchObject({ filter: { sessionId: 'session-a' } })
  })

  it('still narrows the expert answers by a date range', () => {
    expect(buildFilter({ ...byRange, subject: 'EXPERT' })).toEqual({
      ok: true,
      filter: { sessionId: null, from: midnight(2026, 11, 10), to: midnight(2026, 11, 15), subject: 'EXPERT' },
    })
  })

  it('says when the session is ignored: only for the expert answers in Session mode', () => {
    expect(exportsEverySession({ mode: 'session', subject: 'EXPERT' })).toBe(true)
    expect(exportsEverySession({ mode: 'range', subject: 'EXPERT' })).toBe(false)
    expect(exportsEverySession({ mode: 'session', subject: 'ALL' })).toBe(false)
    expect(exportsEverySession({ mode: 'session', subject: Subject.GOOGLE })).toBe(false)
  })

  it('asks for a session when none is saved', () => {
    expect(buildFilter({ ...bySession, sessionId: null })).toEqual({ ok: false, problem: 'No session has been saved yet.' })
  })

  it('covers whole local days, both included: from the first midnight to the midnight after the last day', () => {
    expect(buildFilter(byRange)).toEqual({
      ok: true,
      filter: { sessionId: null, from: midnight(2026, 11, 10), to: midnight(2026, 11, 15), subject: null },
    })
  })

  it('ignores the session in a date range', () => {
    expect(buildFilter({ ...byRange, sessionId: 'session-a' })).toMatchObject({ filter: { sessionId: null } })
  })

  it('accepts a single day and an open end on either side', () => {
    expect(buildFilter({ ...byRange, toDay: '2026-11-10' })).toMatchObject({ filter: { from: midnight(2026, 11, 10), to: midnight(2026, 11, 11) } })
    expect(buildFilter({ ...byRange, fromDay: '' })).toMatchObject({ filter: { from: null, to: midnight(2026, 11, 15) } })
    expect(buildFilter({ ...byRange, toDay: '' })).toMatchObject({ filter: { from: midnight(2026, 11, 10), to: null } })
  })

  it('rolls the last day over a month and a year end', () => {
    expect(buildFilter({ ...byRange, fromDay: '2026-12-31', toDay: '2026-12-31' })).toMatchObject({
      filter: { from: midnight(2026, 12, 31), to: midnight(2027, 1, 1) },
    })
  })

  it('refuses a first day after the last day, and a day that does not exist', () => {
    expect(buildFilter({ ...byRange, fromDay: '2026-11-15', toDay: '2026-11-14' })).toEqual({
      ok: false,
      problem: 'The first day is after the last day.',
    })
    expect(buildFilter({ ...byRange, fromDay: '2026-02-31' })).toMatchObject({ ok: false })
    expect(buildFilter({ ...byRange, toDay: '14/11/2026' })).toMatchObject({ ok: false })
  })
})

describe('toDayValue', () => {
  it('gives the local day as YYYY-MM-DD, padded', () => {
    expect(toDayValue(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})

describe('sessionLabel', () => {
  const now = new Date(2026, 10, 19, 18, 30)
  const at = (year: number, month: number, day: number, hour: number, minute: number) =>
    new Date(year, month - 1, day, hour, minute).toISOString()
  const session = (startedAt: string) => ({ sessionId: '7f3c9a2e-1111-2222-3333-444455556666', startedAt, appVersion: '0.2.0' })

  it('shows the short ID with today, yesterday, or the date, and the local start time', () => {
    expect(sessionLabel(session(at(2026, 11, 19, 9, 5)), now, null)).toBe('7f3c9a2e · today 09:05')
    expect(sessionLabel(session(at(2026, 11, 18, 23, 59)), now, null)).toBe('7f3c9a2e · yesterday 23:59')
    expect(sessionLabel(session(at(2026, 11, 2, 14, 0)), now, null)).toBe('7f3c9a2e · 2026-11-02 14:00')
  })

  it('marks the running session', () => {
    const running = session(at(2026, 11, 19, 18, 0))
    expect(sessionLabel(running, now, running.sessionId)).toBe('7f3c9a2e · today 18:00 (this session)')
  })
})

describe('describeMatches', () => {
  it('counts trials and expert answers, as in the design', () => {
    expect(describeMatches({ trials: 8, expertAnswers: 12 })).toBe('20 records match: 8 trials and 12 expert answers.')
  })

  it('uses the singular for one', () => {
    expect(describeMatches({ trials: 1, expertAnswers: 0 })).toBe('1 record matches: 1 trial and 0 expert answers.')
    expect(describeMatches({ trials: 0, expertAnswers: 1 })).toBe('1 record matches: 0 trials and 1 expert answer.')
  })

  it('says to change the filter when nothing matches', () => {
    expect(describeMatches({ trials: 0, expertAnswers: 0 })).toBe('No records match. Change the filter to export.')
  })
})

describe('describeExport', () => {
  const result = (overrides: Partial<ExportResult>): ExportResult => ({
    ok: true,
    status: 'EXPORTED',
    filePaths: [],
    rowCount: 0,
    error: null,
    ...overrides,
  })

  it('says how many rows were written and where', () => {
    expect(describeExport(result({ filePaths: ['C:\\Users\\Tester\\Documents\\TestLog-2026-11-19.xlsx'], rowCount: 20 }))).toEqual({
      tone: 'success',
      title: 'Exported 20 rows',
      message: 'Saved to C:\\Users\\Tester\\Documents\\TestLog-2026-11-19.xlsx. Copy it to the project OneDrive folder.',
    })
  })

  it('names both CSV files', () => {
    expect(describeExport(result({ filePaths: ['a.csv', 'a-supplementary.csv'], rowCount: 1 }))).toEqual({
      tone: 'success',
      title: 'Exported 1 row',
      message: 'Saved to a.csv and a-supplementary.csv. Copy them to the project OneDrive folder.',
    })
  })

  it("shows the service's reason when nothing matched or the file could not be written", () => {
    expect(describeExport(result({ ok: false, status: 'NOTHING_TO_EXPORT', error: 'Nothing to export.' }))).toEqual({
      tone: 'warning',
      title: 'Nothing to export',
      message: 'Nothing to export.',
    })
    expect(describeExport(result({ ok: false, status: 'WRITE_FAILED', error: 'Could not write x.xlsx.' }))).toEqual({
      tone: 'danger',
      title: 'The file was not saved',
      message: 'Could not write x.xlsx.',
    })
  })

  it('says nothing when the Tester cancelled the save dialog', () => {
    expect(describeExport(result({ ok: false, status: 'CANCELLED' }))).toBeNull()
  })
})

describe('describePendingSaves and describeRetry', () => {
  it('counts the saves waiting for a retry', () => {
    expect(describePendingSaves(1)).toBe('1 save is waiting for a retry')
    expect(describePendingSaves(3)).toBe('3 saves are waiting for a retry')
  })

  it('says whether all, none, or some of the waiting saves went through', () => {
    expect(describeRetry(1, 1)).toEqual({ tone: 'success', title: 'The waiting save went through.' })
    expect(describeRetry(3, 3)).toEqual({ tone: 'success', title: 'All 3 waiting saves went through.' })
    expect(describeRetry(3, 0)).toEqual({ tone: 'danger', title: 'No waiting save went through. The database still refuses them.' })
    expect(describeRetry(3, 1)).toEqual({ tone: 'danger', title: '1 of 3 waiting saves went through. The rest are still waiting.' })
  })
})

describe('runningTrialWarning and endsTrial', () => {
  const event = (status: TrialEvent['status']): TrialEvent => ({ trialId: 't', subject: Subject.COPILOT, questionNumber: 2, status, elapsedMs: 1 })

  it('warns that a running trial is not in the export yet', () => {
    for (const status of ['started', 'awaiting_submit', 'first_response'] as const) {
      expect(runningTrialWarning(event(status))).toEqual({
        title: 'A Microsoft Copilot trial is running',
        message: 'Q2 is saved when it ends, so it is not in this export yet. Wait for it on the Test Console, then export.',
      })
    }
  })

  it('says a trial waiting for confirmation is not saved until it is confirmed', () => {
    expect(runningTrialWarning(event('awaiting_confirmation'))).toEqual({
      title: 'A Microsoft Copilot trial is waiting for you to confirm it',
      message: 'Q2 is not saved until you click Confirm Completion on the Test Console, so it is not in this export yet.',
    })
  })

  it("says a Google trial waits for the Tester's Answer Found or No Answer Found", () => {
    expect(runningTrialWarning({ ...event('awaiting_confirmation'), subject: Subject.GOOGLE })).toEqual({
      title: 'A Google Search trial is waiting for your answer',
      message: 'Q2 is not saved until you click Answer Found or No Answer Found on the Test Console, so it is not in this export yet.',
    })
  })

  it('says a Google trial on the copy step is not saved until the copied text is confirmed', () => {
    expect(runningTrialWarning({ ...event('awaiting_copied_text'), subject: Subject.GOOGLE })).toEqual({
      title: 'A Google Search trial is waiting for the text you copied',
      message:
        'Q2 is not saved until you confirm the copied text, or click No Answer Found, on the Test Console, so it is not in this export yet.',
    })
    expect(endsTrial(event('awaiting_copied_text'))).toBe(false)
  })

  it('warns of nothing once the trial has ended, or before any trial', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'aborted'] as const) {
      expect(runningTrialWarning(event(status))).toBeNull()
      expect(endsTrial(event(status))).toBe(true)
    }
    expect(runningTrialWarning(undefined)).toBeNull()
    expect(endsTrial(event('awaiting_confirmation'))).toBe(false)
  })
})

describe('SUBJECT_CHOICES', () => {
  it('offers all subjects, each subject, and the expert answers alone', () => {
    expect(SUBJECT_CHOICES.map((choice) => choice.value)).toEqual(['ALL', Subject.DOE_ORACLE, Subject.COPILOT, Subject.GOOGLE, 'EXPERT'])
  })
})
