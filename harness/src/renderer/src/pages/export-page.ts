import { ExportFormat, type ExportPreview, type ExportResult, type RecordFilter } from '../../../shared/export'
import type { Session } from '../../../shared/session'
import { SUBJECTS, SUBJECT_LABELS, Subject } from '../../../shared/subjects'
import type { TrialEvent } from '../../../shared/trials'

/**
 * What the Export Page (story #40, UC-6) works out without the bridge: the
 * filter it sends, the labels it shows, and how it reports an export. Kept
 * apart from the page so it can be tested without a window.
 */

/** How the Tester narrows the records: one session, or a range of days. */
export type FilterMode = 'session' | 'range'

/** The subject dropdown's value: every subject, one subject, or only the expert's answers. */
export type SubjectChoice = 'ALL' | Subject | 'EXPERT'

export const SUBJECT_CHOICES: ReadonlyArray<{ value: SubjectChoice; label: string }> = [
  { value: 'ALL', label: 'All subjects' },
  ...SUBJECTS.map((subject) => ({ value: subject, label: SUBJECT_LABELS[subject] })),
  { value: 'EXPERT', label: 'Expert answers only' },
]

export const FORMAT_CHOICES: ReadonlyArray<{ value: ExportFormat; label: string; description: string }> = [
  {
    value: ExportFormat.TESTLOG_V3_XLSX,
    label: 'TestLogV3 workbook (.xlsx)',
    description:
      'Sheet 1 matches the TestLogV3 layout column for column. Sheet 2 holds first-response time, Google timings, source URL, failure type and response source.',
  },
  {
    value: ExportFormat.CSV,
    label: 'CSV (.csv)',
    description: 'The same 11 columns. Extra fields go to a second file ending in -supplementary.csv.',
  },
]

export interface FilterInput {
  mode: FilterMode
  /** The chosen session, or null when no session is saved yet. */
  sessionId: string | null
  /** First and last day of the range, inclusive, as the date inputs give them (YYYY-MM-DD, local). Empty means open. */
  fromDay: string
  toDay: string
  subject: SubjectChoice
}

/** The filter to send, or what the Tester must fix first. */
export type FilterOutcome = { ok: true; filter: RecordFilter } | { ok: false; problem: string }

/**
 * Builds the export filter from the page. A range covers whole local days,
 * both ends included: from the start of the first day to the start of the
 * day after the last, which is how the repository's exclusive `to` works.
 */
export function buildFilter(input: FilterInput): FilterOutcome {
  const subject = input.subject === 'ALL' ? null : input.subject
  if (input.mode === 'session') {
    if (input.sessionId === null) return { ok: false, problem: 'No session has been saved yet.' }
    return { ok: true, filter: { sessionId: input.sessionId, from: null, to: null, subject } }
  }
  const from = input.fromDay === '' ? null : startOfDay(input.fromDay, 0)
  const to = input.toDay === '' ? null : startOfDay(input.toDay, 1)
  if (from === undefined || to === undefined) return { ok: false, problem: 'Enter the dates as shown in the date picker.' }
  if (from !== null && to !== null && from >= to) return { ok: false, problem: 'The first day is after the last day.' }
  return { ok: true, filter: { sessionId: null, from, to, subject } }
}

/** Local midnight of a YYYY-MM-DD day plus `addDays`, as an ISO 8601 UTC timestamp; undefined if the day is not valid. */
function startOfDay(day: string, addDays: number): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return undefined
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const start = new Date(year, month - 1, date + addDays)
  // new Date rolls 2026-02-31 over into March; refuse it instead.
  const check = new Date(year, month - 1, date)
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== date) return undefined
  return start.toISOString()
}

/** A local day as YYYY-MM-DD, the value a date input takes. */
export function toDayValue(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-')
}

/**
 * How a session is listed: the first 8 characters of its ID and when it
 * started, in local time, for example "7f3c9a2e · today 14:05". The running
 * session is marked, since it is the one the Tester usually wants.
 */
export function sessionLabel(session: Session, now: Date, currentSessionId: string | null): string {
  const started = new Date(session.startedAt)
  const time = [started.getHours(), started.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':')
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const day =
    toDayValue(started) === toDayValue(now) ? 'today' : toDayValue(started) === toDayValue(yesterday) ? 'yesterday' : toDayValue(started)
  const current = session.sessionId === currentSessionId ? ' (this session)' : ''
  return `${session.sessionId.slice(0, 8)} · ${day} ${time}${current}`
}

