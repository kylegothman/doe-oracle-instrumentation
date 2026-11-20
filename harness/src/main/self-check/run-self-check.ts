import { join } from 'node:path'
import type { BrowserLocation } from '../browser/browser-location'
import { browserCheck, questionsCheck, SELF_CHECK_DIR, sqliteCheck } from './checks'
import {
  buildReport,
  CHECK_CLEANUP_TIMEOUT_MS,
  cleanUp,
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

/**
 * The checks must be done within this, whatever one of them does. Each check
 * also has its own limit. When it passes, the run stops waiting for the
 * checks, closes what they started (which has its own limit,
 * CHECK_CLEANUP_TIMEOUT_MS), and exits with the timed-out code.
 */
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
  /** How long closing what the checks started may take. For tests. */
  cleanupTimeoutMs?: number
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
 *
 * Whichever way the run ends, everything the checks started is closed before
 * the app exits, so no Chromium is left running from the install folder
 * (which would lock its files against the next uninstall or reinstall):
 * - a check that passes its own limit is cleaned up before the next check
 *   starts (runChecks);
 * - when the deadline passes with a check still going, every check is
 *   cleaned up before the report is written;
 * - a browser launch that only returns after either limit is waited for and
 *   then closed (TrackedLauncher).
 * If closing does not finish within its own limit the run is reported as
 * failed, with the reason, and the app exits anyway: it must never hang.
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
      ...(context.args.browserTimeoutMs === null ? {} : { timeoutMs: context.args.browserTimeoutMs }),
    }),
  ]

  const cleanupTimeoutMs = context.cleanupTimeoutMs ?? CHECK_CLEANUP_TIMEOUT_MS
  const startedAt = new Date()
  const results: CheckResult[] = []
  let finishing: Promise<void> | null = null
  const finish = (timedOut: boolean): Promise<void> => {
    finishing ??= (async () => {
      clearTimeout(deadline)
      // What the report covers is settled now. A check that is still going
      // fails as its browser is closed under it; that is not a result.
      const reported = [...results]
      const cleanupProblem = await cleanUp(checks, cleanupTimeoutMs)
      if (cleanupProblem !== null) log(`[self-check] ${cleanupProblem}`)
      const report = buildReport(info, reported, { startedAt, finishedAt: new Date() }, { timedOut, cleanupProblem })
      const saved = save(report, reportPath, log)
      log(`[self-check] ${report.status.toUpperCase()}: ${info.name} ${info.version}`)
      app.exit(saved ? exitCodeFor(report) : Math.max(exitCodeFor(report), SelfCheckExit.FAILED))
    })()
    return finishing
  }
  // A check that hangs past its own limit, or cleanup that never returns,
  // must not leave the app running: CI would wait on it.
  const deadline = setTimeout(() => void finish(true), context.deadlineMs ?? context.args.deadlineMs ?? SELF_CHECK_DEADLINE_MS)

  log(`[self-check] ${info.name} ${info.version}, report at ${reportPath}`)
  try {
    await runChecks(checks, {
      cleanupTimeoutMs,
      onResult: (result) => {
        results.push(result)
        log(formatResult(result))
      },
    })
  } finally {
    await finish(false)
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
