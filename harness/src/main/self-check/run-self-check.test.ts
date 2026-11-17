import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLocation } from '../browser/browser-location'
import type { BrowserLauncher } from '../browser/browser-manager'
import { browserCheck } from './checks'
import { defaultReportPath, runSelfCheckAndExit, type SelfCheckApp } from './run-self-check'
import { SelfCheckExit, type Check, type SelfCheckReport } from './self-check'

let userData: string
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'self-check-run-'))
})
afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

/** A stand-in for Electron's app that records the exit code. `exited` resolves when exit() is called. */
function fakeApp() {
  let resolveExit: (code: number) => void = () => undefined
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })
  const codes: number[] = []
  const app: SelfCheckApp = {
    getName: () => 'DOE Oracle Test Harness',
    getVersion: () => '0.2.7',
    isPackaged: true,
    getPath: () => userData,
    exit: (code) => {
      codes.push(code)
      resolveExit(code)
    },
  }
  return { app, exited, codes }
}

const passing: Check = { name: 'a', timeoutMs: 1000, run: async () => 'fine' }
const failing: Check = {
  name: 'b',
  timeoutMs: 1000,
  run: async () => {
    throw new Error('broken')
  },
}
const ARGS = { enabled: true, outPath: null, browserTimeoutMs: null, deadlineMs: null }
const base = { questionsPath: 'unused', location: { source: 'cache' } as const, log: () => undefined }

function readReport(filePath: string): SelfCheckReport {
  return JSON.parse(readFileSync(filePath, 'utf8')) as SelfCheckReport
}

