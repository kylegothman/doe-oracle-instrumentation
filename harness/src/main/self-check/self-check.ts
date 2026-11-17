import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The self-check (story #44): `--self-check` on the command line makes the
 * app run a few start-up checks without opening its window, write the
 * results to a JSON report, and exit with a pass or fail code. The
 * harness-msi workflow runs it against the freshly installed MSI, on a
 * machine that has no development setup, to catch a broken installer before
 * a person tries it.
 *
 * It is harmless by design: it never opens harness.db, never touches the
 * Copilot profile, and never contacts the Oracle, Copilot, Google, or any
 * other site. Without the flag the app behaves exactly as before.
 *
 * Results go to a file because a packaged Electron app on Windows is a GUI
 * program: nothing it prints reaches the console that started it.
 */

/** Runs the checks instead of opening the window. */
export const SELF_CHECK_FLAG = '--self-check'
/** Optional: where to write the report, `--self-check-out=<file>`. */
export const SELF_CHECK_OUT_PREFIX = '--self-check-out='
/**
 * For testing only: replaces the browser check's time limit, in milliseconds
 * (`--self-check-browser-timeout-ms=1` makes it time out at once). It exists
 * so the timeout paths can be exercised on a packaged build.
 */
export const SELF_CHECK_BROWSER_TIMEOUT_PREFIX = '--self-check-browser-timeout-ms='
/** For testing only: replaces the deadline of the whole run, in milliseconds. */
export const SELF_CHECK_DEADLINE_PREFIX = '--self-check-deadline-ms='

/** Exit codes of a self-check run. */
export const SelfCheckExit = {
  PASSED: 0,
  FAILED: 1,
  /** The run as a whole did not finish in time. */
  TIMED_OUT: 2,
} as const

export interface SelfCheckArgs {
  enabled: boolean
  /** The report path given with --self-check-out=, or null for the default. */
  outPath: string | null
  /** The browser check's limit given with --self-check-browser-timeout-ms=, or null for the default. */
  browserTimeoutMs: number | null
  /** The run's deadline given with --self-check-deadline-ms=, or null for the default. */
  deadlineMs: number | null
}

/**
 * Reads the self-check flags from the process arguments. Every other flag
 * is ignored unless --self-check itself is there, so none of them can change
 * a normal launch.
 */
export function parseSelfCheckArgs(argv: readonly string[]): SelfCheckArgs {
  const enabled = argv.includes(SELF_CHECK_FLAG)
  if (!enabled) {
    return { enabled, outPath: null, browserTimeoutMs: null, deadlineMs: null }
  }
  const value = (prefix: string): string | undefined => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return {
    enabled,
    outPath: value(SELF_CHECK_OUT_PREFIX) || null,
    browserTimeoutMs: wholeMilliseconds(value(SELF_CHECK_BROWSER_TIMEOUT_PREFIX)),
    deadlineMs: wholeMilliseconds(value(SELF_CHECK_DEADLINE_PREFIX)),
  }
}

/** A whole number of milliseconds, 1 or more. Anything else is ignored and the default stands. */
function wholeMilliseconds(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= 1 ? value : null
}

/** One thing the self-check verifies. */
export interface Check {
  name: string
  timeoutMs: number
  /** Resolves with a short description of what it found, or throws. */
  run(): Promise<string>
  /**
   * Closes whatever `run` started: a browser, a file. The self-check calls
   * it after every check, including one whose `run` is still going because
   * it passed its limit, and once more before the app exits. So it must be
   * safe to call more than once, while `run` is under way, and when `run`
   * never started.
   */
  cleanup?(): Promise<void>
}

export interface CheckResult {
  name: string
  ok: boolean
  /** What the check found, or why it failed. */
  detail: string
  durationMs: number
}

export interface SelfCheckAppInfo {
  name: string
  version: string
  packaged: boolean
  platform: string
  arch: string
  electron: string
  userDataDir: string
}

export interface SelfCheckReport {
  ok: boolean
  status: 'passed' | 'failed' | 'timed_out'
  app: SelfCheckAppInfo
  startedAt: string
  finishedAt: string
  checks: CheckResult[]
  /**
   * Whether everything the checks started was closed before the app exited.
   * When it was not, `problem` says what went wrong and the run has failed.
   */
  cleanup: { ok: boolean; problem: string | null }
}

/**
 * How long closing what a check started may take. A browser launch that is
 * still under way has to be waited for before it can be closed, and
 * Playwright ends one after SELF_CHECK_LAUNCH_TIMEOUT_MS (90 s), so this
 * is that plus time to close.
 */
export const CHECK_CLEANUP_TIMEOUT_MS = 105_000

export interface RunChecksOptions {
  now?: () => number
  onResult?: (result: CheckResult) => void
  cleanupTimeoutMs?: number
}

/**
 * Runs the checks one after another. A check that throws or runs out of
 * time is recorded as failed and the next one still runs, so the report
 * always covers everything.
 *
 * Each check is cleaned up before the next one starts. That matters most for
 * a check that ran out of time: its `run` is still going and would otherwise
 * be left holding a browser when the app exits. A check whose cleanup fails
 * or does not finish is recorded as failed, even if `run` had passed.
 */
export async function runChecks(checks: readonly Check[], options: RunChecksOptions = {}): Promise<CheckResult[]> {
  const now = options.now ?? Date.now
  const results: CheckResult[] = []
  for (const check of checks) {
    const startedAt = now()
    let ok = false
    let detail: string
    try {
      detail = await withTimeout(check.run(), check.timeoutMs)
      ok = true
    } catch (error) {
      detail = describe(error)
    }
    const problem = await cleanUp([check], options.cleanupTimeoutMs ?? CHECK_CLEANUP_TIMEOUT_MS)
    if (problem !== null) {
      ok = false
      detail = `${detail}; ${problem}`
    }
    const result: CheckResult = { name: check.name, ok, detail, durationMs: now() - startedAt }
    results.push(result)
    options.onResult?.(result)
  }
  return results
}

/**
 * Calls `cleanup` on every check that has one and waits for them all, for
 * at most `timeoutMs`. Never throws: resolves with null when everything was
 * closed, or with what went wrong.
 */
export async function cleanUp(checks: readonly Check[], timeoutMs: number): Promise<string | null> {
  const problems: string[] = []
  const work = Promise.all(
    checks.map(async (check) => {
      try {
        await check.cleanup?.()
      } catch (error) {
        problems.push(`cleaning up after the ${check.name} check failed: ${describe(error)}`)
      }
    }),
  )
  try {
    await withTimeout(work, timeoutMs, `closing what the checks started did not finish within ${timeoutMs} ms`)
  } catch (error) {
    problems.push(describe(error))
  }
  return problems.length > 0 ? problems.join('; ') : null
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message = `did not finish within ${timeoutMs} ms`): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Builds the report. It passes only when there is at least one check, every
 * check passed, the run met its deadline, and everything was closed.
 */
export function buildReport(
  app: SelfCheckAppInfo,
  checks: readonly CheckResult[],
  times: { startedAt: Date; finishedAt: Date },
  outcome: { timedOut?: boolean; cleanupProblem?: string | null } = {},
): SelfCheckReport {
  const timedOut = outcome.timedOut ?? false
  const cleanupProblem = outcome.cleanupProblem ?? null
  const ok = !timedOut && cleanupProblem === null && checks.length > 0 && checks.every((check) => check.ok)
  return {
    ok,
    status: timedOut ? 'timed_out' : ok ? 'passed' : 'failed',
    app,
    startedAt: times.startedAt.toISOString(),
    finishedAt: times.finishedAt.toISOString(),
    checks: [...checks],
    cleanup: { ok: cleanupProblem === null, problem: cleanupProblem },
  }
}

/** The exit code that goes with a report. */
export function exitCodeFor(report: SelfCheckReport): number {
  if (report.status === 'timed_out') return SelfCheckExit.TIMED_OUT
  return report.ok ? SelfCheckExit.PASSED : SelfCheckExit.FAILED
}

/** Writes the report as JSON, creating its folder if needed. */
export function writeReport(report: SelfCheckReport, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`)
}

/** One line per check, for the log. */
export function formatResult(result: CheckResult): string {
  return `[self-check] ${result.ok ? 'PASS' : 'FAIL'} ${result.name} (${result.durationMs} ms): ${result.detail}`
}
