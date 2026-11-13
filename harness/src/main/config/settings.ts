import { SUBJECTS, type Subject } from '../../shared/subjects'
import defaults from '../../shared/harness-config.json'

export interface OracleSettings {
  /** Where the Oracle's frontend is served, for example http://localhost:5173. */
  baseUrl: string
  /** Path of the chat page under baseUrl. */
  chatPath: string
  /** Path of the search endpoint the chat page calls. Used to time the request. */
  searchEndpointPath: string
}

/**
 * When a subject's trial clock starts:
 * - trial_start: as soon as the Trial Controller begins driving the subject,
 *   before its page is opened, so a hang anywhere in the trial ends within
 *   the limit. Used for the Oracle, whose page the harness drives itself.
 * - submit: when the question is submitted, that is when the adapter's
 *   start() resolves. Used where the Tester types and submits by hand, so a
 *   slow Tester cannot cause a false timeout.
 */
export type TimerStart = 'trial_start' | 'submit'

export interface TrialTimeoutPolicy {
  /** How long the subject has to answer, in milliseconds. */
  timeoutMs: number
  startsAt: TimerStart
}

export interface HarnessSettings {
  oracle: OracleSettings
  /**
   * Per-subject time limit (UC-4). The default is 60 seconds for every
   * subject, from src/shared/harness-config.json.
   * TODO(#34): Copilot's clock starts at the Tester's Enter, so its adapter
   * must resolve start() at that moment.
   * TODO(#37): Google's clock starts at the Tester's submit. Whether the
   * limit should also cover the Tester finding the answer on the results
   * page is an open question for the sponsor; until it is settled the
   * clock stops when the adapter reports completion.
   */
  trialTimeouts: Record<Subject, TrialTimeoutPolicy>
}

/** Environment variable that overrides the Oracle base URL. */
export const ORACLE_URL_ENV = 'HARNESS_ORACLE_URL'
/** Environment variable that overrides every subject's time limit, in milliseconds. */
export const TRIAL_TIMEOUT_ENV = 'HARNESS_TRIAL_TIMEOUT_MS'

/**
 * Harness settings: the defaults from src/shared/harness-config.json, with
 * the Oracle URL overridable through HARNESS_ORACLE_URL and the time limit
 * through HARNESS_TRIAL_TIMEOUT_MS.
 *
 * TODO(#7): E6 adds a settings screen; the environment variables are the
 * interim way to point the harness at another Oracle or shorten the limit.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): HarnessSettings {
  const urlOverride = env[ORACLE_URL_ENV]?.trim()
  const baseUrl = urlOverride ? normalizeBaseUrl(urlOverride) : defaults.oracle.baseUrl
  const timeoutOverride = env[TRIAL_TIMEOUT_ENV]?.trim()
  const timeoutMs = timeoutOverride ? parseTimeout(timeoutOverride) : null

  const trialTimeouts = {} as Record<Subject, TrialTimeoutPolicy>
  for (const subject of SUBJECTS) {
    const configured = defaults.subjects[subject] as { timerStartsAt: string; timeoutMs?: number } | undefined
    trialTimeouts[subject] = {
      timeoutMs: timeoutMs ?? configured?.timeoutMs ?? defaults.trialTimeoutMs,
      startsAt: parseTimerStart(subject, configured?.timerStartsAt ?? 'trial_start'),
    }
  }

  return {
    oracle: {
      baseUrl,
      chatPath: defaults.oracle.chatPath,
      searchEndpointPath: defaults.oracle.searchEndpointPath,
    },
    trialTimeouts,
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

function parseTimeout(value: string): number {
  const ms = Number(value)
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`${TRIAL_TIMEOUT_ENV} must be a positive whole number of milliseconds, got "${value}"`)
  }
  return ms
}

function parseTimerStart(subject: Subject, value: string): TimerStart {
  if (value === 'trial_start' || value === 'submit') {
    return value
  }
  throw new Error(`harness-config.json: subjects.${subject}.timerStartsAt must be "trial_start" or "submit", got "${value}"`)
}
