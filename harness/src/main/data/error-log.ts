import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import type { Expert } from '../../shared/experts'
import type { TrialFailure } from '../../shared/trials'
import type { NewExpertResponse, NewTrial } from './metrics-repository'

/** The save that failed and everything needed to run it again. */
export type PendingOperation =
  | { operation: 'saveTrial'; payload: { trial: NewTrial; failure: TrialFailure | null } }
  | { operation: 'saveExpert'; payload: { expert: Expert } }
  | { operation: 'saveExpertResponse'; payload: { response: NewExpertResponse; replace: boolean } }

/**
 * A save that failed and is kept until a retry succeeds (UC-2 E1, Detailed
 * Design Figure 9). Stored as one JSON line in the error log file.
 */
export type PendingWrite = PendingOperation & {
  id: string
  /** The error from the most recent attempt. */
  error: string
  /** When the first attempt failed, ISO 8601 UTC with milliseconds. */
  failedAt: string
}

/** Runs a pending write again. MetricsRepository implements it. */
export interface PendingWriteTarget {
  applyPendingWrite(write: PendingOperation): void
}

/**
 * Keeps saves that failed so the Tester can retry them. It writes to a
 * JSON-lines file, not SQLite, because a SQLite write is what just failed.
 * The file is read when the ErrorLog is created, so pending writes survive
 * the app closing; it is rewritten when a retry succeeds or fails again.
 */
export class ErrorLog {
  private pending: PendingWrite[]

  constructor(
    readonly logPath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.pending = readPendingWrites(logPath)
  }

  /** Keeps a failed save and returns the pending write, with its id for retry. */
  record(operation: PendingOperation, error: unknown): PendingWrite {
    const write: PendingWrite = { ...operation, id: randomUUID(), error: describe(error), failedAt: this.now().toISOString() }
    appendFileSync(this.logPath, `${JSON.stringify(write)}\n`, 'utf8')
    this.pending.push(write)
    console.warn(`[errors] ${write.operation} failed and was kept for retry (${write.id}): ${write.error}`)
    return write
  }

  /** The saves still waiting for a successful retry, oldest first. */
  listPending(): PendingWrite[] {
    return this.pending.map((write) => structuredClone(write))
  }

  /**
   * Tries one pending write again. On success it is removed and true is
   * returned; on failure it stays, with the new error, and false is
   * returned. An id that is not pending also returns false.
   */
  retry(id: string, target: PendingWriteTarget): boolean {
    const write = this.pending.find((candidate) => candidate.id === id)
    if (!write) return false
    try {
      target.applyPendingWrite(write)
    } catch (error) {
      write.error = describe(error)
      this.save()
      return false
    }
    this.pending = this.pending.filter((candidate) => candidate.id !== id)
    this.save()
    return true
  }

  /** Tries every pending write again, oldest first. Returns how many succeeded. */
  retryAll(target: PendingWriteTarget): number {
    let succeeded = 0
    for (const { id } of [...this.pending]) {
      if (this.retry(id, target)) succeeded++
    }
    return succeeded
  }

  private save(): void {
    writeFileSync(this.logPath, this.pending.map((write) => `${JSON.stringify(write)}\n`).join(''), 'utf8')
  }
}

function readPendingWrites(logPath: string): PendingWrite[] {
  if (!existsSync(logPath)) return []
  const writes: PendingWrite[] = []
  for (const [index, line] of readFileSync(logPath, 'utf8').split('\n').entries()) {
    if (line.trim() === '') continue
    try {
      writes.push(JSON.parse(line) as PendingWrite)
    } catch {
      // A line cut short by a crash mid-append; the rest of the file is still usable.
      console.warn(`[errors] Skipped unreadable line ${index + 1} in ${logPath}`)
    }
  }
  return writes
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
