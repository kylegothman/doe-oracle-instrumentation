import { describe, expect, it } from 'vitest'
import { TimingService } from './timing-service'

describe('TimingService marks', () => {
  it('stamps an event with the clock when no time is given', () => {
    let now = 1_000
    const timing = new TimingService(() => now)

    expect(timing.mark('t1', 'begin')).toBe(1_000)
    now = 1_250
    expect(timing.mark('t1', 'first_response')).toBe(1_250)

    expect(timing.getMarks('t1')).toEqual({ begin: 1_000, first_response: 1_250 })
  })

  it('uses the given time, as the adapter supplies browser-event times', () => {
    const timing = new TimingService(() => 999_999)

    timing.mark('t1', 'begin', 5_000)
    timing.mark('t1', 'end', 7_300)

    expect(timing.getMarks('t1')).toEqual({ begin: 5_000, end: 7_300 })
  })

  it('keeps trials apart and returns copies', () => {
    const timing = new TimingService()
    timing.mark('a', 'begin', 1)
    timing.mark('b', 'begin', 2)

    const marks = timing.getMarks('a')
    marks.begin = 42

    expect(timing.getMarks('a')).toEqual({ begin: 1 })
    expect(timing.getMarks('b')).toEqual({ begin: 2 })
    expect(timing.getMarks('unknown')).toEqual({})
  })

  it('forgets a trial on clear', () => {
    const timing = new TimingService()
    timing.mark('a', 'begin', 1)

    timing.clear('a')

    expect(timing.getMarks('a')).toEqual({})
  })

  it('rejects a timestamp that is not a finite number', () => {
    const timing = new TimingService()
    expect(() => timing.mark('a', 'begin', Number.NaN)).toThrow(TypeError)
    expect(() => timing.mark('a', 'begin', Number.POSITIVE_INFINITY)).toThrow(TypeError)
  })
})

describe('TimingService durationMs', () => {
  const timing = new TimingService()

  it('returns whole milliseconds between two times', () => {
    expect(timing.durationMs(1_000, 1_000)).toBe(0)
    expect(timing.durationMs(1_000, 4_250)).toBe(3_250)
    expect(timing.durationMs(1_000.2, 1_001.7)).toBe(2)
  })

  it('refuses an end before its start', () => {
    expect(() => timing.durationMs(2_000, 1_999)).toThrow(RangeError)
  })

  it('refuses non-finite inputs', () => {
    expect(() => timing.durationMs(Number.NaN, 1)).toThrow(TypeError)
    expect(() => timing.durationMs(1, Number.NaN)).toThrow(TypeError)
  })
})

describe('TimingService toIso', () => {
  const timing = new TimingService()

  it('formats ISO 8601 in UTC with milliseconds', () => {
    const ms = Date.UTC(2026, 10, 11, 2, 53, 28, 530)

    expect(timing.toIso(ms)).toBe('2026-11-11T02:53:28.530Z')
  })

  it('always has three fraction digits and a Z suffix', () => {
    expect(timing.toIso(Date.UTC(2026, 0, 1, 0, 0, 0, 0))).toBe('2026-01-01T00:00:00.000Z')
    expect(timing.toIso(Date.UTC(2026, 0, 1, 0, 0, 0, 7))).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('rounds sub-millisecond values rather than failing', () => {
    expect(timing.toIso(Date.UTC(2026, 0, 1) + 0.6)).toBe('2026-01-01T00:00:00.000Z')
  })

  it('refuses a non-finite timestamp', () => {
    expect(() => timing.toIso(Number.NaN)).toThrow(TypeError)
  })
})
