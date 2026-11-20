import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildReport,
  cleanUp,
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
  const off = { enabled: false, outPath: null, browserTimeoutMs: null, deadlineMs: null }
  const on = { enabled: true, outPath: null, browserTimeoutMs: null, deadlineMs: null }

  it('is off for a normal launch, whatever else is on the command line', () => {
    expect(parseSelfCheckArgs(['C:\\app\\harness.exe'])).toEqual(off)
    expect(parseSelfCheckArgs(['electron', '.', '--inspect', '--self-check-out=report.json'])).toEqual(off)
    expect(parseSelfCheckArgs(['harness.exe', '--self-checks'])).toEqual(off)
  })

  it('is on with --self-check, with the default report path unless one is given', () => {
    expect(parseSelfCheckArgs(['harness.exe', '--self-check'])).toEqual(on)
    expect(parseSelfCheckArgs(['harness.exe', '--self-check', '--self-check-out=C:\\temp\\my report.json'])).toEqual({
      ...on,
      outPath: 'C:\\temp\\my report.json',
    })
    expect(parseSelfCheckArgs(['harness.exe', '--self-check', '--self-check-out='])).toEqual(on)
  })

  it('reads the testing flags that shorten the browser check and the deadline', () => {
    expect(
      parseSelfCheckArgs(['harness.exe', '--self-check', '--self-check-browser-timeout-ms=1', '--self-check-deadline-ms=2500']),
    ).toEqual({ ...on, browserTimeoutMs: 1, deadlineMs: 2500 })
  })

  it('ignores the testing flags without --self-check, so they cannot change a normal launch', () => {
    expect(parseSelfCheckArgs(['harness.exe', '--self-check-browser-timeout-ms=1', '--self-check-deadline-ms=1'])).toEqual(off)
  })

  it('keeps the default for a limit that is not a whole number of milliseconds, 1 or more', () => {
    for (const value of ['', '0', '-5', '1.5', 'soon', '1e3', ' 20']) {
      expect(
        parseSelfCheckArgs(['harness.exe', '--self-check', `--self-check-browser-timeout-ms=${value}`, `--self-check-deadline-ms=${value}`]),
      ).toEqual(on)
    }
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

  it('cleans up after a check that ran out of time before the next check starts', async () => {
    const order: string[] = []
    const hung: Check = {
      name: 'hung',
      timeoutMs: 20,
      run: () => new Promise<string>(() => undefined),
      cleanup: async () => {
        order.push('cleanup started')
        await new Promise((resolve) => setTimeout(resolve, 30))
        order.push('cleanup finished')
      },
    }
    const next = check('next', async () => {
      order.push('next ran')
      return 'fine'
    })

    const results = await runChecks([hung, next])

    expect(order).toEqual(['cleanup started', 'cleanup finished', 'next ran'])
    // Cleaning up did not go wrong, so the timeout is the whole story.
    expect(results[0]).toMatchObject({ name: 'hung', ok: false, detail: 'did not finish within 20 ms' })
    expect(results[1]).toMatchObject({ name: 'next', ok: true })
  })

  it('cleans up after every check, passed or failed', async () => {
    const cleaned: string[] = []
    const withCleanup = (name: string, run: () => Promise<string>): Check => ({
      name,
      timeoutMs: 1000,
      run,
      cleanup: async () => {
        cleaned.push(name)
      },
    })

    await runChecks([
      withCleanup('passes', async () => 'fine'),
      withCleanup('throws', async () => {
        throw new Error('broken')
      }),
    ])

    expect(cleaned).toEqual(['passes', 'throws'])
  })

  it('fails a check whose cleanup does not finish, says so, and still moves on', async () => {
    const stuck: Check = { name: 'stuck', timeoutMs: 1000, run: async () => 'looked fine', cleanup: () => new Promise<void>(() => undefined) }

    const results = await runChecks([stuck, check('next', async () => 'fine')], { cleanupTimeoutMs: 20 })

    expect(results[0]).toMatchObject({
      name: 'stuck',
      ok: false,
      detail: 'looked fine; closing what the checks started did not finish within 20 ms',
    })
    expect(results[1]).toMatchObject({ name: 'next', ok: true })
  })

  it('fails a check whose cleanup throws, keeping both reasons', async () => {
    const results = await runChecks([
      {
        name: 'browser',
        timeoutMs: 20,
        run: () => new Promise<string>(() => undefined),
        cleanup: async () => {
          throw new Error('EBUSY: the profile folder is locked')
        },
      },
    ])

    expect(results[0]).toMatchObject({
      ok: false,
      detail: 'did not finish within 20 ms; cleaning up after the browser check failed: EBUSY: the profile folder is locked',
    })
  })

  it('measures each check with the given clock', async () => {
    const ticks = [100, 130]
    const results = await runChecks([check('a', async () => 'x')], { now: () => ticks.shift() ?? 0 })

    expect(results[0]?.durationMs).toBe(30)
  })
})

describe('cleanUp', () => {
  it('resolves with null when every cleanup finished, and skips checks without one', async () => {
    const cleanup = vi.fn(async () => undefined)

    await expect(
      cleanUp(
        [
          { name: 'a', timeoutMs: 1, run: async () => 'x' },
          { name: 'b', timeoutMs: 1, run: async () => 'x', cleanup },
        ],
        1000,
      ),
    ).resolves.toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('never throws: it reports a cleanup that failed and one that did not finish', async () => {
    const problem = await cleanUp(
      [
        {
          name: 'a',
          timeoutMs: 1,
          run: async () => 'x',
          cleanup: async () => {
            throw new Error('could not close')
          },
        },
        { name: 'b', timeoutMs: 1, run: async () => 'x', cleanup: () => new Promise<void>(() => undefined) },
      ],
      20,
    )

    expect(problem).toBe('cleaning up after the a check failed: could not close; closing what the checks started did not finish within 20 ms')
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
      cleanup: { ok: true, problem: null },
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
    const report = buildReport(APP, [pass], TIMES, { timedOut: true })

    expect(report).toMatchObject({ ok: false, status: 'timed_out' })
    expect(exitCodeFor(report)).toBe(SelfCheckExit.TIMED_OUT)
  })

  it('fails, and exits 1, when something the checks started could not be closed, even if every check passed', () => {
    const report = buildReport(APP, [pass], TIMES, { cleanupProblem: 'closing what the checks started did not finish within 105000 ms' })

    expect(report).toMatchObject({
      ok: false,
      status: 'failed',
      cleanup: { ok: false, problem: 'closing what the checks started did not finish within 105000 ms' },
    })
    expect(exitCodeFor(report)).toBe(SelfCheckExit.FAILED)
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
