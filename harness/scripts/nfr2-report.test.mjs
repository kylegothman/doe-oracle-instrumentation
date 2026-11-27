import { describe, expect, it } from 'vitest'
import {
  averageCpu,
  compareTimings,
  median,
  parseCsv,
  readCpuSamples,
  readDevtools,
  readTrials,
  toRecords,
} from './nfr2-report.mjs'

describe('parseCsv and toRecords', () => {
  it('reads the harness export: BOM, CRLF, quoted commas, quotes and line breaks, and trailing spaces in headers', () => {
    const text = '\uFEFFTest #,Question Number ,Answer Text\r\n1,5,"Line one, still\r\nline ""two"""\r\n2,6,plain\r\n'
    expect(toRecords(parseCsv(text))).toEqual([
      { 'Test #': '1', 'Question Number': '5', 'Answer Text': 'Line one, still\r\nline "two"' },
      { 'Test #': '2', 'Question Number': '6', 'Answer Text': 'plain' },
    ])
  })

  it('skips blank lines and reads a last line with no line break', () => {
    expect(parseCsv('a,b\n\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('median', () => {
  it('takes the middle value, or the mean of the two middle values', () => {
    expect(median([30, 10, 20])).toBe(20)
    expect(median([40, 10, 20, 30])).toBe(25)
    expect(median([])).toBeNull()
  })
})

const log = toRecords(
  parseCsv(
    [
      'Test #,Question Number ,Test Subject ,Begin Timestamp,End Timestamp',
      '1,1,DOE Oracle,2026-11-28T15:00:00.000Z,2026-11-28T15:00:08.000Z',
      '2,2,DOE Oracle,2026-11-28T15:01:00.000Z,2026-11-28T15:01:05.000Z',
      '3,1,Microsoft Copilot,2026-11-28T15:02:00.000Z,2026-11-28T15:02:09.000Z',
      '4,3,DOE Oracle,,',
    ].join('\n'),
  ),
)
const supplementary = toRecords(
  parseCsv(['Test #,Time to First Response Milliseconds', '1,7900', '2,4930', '3,1200', '4,'].join('\n')),
)

describe('compareTimings (TC-NFR2-01)', () => {
  const trials = readTrials(log, supplementary)

  it('compares begin-to-first-response with the DevTools duration, without sign, and passes at 50 ms or less', () => {
    const result = compareTimings(trials, readDevtools(toRecords(parseCsv('Test #,DevTools ms\n1,7880\n2,4975'))))
    expect(result.rows.map((row) => row.differenceMs)).toEqual([20, 45])
    expect(result.medianMs).toBe(32.5)
    expect(result.problems).toEqual([])
    expect(result.pass).toBe(true)
  })

  it('fails when the median difference is over 50 ms', () => {
    const result = compareTimings(trials, readDevtools(toRecords(parseCsv('Test #,DevTools ms\n1,7800\n2,4870'))))
    expect(result.medianMs).toBe(80)
    expect(result.pass).toBe(false)
  })

  it('lists, and fails on, a trial that is missing, not the Oracle, or has no first response', () => {
    const result = compareTimings(trials, readDevtools(toRecords(parseCsv('Test #,DevTools ms\n1,7890\n3,1190\n4,900\n9,100'))))
    expect(result.rows.map((row) => row.testNumber)).toEqual([1])
    expect(result.problems).toEqual([
      'Test #3 is a Microsoft Copilot trial, not a DOE Oracle trial.',
      'Test #4 has no time to first response. Did it fail?',
      'Test #9 is not in the export.',
    ])
    expect(result.pass).toBe(false)
  })
})

describe('averageCpu (TC-NFR2-02)', () => {
  const trials = [...readTrials(log, supplementary).values()].filter((trial) => trial.testNumber <= 2)
  const samples = readCpuSamples(
    toRecords(
      parseCsv(
        [
          'timestamp_utc,harness_pct,browser_pct,ollama_pct,harness_processes,browser_processes,ollama_processes',
          // Before trial 1: not counted.
          '2026-11-28T14:59:59.500Z,50.00,1.00,1.00,4,3,1',
          // Covers 15:00:00.2 to 15:00:01.2, inside trial 1.
          '2026-11-28T15:00:01.200Z,4.00,20.00,60.00,4,3,1',
          // Covers 15:00:07.5 to 15:00:08.5, which overlaps the end of trial 1.
          '2026-11-28T15:00:08.500Z,2.00,10.00,40.00,4,3,1',
          // Between the trials: not counted.
          '2026-11-28T15:00:30.000Z,90.00,0.00,0.00,4,3,1',
          // Inside trial 2.
          '2026-11-28T15:01:03.000Z,6.00,30.00,80.00,4,3,1',
        ].join('\n'),
      ),
    ),
  )

  it('averages each group over the samples that overlap a trial, and counts only the harness toward the limit', () => {
    const result = averageCpu(samples, trials)
    expect(result.samples).toBe(3)
    expect(result.harness).toBeCloseTo(4)
    expect(result.browser).toBeCloseTo(20)
    expect(result.ollama).toBeCloseTo(60)
    expect(result.pass).toBe(true)
  })

  it('fails over 10%, and when no sample falls inside a trial', () => {
    const busy = samples.map((sample) => ({ ...sample, harness: 12 }))
    expect(averageCpu(busy, trials).pass).toBe(false)
    expect(averageCpu(samples.slice(0, 1), trials)).toMatchObject({ samples: 0, harness: null, pass: false })
  })
})
