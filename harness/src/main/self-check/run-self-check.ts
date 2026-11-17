import { join } from 'node:path'
import type { BrowserLocation } from '../browser/browser-location'
import { browserCheck, questionsCheck, SELF_CHECK_DIR, sqliteCheck } from './checks'
import {
  buildReport,
  exitCodeFor,
  formatResult,
  runChecks,
  SelfCheckExit,
  writeReport,
  type Check,
  type CheckResult,
  type SelfCheckAppInfo,
  type SelfCheckArgs,
  type SelfCheckReport,
} from './self-check'

/** The whole run must end within this, whatever a check does. Each check also has its own limit. */
export const SELF_CHECK_DEADLINE_MS = 180_000

/** The slice of Electron's `app` the self-check uses. Tests pass a plain object. */
export interface SelfCheckApp {
  getName(): string
  getVersion(): string
  isPackaged: boolean
  getPath(name: 'userData'): string
  exit(code: number): void
}

export interface SelfCheckContext {
  app: SelfCheckApp
  args: SelfCheckArgs
  /** Where the app looks for config/questions.json. */
  questionsPath: string
  /** The Chromium a trial would launch. */
  location: BrowserLocation
  /** Replaces the standard checks. For tests. */
  checks?: readonly Check[]
  deadlineMs?: number
  log?: (line: string) => void
}

/** Where the report goes when --self-check-out= is not given: self-check/report.json in the per-user data folder. */
export function defaultReportPath(userDataDir: string): string {
  return join(userDataDir, SELF_CHECK_DIR, 'report.json')
}

/**
 * Runs the checks, writes the report, and exits the app with the matching
 * code: 0 passed, 1 failed, 2 the run did not finish in time. Never opens a
 * window.
 */
export async function runSelfCheckAndExit(context: SelfCheckContext): Promise<void> {
  const { app } = context
  const log = context.log ?? ((line: string) => console.log(line))
  const userDataDir = app.getPath('userData')
  const reportPath = context.args.outPath ?? defaultReportPath(userDataDir)
  const info: SelfCheckAppInfo = {
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? 'unknown',
    userDataDir,
  }
  const checks = context.checks ?? [
    questionsCheck(context.questionsPath),
    sqliteCheck(userDataDir),
    browserCheck({
      location: context.location,
      profileDir: join(userDataDir, SELF_CHECK_DIR, 'profile'),
      packaged: app.isPackaged,
    }),
  ]

  const startedAt = new Date()
  const results: CheckResult[] = []
  let finished = false
  const finish = (timedOut: boolean): void => {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    const report = buildReport(info, results, { startedAt, finishedAt: new Date() }, timedOut)
    const saved = save(report, reportPath, log)
    log(`[self-check] ${report.status.toUpperCase()}: ${info.name} ${info.version}`)
    app.exit(saved ? exitCodeFor(report) : Math.max(exitCodeFor(report), SelfCheckExit.FAILED))
  }
  // A check that hangs past its own limit, or cleanup that never returns,
  // must not leave the app running: CI would wait on it.
  const deadline = setTimeout(() => finish(true), context.deadlineMs ?? SELF_CHECK_DEADLINE_MS)

  log(`[self-check] ${info.name} ${info.version}, report at ${reportPath}`)
  try {
    await runChecks(checks, {
      onResult: (result) => {
        results.push(result)
        log(formatResult(result))
      },
    })
  } finally {
    finish(false)
  }
}

/** Writes the report. A report that cannot be written fails the run: the report is how the result is read. */
function save(report: SelfCheckReport, reportPath: string, log: (line: string) => void): boolean {
  try {
    writeReport(report, reportPath)
    return true
  } catch (error) {
    log(`[self-check] could not write the report to ${reportPath}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
