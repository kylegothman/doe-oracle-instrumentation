import { FailureType } from '../../../shared/failures'
import type { TrialLimit } from '../../../shared/ipc'
import type { Question } from '../../../shared/questions'
import { SUBJECTS, SUBJECT_LABELS, Subject } from '../../../shared/subjects'
import { TrialStatus, type Trial, type TrialEvent, type TrialFailure } from '../../../shared/trials'

/**
 * What the Test Console (story #38, UC-1 and UC-3) works out without the
 * bridge: the choices it offers, the steps of a running trial, and how a
 * finished trial is described. Kept apart from the page so it can be tested
 * without a window.
 */

/** The subjects the console offers: all three. */
export const SUBJECT_CHOICES: ReadonlyArray<{ value: Subject; label: string; disabled: boolean }> = SUBJECTS.map((subject) => ({
  value: subject,
  label: SUBJECT_LABELS[subject],
  disabled: false,
}))

/** How a question is listed: "Q1 · What is combinatorial testing?" */
export function questionLabel(question: Question): string {
  return `Q${question.number} · ${question.text}`
}

/** What happens once the Tester clicks Start Trial, per subject. */
export function startHelp(subject: Subject): string {
  switch (subject) {
    case Subject.DOE_ORACLE:
      return 'The harness types and submits this question in the Oracle window, and times the answer from browser events.'
    case Subject.COPILOT:
      return 'The harness fills the question in on Copilot and you press Enter in the browser. When the answer stops changing, you confirm the end.'
    case Subject.GOOGLE:
      return 'The harness fills the question in on Google, signed out, and you press Enter in the browser. When the results have loaded, you highlight the passage that answers the question and click Answer Found, or No Answer Found.'
  }
}

/** One line of the running trial's checklist. `time` is already formatted. */
export interface Step {
  label: string
  state: 'done' | 'current' | 'pending'
  time: string
}

/**
 * The checklist of a running trial, from the events received so far. The
 * Oracle's question is typed and sent by the harness; Copilot's is filled
 * in and sent by the Tester's Enter. Times are milliseconds since the trial
 * started, as the controller measured them, except the Enter itself, which
 * is shown as the moment it happened once the end is detected.
 */
export function trialSteps(subject: Subject, events: readonly TrialEvent[]): Step[] {
  const event = (status: TrialEvent['status']) => events.find((candidate) => candidate.status === status)
  const since = (found: TrialEvent | undefined) => (found ? `+${formatMs(found.elapsedMs)}` : '')
  const first = event('first_response')
  const confirm = event('awaiting_confirmation')

  if (subject === Subject.COPILOT || subject === Subject.GOOGLE) {
    // The Tester sends the question: filled in, their Enter, the first response, then the end.
    const submit = event('awaiting_submit')
    const done = confirm ? 4 : first ? 3 : submit ? 1 : 0
    const google = subject === Subject.GOOGLE
    return withStates(
      [
        { label: google ? 'Question filled in on Google' : 'Question filled in on Copilot', time: submit ? '—' : '' },
        { label: 'You pressed Enter', time: confirm?.beginMs === undefined ? (first ? '—' : '') : clockTime(new Date(confirm.beginMs).toISOString()) },
        { label: 'First response', time: since(first) },
        { label: google ? 'Results page loaded' : 'Answer stopped changing', time: since(confirm) },
      ],
      done,
    )
  }
  return withStates(
    [
      { label: 'Question typed and sent', time: first ? '—' : '' },
      { label: 'First response', time: since(first) },
      { label: 'Answer complete', time: since(confirm) },
    ],
    confirm ? 3 : first ? 2 : 0,
  )
}

/**
 * While Google waits for the Tester's Answer Found (design screen 03): the
 * page-load time, Enter to the results loading, and how long the Tester has
 * been searching, counting from their Enter. Null outside that wait.
 */
export function searchTimes(latest: TrialEvent | undefined, limit: TrialLimit | undefined, now: number): { pageLoadMs: number; searchingMs: number } | null {
  if (!limit?.answerFound || latest?.status !== 'awaiting_confirmation' || latest.beginMs === undefined || latest.endMs === undefined) {
    return null
  }
  return { pageLoadMs: latest.endMs - latest.beginMs, searchingMs: Math.max(0, now - latest.beginMs) }
}

