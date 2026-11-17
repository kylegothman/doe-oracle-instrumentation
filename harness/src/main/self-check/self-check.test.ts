import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildReport,
  exitCodeFor,
  formatResult,
  parseSelfCheckArgs,
  runChecks,
  SelfCheckExit,
  writeReport,
  type Check,
  type CheckResult,
  type SelfCheckAppInfo,
} from './self-check'

const APP: SelfCheckAppInfo = {
  name: 'DOE Oracle Test Harness',
  version: '0.2.0',
  packaged: true,
  platform: 'win32',
  arch: 'x64',
  electron: '45.3.0',
  userDataDir: 'C:\\Users\\tester\\AppData\\Roaming\\DOE Oracle Test Harness',
}
const TIMES = { startedAt: new Date('2026-11-16T15:00:00.000Z'), finishedAt: new Date('2026-11-16T15:00:04.500Z') }
const pass: CheckResult = { name: 'questions', ok: true, detail: '12 questions loaded', durationMs: 3 }
const fail: CheckResult = { name: 'browser', ok: false, detail: 'did not start', durationMs: 900 }

describe('parseSelfCheckArgs', () => {
  it('is off for a normal launch, whatever else is on the command line', () => {
    expect(parseSelfCheckArgs(['C:\\app\\harness.exe'])).toEqual({ enabled: false, outPath: null })
    expect(parseSelfCheckArgs(['electron', '.', '--inspect', '--self-check-out=report.json'])).toEqual({ enabled: false, outPath: null })
    expect(parseSelfCheckArgs(['harness.exe', '--self-checks'])).toEqual({ enabled: false, outPath: null })
  })

  it('is on with --self-check, with the default report path unless one is given', () => {
    expect(parseSelfCheckArgs(['harness.exe', '--self-check'])).toEqual({ enabled: true, outPath: null })
    expect(parseSelfCheckArgs(['harness.exe', '--self-check', '--self-check-out=C:\\temp\\my report.json'])).toEqual({
      enabled: true,
      outPath: 'C:\\temp\\my report.json',
    })
    expect(parseSelfCheckArgs(['harness.exe', '--self-check', '--self-check-out='])).toEqual({ enabled: true, outPath: null })
  })
})

describe('runChecks', () => {
  const check = (name: string, run: () => Promise<string>, timeoutMs = 1000): Check => ({ name, timeoutMs, run })

  it('records what each check found, in order', async () => {
    const seen: string[] = []
    const results = await runChecks(
      [check('a', async () => 'found a'), check('b', async () => 'found b')],
      { onResult: (result) => seen.push(result.name) },
    )

    expect(results.map(({ name, ok, detail }) => ({ name, ok, detail }))).toEqual([
      { name: 'a', ok: true, detail: 'found a' },
      { name: 'b', ok: true, detail: 'found b' },
    ])
    expect(seen).toEqual(['a', 'b'])
  })

  it('records a check that throws as failed and still runs the rest', async () => {
    const results = await runChecks([
      check('a', async () => {
        throw new Error('questions.json is missing')
      }),
      check('b', async () => 'fine'),
    ])

    expect(results[0]).toMatchObject({ name: 'a', ok: false, detail: 'questions.json is missing' })
    expect(results[1]).toMatchObject({ name: 'b', ok: true })
  })

  it('fails a check that does not finish within its limit, then moves on', async () => {
    const results = await runChecks([check('hung', () => new Promise<string>(() => undefined), 20), check('next', async () => 'fine')])

    expect(results[0]).toMatchObject({ name: 'hung', ok: false, detail: 'did not finish within 20 ms' })
    expect(results[1]).toMatchObject({ name: 'next', ok: true })
  })

  it('measures each check with the given clock', async () => {
    const ticks = [100, 130]
    const results = await runChecks([check('a', async () => 'x')], { now: () => ticks.shift() ?? 0 })

    expect(results[0]?.durationMs).toBe(30)
  })
})

describe('buildReport and exitCodeFor', () => {
  it('passes when every check passed, and exits 0', () => {
    const report = buildReport(APP, [pass, { ...pass, name: 'sqlite' }], TIMES)

    expect(report).toMatchObject({
      ok: true,
      status: 'passed',
      app: APP,
      startedAt: '2026-11-16T15:00:00.000Z',
      finishedAt: '2026-11-16T15:00:04.500Z',
    })
    expect(report.checks).toHaveLength(2)
    expect(exitCodeFor(report)).toBe(SelfCheckExit.PASSED)
  })

  it('fails when any check failed, and exits 1', () => {
    const report = buildReport(APP, [pass, fail], TIMES)

    expect(report).toMatchObject({ ok: false, status: 'failed' })
    expect(exitCodeFor(report)).toBe(SelfCheckExit.FAILED)
  })

  it('fails when no check ran: an empty run proves nothing', () => {
    expect(buildReport(APP, [], TIMES)).toMatchObject({ ok: false, status: 'failed' })
  })

  it('reports a run that hit the deadline as timed out, and exits 2, even if what ran had passed', () => {
    const report = buildReport(APP, [pass], TIMES, true)

    expect(report).toMatchObject({ ok: false, status: 'timed_out' })
    expect(exitCodeFor(report)).toBe(SelfCheckExit.TIMED_OUT)
  })
})

describe('writeReport', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('writes the report as JSON, creating the folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'self-check-report-'))
    const filePath = join(dir, 'self-check', 'report.json')
    const report = buildReport(APP, [pass, fail], TIMES)

    writeReport(report, filePath)

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(report)
  })
})

describe('formatResult', () => {
  it('gives one line per check', () => {
    expect(formatResult(pass)).toBe('[self-check] PASS questions (3 ms): 12 questions loaded')
    expect(formatResult(fail)).toBe('[self-check] FAIL browser (900 ms): did not start')
  })
})
