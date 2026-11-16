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
}

/** Reads the self-check flags from the process arguments. */
export function parseSelfCheckArgs(argv: readonly string[]): SelfCheckArgs {
  const enabled = argv.includes(SELF_CHECK_FLAG)
  const out = argv.find((arg) => arg.startsWith(SELF_CHECK_OUT_PREFIX))?.slice(SELF_CHECK_OUT_PREFIX.length)
  return { enabled, outPath: enabled && out ? out : null }
}

/** One thing the self-check verifies. `run` resolves with a short description of what it found, or throws. */
export interface Check {
  name: string
  timeoutMs: number
  run(): Promise<string>
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
}

/**
 * Runs the checks one after another. A check that throws or runs out of
 * time is recorded as failed and the next one still runs, so the report
 * always covers everything.
 */
export async function runChecks(
  checks: readonly Check[],
  options: { now?: () => number; onResult?: (result: CheckResult) => void } = {},
): Promise<CheckResult[]> {
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
      detail = error instanceof Error ? error.message : String(error)
    }
    const result: CheckResult = { name: check.name, ok, detail, durationMs: now() - startedAt }
    results.push(result)
    options.onResult?.(result)
  }
  return results
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not finish within ${timeoutMs} ms`)), timeoutMs)
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

/** Builds the report. It passes only when there is at least one check and every check passed. */
export function buildReport(
  app: SelfCheckAppInfo,
  checks: readonly CheckResult[],
  times: { startedAt: Date; finishedAt: Date },
  timedOut = false,
): SelfCheckReport {
  const ok = !timedOut && checks.length > 0 && checks.every((check) => check.ok)
  return {
    ok,
    status: timedOut ? 'timed_out' : ok ? 'passed' : 'failed',
    app,
    startedAt: times.startedAt.toISOString(),
    finishedAt: times.finishedAt.toISOString(),
    checks: [...checks],
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
