import defaults from '../../shared/harness-config.json'

export interface OracleSettings {
  /** Where the Oracle's frontend is served, for example http://localhost:5173. */
  baseUrl: string
  /** Path of the chat page under baseUrl. */
  chatPath: string
  /** Path of the search endpoint the chat page calls. Used to time the request. */
  searchEndpointPath: string
}

export interface HarnessSettings {
  oracle: OracleSettings
}

/** Environment variable that overrides the Oracle base URL. */
export const ORACLE_URL_ENV = 'HARNESS_ORACLE_URL'

/**
 * Harness settings: the defaults from src/shared/harness-config.json, with
 * the Oracle URL overridable through HARNESS_ORACLE_URL.
 *
 * TODO(#7): E6 adds a settings screen; the environment variable is the
 * interim way to point the harness at an Oracle on another port or machine.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): HarnessSettings {
  const override = env[ORACLE_URL_ENV]?.trim()
  const baseUrl = override ? normalizeBaseUrl(override) : defaults.oracle.baseUrl
  return {
    oracle: {
      baseUrl,
      chatPath: defaults.oracle.chatPath,
      searchEndpointPath: defaults.oracle.searchEndpointPath,
    },
  }
}

/** The full URL of the Oracle chat page. */
export function oracleChatUrl(settings: HarnessSettings): string {
  return new URL(settings.oracle.chatPath, settings.oracle.baseUrl).toString()
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${ORACLE_URL_ENV} is not a valid URL: "${value}". Expected something like http://localhost:5173`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${ORACLE_URL_ENV} must use http or https, got "${value}"`)
  }
  return url.origin
}
