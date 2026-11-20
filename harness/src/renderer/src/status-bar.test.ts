import { describe, expect, it } from 'vitest'
import { Subject } from '../../shared/subjects'
import type { TrialEvent } from '../../shared/trials'
import { badgeFor, elapsedAt, formatElapsed, IDLE, nextBarState } from './status-bar'

const event = (status: TrialEvent['status'], elapsedMs: number): TrialEvent => ({
  trialId: 'trial-1',
  subject: Subject.COPILOT,
  questionNumber: 2,
  status,
  elapsedMs,
})

describe('nextBarState', () => {
  it('shows the subject, question, and a counting time from the moment a trial starts', () => {
    expect(nextBarState(event('started', 15), 1_000)).toEqual({
      phase: 'running',
      subject: Subject.COPILOT,
      questionNumber: 2,
      elapsedMs: 15,
      anchorAt: 1_000,
    })
  })

  it('keeps counting while the Tester presses Enter and the answer streams', () => {
    for (const status of ['awaiting_submit', 'first_response'] as const) {
      expect(nextBarState(event(status, 1_204), 5_000)).toMatchObject({ phase: 'running', elapsedMs: 1_204, anchorAt: 5_000 })
    }
  })

  it('stops the time at the measured response, begin to end, when the answer is complete', () => {
    expect(nextBarState({ ...event('awaiting_confirmation', 14_000), beginMs: 50_000, endMs: 59_377 }, 20_000)).toMatchObject({
      phase: 'running',
      elapsedMs: 9_377,
      anchorAt: null,
    })
  })

  it('falls back to the time since the start if the event has no begin and end', () => {
    expect(nextBarState(event('awaiting_confirmation', 14_000), 20_000)).toMatchObject({ elapsedMs: 14_000, anchorAt: null })
  })

  it('clears the trial and says ready once it ends, however it ended', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'aborted'] as const) {
      expect(nextBarState(event(status, 60_000), 0)).toEqual({ ...IDLE, phase: 'ready' })
    }
  })
})

describe('elapsedAt', () => {
  it('adds the time since the last event while counting', () => {
    expect(elapsedAt({ ...IDLE, phase: 'running', elapsedMs: 1_000, anchorAt: 5_000 }, 7_500)).toBe(3_500)
  })

  it('never goes backwards if the clock reads earlier than the event', () => {
    expect(elapsedAt({ ...IDLE, phase: 'running', elapsedMs: 1_000, anchorAt: 5_000 }, 4_000)).toBe(1_000)
  })

  it('holds still once stopped, and is null with no trial', () => {
    expect(elapsedAt({ ...IDLE, phase: 'running', elapsedMs: 9_377, anchorAt: null }, 99_999)).toBe(9_377)
    expect(elapsedAt(IDLE, 1)).toBeNull()
  })
})

describe('formatElapsed', () => {
  it('shows minutes, seconds, and hundredths, as in the design', () => {
    expect(formatElapsed(9_377)).toBe('00:09.38')
    expect(formatElapsed(0)).toBe('00:00.00')
    expect(formatElapsed(60_000)).toBe('01:00.00')
    expect(formatElapsed(38_404)).toBe('00:38.40')
  })

  it('rounds up into the next second and minute cleanly', () => {
    expect(formatElapsed(59_996)).toBe('01:00.00')
    expect(formatElapsed(9_995)).toBe('00:10.00')
  })

  it('shows a dash when there is no trial', () => {
    expect(formatElapsed(null)).toBe('—')
  })
})

describe('badgeFor', () => {
  it('says Idle before any trial, Running during one, and Ready after', () => {
    expect(badgeFor(IDLE)).toEqual({ label: 'Idle', tone: 'neutral' })
    expect(badgeFor({ ...IDLE, phase: 'running' })).toEqual({ label: 'Running', tone: 'accent' })
    expect(badgeFor({ ...IDLE, phase: 'ready' })).toEqual({ label: 'Ready', tone: 'neutral' })
  })
})
