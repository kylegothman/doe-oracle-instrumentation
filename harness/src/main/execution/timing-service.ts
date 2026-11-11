/** The three moments a trial is timed at. */
export type TimingEvent = 'begin' | 'first_response' | 'end'

/** Epoch milliseconds per event, for one trial. Missing events were not marked. */
export type TrialMarks = Partial<Record<TimingEvent, number>>

/**
 * Records when the three trial events happened and converts them for storage.
 *
 * Timestamps stay as epoch milliseconds (numbers) until they are saved; the
 * repository stores them as ISO 8601 UTC strings with milliseconds through
 * toIso(), and durations as whole milliseconds through durationMs().
 *
 * Clocks: begin and first response are stamped in the Electron main process
 * (Node's Date.now() when Playwright reports the request leaving and the
 * response arriving), while end is stamped inside the Oracle page (the
 * page's Date.now() when the answer text appears). Both read the same
 * operating-system wall clock on the same machine, so the three values are
 * directly comparable; only the process that read the clock differs.
 */
export class TimingService {
  private readonly marks = new Map<string, TrialMarks>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Records an event for a trial. Uses the current time unless atMs is given. Returns the time recorded. */
  mark(trialId: string, event: TimingEvent, atMs?: number): number {
    const at = atMs ?? this.now()
    assertFinite(at, `${event} timestamp`)
    const marks = this.marks.get(trialId) ?? {}
    marks[event] = at
    this.marks.set(trialId, marks)
    return at
  }

  /** A copy of the marks recorded for a trial. */
  getMarks(trialId: string): TrialMarks {
    return { ...(this.marks.get(trialId) ?? {}) }
  }

  /** Forgets a trial's marks once they are saved. */
  clear(trialId: string): void {
    this.marks.delete(trialId)
  }

  /** Whole milliseconds from start to end. Throws if end is before start. */
  durationMs(startMs: number, endMs: number): number {
    assertFinite(startMs, 'start')
    assertFinite(endMs, 'end')
    if (endMs < startMs) {
      throw new RangeError(`End (${endMs}) is before start (${startMs})`)
    }
    return Math.round(endMs - startMs)
  }

  /** ISO 8601 in UTC with milliseconds, for example 2026-11-11T02:53:28.530Z. */
  toIso(ms: number): string {
    assertFinite(ms, 'timestamp')
    return new Date(ms).toISOString()
  }
}

function assertFinite(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number of epoch milliseconds, got ${String(value)}`)
  }
}
