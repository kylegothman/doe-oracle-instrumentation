import type { SqliteStatus } from '../../shared/ipc'

/**
 * Opens an in-memory SQLite database through better-sqlite3 and reads the
 * library version. It exists to prove the native module loads, both under
 * `npm run dev` and inside the packaged installer. It creates no tables and
 * stores nothing; the real schema arrives with the data story.
 *
 * better-sqlite3 is loaded lazily so a broken native module is reported as a
 * status instead of crashing the main process before any window exists.
 */
export async function probeSqlite(): Promise<SqliteStatus> {
  try {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(':memory:')
    try {
      const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
      return { ok: true, version: row.version }
    } finally {
      db.close()
    }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? ` (${error.code})` : ''
    return `${error.message}${code}`
  }
  return String(error)
}

/** Writes the probe result to the main process log. */
export function logSqliteStatus(status: SqliteStatus): void {
  if (status.ok) {
    console.log(`[sqlite] better-sqlite3 loaded, SQLite version ${status.version}`)
  } else {
    console.error(`[sqlite] better-sqlite3 failed to load: ${status.error}`)
  }
}