describe('runSelfCheckAndExit', () => {
  it('writes the report to self-check/report.json in the data folder and exits 0 when every check passes', async () => {
    const { app, codes } = fakeApp()

    await runSelfCheckAndExit({ ...base, app, args: ARGS, checks: [passing] })

    expect(codes).toEqual([SelfCheckExit.PASSED])
    const report = readReport(defaultReportPath(userData))
    expect(report).toMatchObject({
      ok: true,
      status: 'passed',
      app: { name: 'DOE Oracle Test Harness', version: '0.2.7', packaged: true, userDataDir: userData },
    })
    expect(report.checks).toMatchObject([{ name: 'a', ok: true, detail: 'fine' }])
  })

  it('writes to the path given with --self-check-out= and exits 1 when a check fails', async () => {
    const { app, codes } = fakeApp()
    const outPath = join(userData, 'elsewhere', 'result.json')
    const lines: string[] = []

    await runSelfCheckAndExit({ ...base, app, args: { ...ARGS, outPath }, checks: [passing, failing], log: (line) => lines.push(line) })

    expect(codes).toEqual([SelfCheckExit.FAILED])
    expect(readReport(outPath)).toMatchObject({ ok: false, status: 'failed', checks: [{ ok: true }, { name: 'b', ok: false, detail: 'broken' }] })
    expect(lines).toContain('[self-check] FAILED: DOE Oracle Test Harness 0.2.7')
  })

  it('exits 2 with a timed-out report when the run passes its deadline', async () => {
    const { app, exited, codes } = fakeApp()
    const hung: Check = { name: 'hung', timeoutMs: 60_000, run: () => new Promise<string>(() => undefined) }

    void runSelfCheckAndExit({ ...base, app, args: ARGS, checks: [passing, hung], deadlineMs: 30 })

    expect(await exited).toBe(SelfCheckExit.TIMED_OUT)
    expect(codes).toEqual([SelfCheckExit.TIMED_OUT])
    // The check that finished is in the report; the one that hung is not.
    expect(readReport(defaultReportPath(userData))).toMatchObject({ ok: false, status: 'timed_out', checks: [{ name: 'a', ok: true }] })
  })

  it('fails the run when the report cannot be written, even if every check passed', async () => {
    const { app, codes } = fakeApp()
    const blocked = join(userData, 'blocked')
    writeFileSync(blocked, '')

    await runSelfCheckAndExit({ ...base, app, args: { ...ARGS, outPath: join(blocked, 'report.json') }, checks: [passing] })

    expect(codes).toEqual([SelfCheckExit.FAILED])
  })

  describe('never exits with something still open', () => {
    it('cleans up a check that is still going when the deadline passes, before it exits', async () => {
      const { app, exited, codes } = fakeApp()
      const order: string[] = []
      const exit = app.exit
      app.exit = (code) => {
        order.push('exit')
        exit(code)
      }
      const hung: Check = {
        name: 'hung',
        timeoutMs: 60_000,
        run: () => new Promise<string>(() => undefined),
        cleanup: async () => {
          order.push('cleanup started')
          await new Promise((resolve) => setTimeout(resolve, 30))
          order.push('cleanup finished')
        },
      }

      void runSelfCheckAndExit({ ...base, app, args: ARGS, checks: [passing, hung], deadlineMs: 30 })

      expect(await exited).toBe(SelfCheckExit.TIMED_OUT)
      expect(order).toEqual(['cleanup started', 'cleanup finished', 'exit'])
      expect(codes).toEqual([SelfCheckExit.TIMED_OUT])
      expect(readReport(defaultReportPath(userData))).toMatchObject({
        status: 'timed_out',
        checks: [{ name: 'a', ok: true }],
        cleanup: { ok: true, problem: null },
      })
    })

    it('uses the deadline the testing flag gives', async () => {
      const { app, exited } = fakeApp()
      const hung: Check = { name: 'hung', timeoutMs: 60_000, run: () => new Promise<string>(() => undefined) }

      void runSelfCheckAndExit({ ...base, app, args: { ...ARGS, deadlineMs: 30 }, checks: [hung] })

      expect(await exited).toBe(SelfCheckExit.TIMED_OUT)
    })

    it('cleans up once more before a normal exit, after the last check', async () => {
      const { app, codes } = fakeApp()
      const order: string[] = []
      const exit = app.exit
      app.exit = (code) => {
        order.push('exit')
        exit(code)
      }
      const check: Check = {
        name: 'a',
        timeoutMs: 1000,
        run: async () => 'fine',
        cleanup: async () => {
          order.push('cleanup')
        },
      }

      await runSelfCheckAndExit({ ...base, app, args: ARGS, checks: [check] })

      expect(order).toEqual(['cleanup', 'cleanup', 'exit'])
      expect(codes).toEqual([SelfCheckExit.PASSED])
    })

    it('still exits, as failed and saying why, when cleanup never finishes', async () => {
      const { app, exited, codes } = fakeApp()
      const lines: string[] = []
      const stuck: Check = { name: 'stuck', timeoutMs: 1000, run: async () => 'fine', cleanup: () => new Promise<void>(() => undefined) }

      void runSelfCheckAndExit({ ...base, app, args: ARGS, checks: [stuck], cleanupTimeoutMs: 20, log: (line) => lines.push(line) })

      expect(await exited).toBe(SelfCheckExit.FAILED)
      expect(codes).toEqual([SelfCheckExit.FAILED])
      const problem = 'closing what the checks started did not finish within 20 ms'
      expect(readReport(defaultReportPath(userData))).toMatchObject({ ok: false, status: 'failed', cleanup: { ok: false, problem } })
      expect(lines).toContain(`[self-check] ${problem}`)
    })

    /** A fake Playwright whose shared launch returns only when the test lets it. */
    function slowLauncher() {
      let finishLaunch: () => void = () => undefined
      const events: string[] = []
      const page = {
        isClosed: () => false,
        goto: async () => null,
        setContent: async () => undefined,
        textContent: async () => 'ok',
        evaluate: async () => 2,
        context: () => ({ browser: () => browser }),
      }
      const browser = {
        isConnected: () => true,
        on: () => undefined,
        version: () => '158.0.8127.18',
        newContext: async () => ({ newPage: async () => page }),
        close: vi.fn(async () => {
          events.push('browser closed')
        }),
      }
      const launcher: BrowserLauncher = {
        launch: vi.fn(
          () =>
            new Promise<Browser>((resolve) => {
              finishLaunch = () => {
                events.push('launch returned')
                resolve(browser as unknown as Browser)
              }
            }),
        ),
        launchPersistentContext: vi.fn(async () => {
          events.push('profile launched')
          return { pages: () => [page], on: () => undefined, close: async () => undefined } as unknown as BrowserContext
        }),
      }
      return { launcher, events, finishLaunch: () => finishLaunch() }
    }
    const cache: BrowserLocation = { source: 'cache' }

    it('closes a browser whose launch returns after the browser check timed out, then exits 1', async () => {
      const { app, exited } = fakeApp()
      const slow = slowLauncher()
      const exit = app.exit
      app.exit = (code) => {
        slow.events.push('exit')
        exit(code)
      }
      const check = browserCheck({ location: cache, profileDir: join(userData, 'self-check', 'profile'), packaged: false, launcher: slow.launcher, timeoutMs: 20 })

      void runSelfCheckAndExit({ ...base, app, args: ARGS, checks: [check] })
      // The check's 20 ms pass with the launch still under way. The run must wait, not exit.
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(slow.events).toEqual([])
      slow.finishLaunch()

      expect(await exited).toBe(SelfCheckExit.FAILED)
      expect(slow.events).toEqual(['launch returned', 'browser closed', 'exit'])
      expect(slow.launcher.launchPersistentContext).not.toHaveBeenCalled()
      expect(readReport(defaultReportPath(userData))).toMatchObject({
        status: 'failed',
        checks: [{ name: 'browser', ok: false, detail: 'did not finish within 20 ms' }],
        cleanup: { ok: true, problem: null },
      })
    })

    it('closes a browser whose launch returns after the deadline, then exits 2', async () => {
      const { app, exited } = fakeApp()
      const slow = slowLauncher()
      const exit = app.exit
      app.exit = (code) => {
        slow.events.push('exit')
        exit(code)
      }
      const check = browserCheck({ location: cache, profileDir: join(userData, 'self-check', 'profile'), packaged: false, launcher: slow.launcher })

      void runSelfCheckAndExit({ ...base, app, args: ARGS, checks: [check], deadlineMs: 20 })
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(slow.events).toEqual([])
      slow.finishLaunch()

      expect(await exited).toBe(SelfCheckExit.TIMED_OUT)
      expect(slow.events).toEqual(['launch returned', 'browser closed', 'exit'])
      expect(slow.launcher.launchPersistentContext).not.toHaveBeenCalled()
    })
  })
})
