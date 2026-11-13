/**
 * One launch of the harness (story #26). Every trial saved during the
 * launch carries its sessionId. A session holds nothing that identifies
 * the Tester: no name, email address, or machine details (NFR-7).
 */
export interface Session {
  /** UUID generated at launch. */
  sessionId: string
  /** When the session started, ISO 8601 UTC with milliseconds. */
  startedAt: string
  /** Harness version from package.json, so results can be traced to a build. */
  appVersion: string
}
