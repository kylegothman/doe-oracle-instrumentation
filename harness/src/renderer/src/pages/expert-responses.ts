import { turnaroundMs, type ExpertField, type ExpertInput } from '../../../shared/expert-entry'
import { ResponseSource, type Expert } from '../../../shared/experts'

/**
 * What the Expert Responses page (stories #41 to #43, UC-5) works out
 * without the bridge: the form it shows for an expert, the local times it
 * turns into stored timestamps and back, and the turnaround as the
 * Researcher reads it. The rules for what may be
 * saved live in the main process's ExpertRecordService; this file only
 * prepares what is sent and describes what comes back. Kept apart from the
 * page so it can be tested without a window.
 */

/** The Expert dropdown's value for an expert that is not saved yet. */
export const NEW_EXPERT = 'NEW'

export const SOURCE_CHOICES: ReadonlyArray<{ value: ResponseSource; label: string }> = [
  { value: ResponseSource.EMAIL, label: 'Email' },
  { value: ResponseSource.INTERVIEW, label: 'Interview' },
]

/** The Expert dropdown: a new expert first, then every saved expert by name. */
export function expertChoices(experts: readonly Expert[]): Array<{ value: string; label: string }> {
  return [{ value: NEW_EXPERT, label: 'New expert' }, ...experts.map((expert) => ({ value: expert.expertId, label: expert.name }))]
}

/**
 * The expert shown when the page opens: the saved one when there is exactly
 * one, which is the usual case, so a partial entry is resumed without a
 * click. With none, or several, the Researcher chooses.
 */
export function defaultExpertId(experts: readonly Expert[]): string | null {
  return experts.length === 1 ? (experts[0]?.expertId ?? null) : null
}

/** The experts with one saved or updated, in the order the main process lists them: by name. */
export function withSavedExpert(experts: readonly Expert[], saved: Expert): Expert[] {
  return [...experts.filter((expert) => expert.expertId !== saved.expertId), saved].sort(
    (a, b) => compareText(a.name, b.name) || compareText(a.expertId, b.expertId),
  )
}

/** Plain code-unit order, which is how SQLite sorts the names. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The expert card's fields as the inputs hold them. The two times are the
 * values of `datetime-local` inputs: local time, "2026-10-06T09:00", or
 * empty. An input that holds only part of a date and time reports an empty
 * value, so `incomplete` carries what the input itself says about that.
 */
export interface ExpertForm {
  /** The saved expert being edited, or null for a new one. */
  expertId: string | null
  name: string
  source: ResponseSource
  outreachLocal: string
  outreachIncomplete: boolean
  firstAnswerLocal: string
  firstAnswerIncomplete: boolean
}

export const NEW_EXPERT_FORM: ExpertForm = {
  expertId: null,
  name: '',
  source: ResponseSource.EMAIL,
  outreachLocal: '',
  outreachIncomplete: false,
  firstAnswerLocal: '',
  firstAnswerIncomplete: false,
}