function withStates(steps: ReadonlyArray<Omit<Step, 'state'>>, done: number): Step[] {
  return steps.map((step, index) => ({ ...step, state: index < done ? 'done' : index === done ? 'current' : 'pending' }))
}

/**
 * What the timer's caption says. While the trial runs the timer counts from
 * the trial start; the limit counts from there for the Oracle but from the
 * Tester's Enter for Copilot, so the bar against the limit is drawn only
 * where both start together. Once the end is detected (`measured`), the
 * timer shows the measured response, which the limit applies to directly.
 */
export function timerCaption(limit: TrialLimit | undefined, measured: boolean): { text: string; showProgress: boolean } {
  if (!limit) return { text: measured ? 'response time' : 'since the trial started', showProgress: false }
  const seconds = `${Math.round(limit.timeoutMs / 1000)} s limit`
  if (measured) return { text: `response time, of ${seconds}`, showProgress: true }
  return limit.startsAt === 'trial_start'
    ? { text: `of ${seconds}`, showProgress: true }
    : { text: `since the trial started · the ${seconds} runs from your Enter`, showProgress: false }
}

/**
 * The banner shown while the trial waits on the Tester. Null when it waits
 * on nobody. The subject's own message says what to do: usually to press
 * Enter, for Google sometimes to solve its "unusual traffic" check first.
 */
export function waitingBanner(latest: TrialEvent | undefined, limit?: TrialLimit): { title: string; message: string } | null {
  if (latest?.status === 'awaiting_submit') {
    return { title: `Your turn in the ${SUBJECT_LABELS[latest.subject]} window`, message: latest.message ?? 'The question is filled in. Press Enter there to send it.' }
  }
  if (latest?.status === 'awaiting_confirmation' && limit?.answerFound) {
    const deadline =
      limit.answerLimitMs === null
        ? ''
        : ` After ${Math.round(limit.answerLimitMs / 1000)} s without either, the trial is saved as no answer found.`
    return {
      title: 'Find the answer on the results page',
      message:
        'Open the organic result that best answers the question. Ignore the AI overview. ' +
        `Highlight the passage that answers it, then click Answer Found, or No Answer Found if no result answers it.${deadline}`,
    }
  }
  if (latest?.status === 'awaiting_confirmation') {
    const took =
      latest.beginMs !== undefined && latest.endMs !== undefined
        ? ` The detected response time is ${formatSeconds(latest.endMs - latest.beginMs)} from your Enter.`
        : ''
    return {
      title: `${SUBJECT_LABELS[latest.subject]} stopped streaming`,
      message: `Check the answer in the browser window. Confirm it is complete, or use Adjust if it was still loading.${took}`,
    }
  }
  return null
}

/** "4 trials · 1 failed", for the This session card. */
export function sessionSummary(trials: readonly Trial[]): string {
  if (trials.length === 0) return 'No trials yet in this session.'
  const count = trials.length === 1 ? '1 trial' : `${trials.length} trials`
  const failed = trials.filter((trial) => trial.status === TrialStatus.FAILED).length
  return failed === 0 ? count : `${count} · ${failed} failed`
}

/** Short names for the failure types, as the badges and banners show them. */
export const FAILURE_LABELS: Record<FailureType, string> = {
  [FailureType.TIMEOUT]: 'Timeout',
  [FailureType.UNREACHABLE]: 'Unreachable',
  [FailureType.ERROR_RESPONSE]: 'Error response',
  [FailureType.EMPTY_ANSWER]: 'Empty answer',
}

export type BadgeTone = 'success' | 'danger' | 'warning'

/** A saved trial's status badge: Success, the failure type, or No answer found. */
export function trialBadge(trial: Trial): { label: string; tone: BadgeTone } {
  switch (trial.status) {
    case TrialStatus.SUCCESS:
      return { label: 'Success', tone: 'success' }
    case TrialStatus.FAILED:
      return { label: trial.failure ? FAILURE_LABELS[trial.failure.type] : 'Failed', tone: 'danger' }
    case TrialStatus.NO_ANSWER_FOUND:
      return { label: 'No answer found', tone: 'warning' }
  }
}