/** The line under the filters, for example "20 records match: 8 trials and 12 expert answers." */
export function describeMatches(preview: ExportPreview): string {
  const total = preview.trials + preview.expertAnswers
  if (total === 0) return 'No records match. Change the filter to export.'
  const records = total === 1 ? '1 record matches' : `${total} records match`
  return `${records}: ${plural(preview.trials, 'trial')} and ${plural(preview.expertAnswers, 'expert answer')}.`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The title of the warning shown while saves are waiting for a retry. Those
 * records are not in the database, so an export would leave them out.
 */
export function describePendingSaves(count: number): string {
  return count === 1 ? '1 save is waiting for a retry' : `${count} saves are waiting for a retry`
}

/** What to say after Retry: how many of the waiting saves went through. */
export function describeRetry(waiting: number, saved: number): { tone: 'success' | 'danger'; title: string } {
  if (saved === waiting) return { tone: 'success', title: saved === 1 ? 'The waiting save went through.' : `All ${saved} waiting saves went through.` }
  if (saved === 0) return { tone: 'danger', title: 'No waiting save went through. The database still refuses them.' }
  return { tone: 'danger', title: `${saved} of ${waiting} waiting saves went through. The rest are still waiting.` }
}

/**
 * The warning shown while a trial is under way, from the latest trial
 * event. A trial is saved only when it ends (for Copilot, after the Tester
 * confirms the end), so until then it is in no export. Null when no trial
 * is under way.
 */
export function runningTrialWarning(latest: TrialEvent | undefined): { title: string; message: string } | null {
  if (!latest) return null
  const subject = SUBJECT_LABELS[latest.subject]
  switch (latest.status) {
    case 'started':
    case 'awaiting_submit':
    case 'first_response':
      return {
        title: `A ${subject} trial is running`,
        message: `Q${latest.questionNumber} is saved when it ends, so it is not in this export yet. Wait for it on the Test Console, then export.`,
      }
    case 'awaiting_confirmation':
      if (latest.subject === Subject.GOOGLE) {
        return {
          title: `A ${subject} trial is waiting for your answer`,
          message: `Q${latest.questionNumber} is not saved until you click Answer Found or No Answer Found on the Test Console, so it is not in this export yet.`,
        }
      }
      return {
        title: `A ${subject} trial is waiting for you to confirm it`,
        message: `Q${latest.questionNumber} is not saved until you click Confirm Completion on the Test Console, so it is not in this export yet.`,
      }
    case 'awaiting_copied_text':
      return {
        title: `A ${subject} trial is waiting for the text you copied`,
        message: `Q${latest.questionNumber} is not saved until you confirm the copied text, or click No Answer Found, on the Test Console, so it is not in this export yet.`,
      }
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'aborted':
      return null
  }
}

/** True when the event ends a trial: one was saved (completed, failed) or none will be (cancelled, aborted). */
export function endsTrial(event: TrialEvent): boolean {
  return event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled' || event.status === 'aborted'
}

/** What the banner under the format card says after an export. Null when there is nothing to say. */
export type ExportOutcome = { tone: 'success' | 'warning' | 'danger'; title: string; message: string } | null

export function describeExport(result: ExportResult): ExportOutcome {
  switch (result.status) {
    case 'EXPORTED': {
      const rows = result.rowCount === 1 ? '1 row' : `${result.rowCount} rows`
      const files = result.filePaths.join(' and ')
      const them = result.filePaths.length > 1 ? 'them' : 'it'
      return { tone: 'success', title: `Exported ${rows}`, message: `Saved to ${files}. Copy ${them} to the project OneDrive folder.` }
    }
    case 'NOTHING_TO_EXPORT':
      return { tone: 'warning', title: 'Nothing to export', message: result.error ?? 'No records match this filter.' }
    case 'WRITE_FAILED':
      return { tone: 'danger', title: 'The file was not saved', message: result.error ?? 'The export could not be written.' }
    case 'CANCELLED':
      // The Tester closed the save dialog: nothing happened, and nothing needs saying.
      return null
  }
}