/** The form for a saved expert: its stored UTC times shown as local times. */
export function formFor(expert: Expert): ExpertForm {
  return {
    expertId: expert.expertId,
    name: expert.name,
    source: expert.source,
    outreachLocal: toLocalInputValue(expert.outreachTs),
    outreachIncomplete: false,
    firstAnswerLocal: toLocalInputValue(expert.firstAnswerTs),
    firstAnswerIncomplete: false,
  }
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/

/**
 * Turns a `datetime-local` value, which is local time on this computer,
 * into the stored form: ISO 8601 UTC with milliseconds. Empty gives null.
 * Undefined means the value is not a date and time, or names a local time
 * that does not exist (the hour skipped when the clocks go forward). A
 * local time that happens twice, when the clocks go back, is read as the
 * first of the two.
 */
export function fromLocalInputValue(value: string): string | null | undefined {
  if (value === '') return null
  const match = LOCAL_INPUT.exec(value)
  if (!match) return undefined
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((group) => Number(match[group] ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const millis = Number((match[7] ?? '').padEnd(3, '0'))
  const date = new Date(year, month - 1, day, hour, minute, second, millis)
  // new Date rolls 02:30 on the day the clocks go forward over to 03:30, and 2026-02-31 into March; refuse both.
  const same =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second
  return same ? date.toISOString() : undefined
}

/**
 * The reverse: a stored UTC timestamp as the `datetime-local` value for
 * this computer's time zone, to the minute, with seconds and milliseconds
 * only when the stored time has them. Null, or text that is not a
 * timestamp, gives an empty value.
 */
export function toLocalInputValue(iso: string | null): string {
  if (iso === null) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number, width = 2): string => String(part).padStart(width, '0')
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const minute = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const millis = date.getMilliseconds() === 0 ? '' : `.${pad(date.getMilliseconds(), 3)}`
  const second = date.getSeconds() === 0 && millis === '' ? '' : `:${pad(date.getSeconds())}${millis}`
  return `${day}T${minute}${second}`
}

/** What to send for the form, or the field the Researcher must fix before anything is sent. */
export type ExpertFormOutcome = { ok: true; input: ExpertInput } | { ok: false; field: ExpertField; message: string }

/**
 * Builds the expert record to send from the form. Only what the main
 * process cannot see is checked here: a time the input holds half of, and
 * a local time that does not exist. Everything else (the name, a missing
 * outreach time, the order of the two times) is the main process's to
 * refuse, so the rules are in one place.
 */
export function buildExpertInput(form: ExpertForm): ExpertFormOutcome {
  const outreach = readTime(form.outreachLocal, form.outreachIncomplete, 'outreachTs', 'Outreach time', '')
  if (!outreach.ok) return outreach
  const firstAnswer = readTime(form.firstAnswerLocal, form.firstAnswerIncomplete, 'firstAnswerTs', 'First answer time', ', or clear the field')
  if (!firstAnswer.ok) return firstAnswer
  return {
    ok: true,
    input: { expertId: form.expertId, name: form.name, source: form.source, outreachTs: outreach.ts, firstAnswerTs: firstAnswer.ts },
  }
}

function readTime(
  value: string,
  incomplete: boolean,
  field: ExpertField,
  label: string,
  orClear: string,
): { ok: true; ts: string | null } | { ok: false; field: ExpertField; message: string } {
  if (incomplete) return { ok: false, field, message: `${label} is incomplete. Enter both the date and the time${orClear}.` }
  const ts = fromLocalInputValue(value)
  if (ts === undefined) {
    return { ok: false, field, message: `${label} is not a time that exists on this computer's clock. Check the date and the hour.` }
  }
  return { ok: true, ts }
}

/**
 * The turnaround for the times in the form as they stand, before saving:
 * the same subtraction the main process stores. Null while either time is
 * missing or unreadable.
 */
export function formTurnaroundMs(form: ExpertForm): number | null {
  const outreach = form.outreachIncomplete ? undefined : fromLocalInputValue(form.outreachLocal)
  const firstAnswer = form.firstAnswerIncomplete ? undefined : fromLocalInputValue(form.firstAnswerLocal)
  return turnaroundMs(outreach ?? null, firstAnswer ?? null)
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * The turnaround in days and hours, as the Test Plan reads it: "14 days 3
 * hours". Whole hours, rounded down. Under a day it is hours alone, and
 * under an hour minutes, so a same-day reply does not read as nothing;
 * exactly zero is "0 hours". Null (no first answer yet) and a negative
 * value (the first answer before the outreach, which cannot be saved) are
 * "—".
 */
export function formatTurnaround(ms: number | null): string {
  if (ms === null || ms < 0) return '—'
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)
  if (days > 0) return `${count(days, 'day')} ${count(hours, 'hour')}`
  if (hours > 0 || minutes === 0) return count(hours, 'hour')
  return count(minutes, 'minute')
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

/** The turnaround as it is stored, beside the days and hours: "1,220,400,000 ms". Empty when there is none. */
export function turnaroundDetail(ms: number | null): string {
  return ms === null || ms < 0 ? '' : `${ms.toLocaleString('en-US')} ms`
}