/** The failed trial's banner title, for example "Timeout: no answer within 60 s". */
export function failureTitle(failure: TrialFailure, limit: TrialLimit | undefined): string {
  if (failure.type === FailureType.TIMEOUT && limit) {
    return `Timeout: no answer within ${Math.round(limit.timeoutMs / 1000)} s`
  }
  return `${FAILURE_LABELS[failure.type]}: ${failure.message}`
}

/** "Trial #7 · DOE Oracle" */
export function trialTitle(trial: Pick<Trial, 'testNumber' | 'subject'>): string {
  return `Trial #${trial.testNumber} · ${SUBJECT_LABELS[trial.subject]}`
}

/** "Q4 · What is the difference…", or just "Q4" when the question text is not known. */
export function questionLine(questionNumber: number, questions: readonly Question[]): string {
  const question = questions.find((candidate) => candidate.number === questionNumber)
  return question ? questionLabel(question) : `Q${questionNumber}`
}

/**
 * The question to offer after a trial: the next one after a result
 * (SUCCESS, or Google's NO_ANSWER_FOUND), the same one after a failure, so
 * it can be run again.
 */
export function nextQuestionNumber(trial: Pick<Trial, 'status' | 'questionNumber'>, questionCount: number): number {
  return trial.status !== TrialStatus.FAILED && trial.questionNumber < questionCount ? trial.questionNumber + 1 : trial.questionNumber
}

const PREVIEW_CHARS = 400

/** The answer, cut to a preview. */
export function answerPreview(text: string | null): string {
  if (!text) return '(no answer text)'
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
}

/** "Size 0.33 KB · Keywords: none yet", under the answer preview. */
export function recordDetails(trial: Pick<Trial, 'sizeBytes' | 'keywords'>): string {
  return `Size ${(trial.sizeBytes / 1024).toFixed(2)} KB · Keywords: ${trial.keywords ?? 'none yet'}`
}

/** When the Tester clicked Answer Found, as the design shows it: the begin plus the time to answer. "—" when either is missing. */
export function answerFoundTime(trial: Pick<Trial, 'beginTs' | 'timeToAnswerMs'>): string {
  if (trial.beginTs === null || trial.timeToAnswerMs === null) return '—'
  return clockTime(new Date(Date.parse(trial.beginTs) + trial.timeToAnswerMs).toISOString())
}

/**
 * True when a Google trial saved the results page's text rather than a
 * highlighted passage: nothing was highlighted when Answer Found was
 * clicked, so its source is Google's own results page. The Test Console
 * says so instead of calling the text a selected passage.
 */
export function savedResultsText(trial: Pick<Trial, 'subject' | 'sourceUrl'>): boolean {
  if (trial.subject !== Subject.GOOGLE || trial.sourceUrl === null) return false
  try {
    const url = new URL(trial.sourceUrl)
    return /(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === '/search'
  } catch {
    return false
  }
}

/** What a NO_ANSWER_FOUND trial's banner says. */
export function noAnswerMessage(limit: TrialLimit | undefined): string {
  const how = limit?.answerLimitMs
    ? `No Answer Found was clicked, or ${Math.round(limit.answerLimitMs / 1000)} s passed after the results loaded without Answer Found`
    : 'No Answer Found was clicked'
  return `${how}. Saved as a result, not a failure, with its page-load time.`
}

/** Whole milliseconds with thousands separators: "4,812 ms". Null is "—". */
export function formatMs(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms).toLocaleString('en-US')} ms`
}

/** Seconds with three decimals: "9.377 s". */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)} s`
}

/** The time of day of an ISO 8601 UTC timestamp, as the design shows it: "20:44:02.331Z". Null is "—". */
export function clockTime(iso: string | null): string {
  return iso === null ? '—' : iso.slice(11)
}

/**
 * Reads the Tester's corrected end, in seconds after their Enter, into the
 * epoch milliseconds `confirmCompletion` takes. Null when the text is not a
 * number of seconds, 0 or more.
 */
export function adjustedEndMs(beginMs: number, secondsText: string): number | null {
  const seconds = Number(secondsText)
  if (secondsText.trim() === '' || !Number.isFinite(seconds) || seconds < 0) return null
  return Math.round(beginMs + seconds * 1000)
}
