import type { Session } from '../../../shared/session'
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
