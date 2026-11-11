import type { SqliteStatus } from '../../../shared/ipc'

/**
 * Builds the handler for the `diagnostics:get-sqlite-status` channel. The
 * probe runs once at startup; the handler just reports its result, so the
 * renderer can ask as often as it likes without reopening a database.
 */
export function createGetSqliteStatusHandler(
  status: Promise<SqliteStatus> | SqliteStatus,
): () => Promise<SqliteStatus> {
  return async () => status
}
