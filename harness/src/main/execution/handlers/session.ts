import type { Session } from '../../../shared/session'
import type { MetricsRepository } from '../../data/metrics-repository'
import type { SessionManager } from '../session-manager'

/**
 * Builds the handler for `session:get`. The manager is supplied through a
 * promise because the session is started once the database is open.
 */
export function createGetSessionHandler(
  session: () => Promise<Pick<SessionManager, 'getCurrentSession'>>,
): () => Promise<Session> {
  return async () => (await session()).getCurrentSession()
}

/**
 * Builds the handler for `sessions:list`: every saved session, newest
 * first, for the Export Page. The repository is supplied through a promise
 * because the database is opened after startup.
 */
export function createListSessionsHandler(
  repository: () => Promise<Pick<MetricsRepository, 'listSessions'>>,
): () => Promise<Session[]> {
  return async () => (await repository()).listSessions()
}
