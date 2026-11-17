import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
