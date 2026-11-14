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
 * Which Copilot the harness drives. "Copilot" on the web is two products
 * behind one sign-in page (docs/copilot-spike.md):
 * - m365: Microsoft 365 Copilot Chat, what a work or school account gets.
 *   The spike drove it from Playwright's Chromium with no bot challenge.
 * - consumer: what a personal Microsoft account gets. Every send is gated
 *   by a Cloudflare Turnstile check that Playwright's browser fails, so it
 *   is configured but cannot be driven as shipped.
 */
export type CopilotProduct = 'm365' | 'consumer'

/**
 * Where things are on the Copilot chat page. Roles, labels, and
 * data-testids where the page has them; see docs/copilot-spike.md for what
 * each one is and how it was chosen. Playwright selector syntax, so a value
 * may use the `:has-text()` extension; only `input` is also used inside the
 * page, where it must be plain CSS.
 */
export interface CopilotSelectors {
  /** The contenteditable question editor. Plain CSS: it is also queried inside the page. */
  input: string
  /** The Send button, present while the question is typed and not yet sent. */
  sendButton: string
  /** Replaces Send while the answer streams; its disappearance is a definite finished marker. */
  stopButton: string
  /** The message list. */
  conversation: string
  /** One per message, the Tester's and Copilot's. */
  message: string
  /** A Copilot message. */
  botMessage: string
  /** The answer body inside a Copilot message, which grows while streaming. */
  reply: string
  /** Shown in the new message before the first token. */
  loading: string
  /** The Copy / feedback toolbar that appears once a message is complete. */
  messageActions: string
  /** An inline citation button; its aria-label carries the provider and the title. */
  citation: string
  /** An error shown in place of an answer. */
  answerError: string
  /** The full-page "No internet connection" state that replaces the app. */
  offline: string
  /** The signed-out landing page. */
  signInPrompt: string
}

/** What differs between the two Copilot products. */
export interface CopilotProductSettings {
  label: string
  /** The chat page; each trial starts here, so questions never share a conversation. */
  chatUrl: string
  /** Hosts the page lands on when it is not signed in. */
  signInHosts: string[]
  /** Path prefix of the SignalR WebSocket the question travels over, on whichever host. */
  chatHubPath: string
  selectors: CopilotSelectors
}

export interface CopilotSettings extends CopilotProductSettings {
  product: CopilotProduct
  /**
   * Milliseconds the reply text must stay unchanged, once streaming has
   * started, to count as finished when no finished marker appeared.
   */
  quietPeriodMs: number
  /** How long the harness waits for the Tester's Enter before the trial is aborted. */
  submitWaitMs: number
  /**
   * After the input clears, how long to wait for a confirming signal (the
   * Stop button, a new message, or the request frame) before treating the
   * clearing as the Tester deleting the text rather than submitting it.
   */
  submitConfirmMs: number
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

/** How the Trial Controller runs one subject's trials. */
export interface TrialPolicy {
  /** How long the subject has to answer, in milliseconds. */
  timeoutMs: number
  startsAt: TimerStart
  /**
   * Whether the Tester confirms the detected end before the trial is saved.
   * Copilot's end is read off a streamed answer, so the Tester, who watched
   * it, confirms it or corrects it; the clock is already stopped. The
   * Oracle's end is unambiguous and needs no confirmation.
   */
  confirmEnd: boolean
}

export interface HarnessSettings {
  oracle: OracleSettings
  /** The Copilot product being driven, resolved from the config's `copilot.product`. */
  copilot: CopilotSettings
  /**
   * Per-subject time limit (UC-4), when the clock starts, and whether the
   * Tester confirms the end. The limit is 60 seconds for every subject by
   * default, from src/shared/harness-config.json. Copilot's clock starts at
   * the Tester's Enter: its adapter resolves start() at that moment.
   * TODO(#37): Google's clock starts at the Tester's submit. Whether the
   * limit should also cover the Tester finding the answer on the results
   * page is an open question for the sponsor; until it is settled the
   * clock stops when the adapter reports completion.
   */
  trialPolicies: Record<Subject, TrialPolicy>
}

/** Environment variable that overrides the Oracle base URL. */
export const ORACLE_URL_ENV = 'HARNESS_ORACLE_URL'
/** Environment variable that overrides every subject's time limit, in milliseconds. */
export const TRIAL_TIMEOUT_ENV = 'HARNESS_TRIAL_TIMEOUT_MS'
/** Environment variable that picks the Copilot product: m365 or consumer. */
export const COPILOT_PRODUCT_ENV = 'HARNESS_COPILOT_PRODUCT'

/**
 * Harness settings: the defaults from src/shared/harness-config.json, with
 * the Oracle URL overridable through HARNESS_ORACLE_URL, the time limit
 * through HARNESS_TRIAL_TIMEOUT_MS, and the Copilot product through
 * HARNESS_COPILOT_PRODUCT.
 *
 * TODO(#7): E6 adds a settings screen; the environment variables are the
 * interim way to point the harness at another Oracle, shorten the limit,
 * or switch Copilot products.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): HarnessSettings {
  const urlOverride = env[ORACLE_URL_ENV]?.trim()
  const baseUrl = urlOverride ? normalizeBaseUrl(urlOverride) : defaults.oracle.baseUrl
  const timeoutOverride = env[TRIAL_TIMEOUT_ENV]?.trim()
  const timeoutMs = timeoutOverride ? parseTimeout(timeoutOverride) : null

  const trialPolicies = {} as Record<Subject, TrialPolicy>
  for (const subject of SUBJECTS) {
    const configured = defaults.subjects[subject] as
      | { timerStartsAt: string; timeoutMs?: number; confirmEnd?: boolean }
      | undefined
    trialPolicies[subject] = {
      timeoutMs: timeoutMs ?? configured?.timeoutMs ?? defaults.trialTimeoutMs,
      startsAt: parseTimerStart(subject, configured?.timerStartsAt ?? 'trial_start'),
      confirmEnd: configured?.confirmEnd ?? false,
    }
  }

  return {
    oracle: {
      baseUrl,
      chatPath: defaults.oracle.chatPath,
      searchEndpointPath: defaults.oracle.searchEndpointPath,
    },
    copilot: loadCopilotSettings(env[COPILOT_PRODUCT_ENV]?.trim()),
    trialPolicies,
  }
}

/** The full URL of the Oracle chat page. */
export function oracleChatUrl(settings: HarnessSettings): string {
  return new URL(settings.oracle.chatPath, settings.oracle.baseUrl).toString()
}

const COPILOT_PRODUCTS: readonly CopilotProduct[] = ['m365', 'consumer']

function loadCopilotSettings(productOverride: string | undefined): CopilotSettings {
  const product = parseCopilotProduct(productOverride || defaults.copilot.product, productOverride ? COPILOT_PRODUCT_ENV : 'harness-config.json: copilot.product')
  const configured = defaults.copilot.products[product]
  const chatUrl = parseHttpUrl(configured.chatUrl, `harness-config.json: copilot.products.${product}.chatUrl`)
  return {
    product,
    label: configured.label,
    chatUrl,
    signInHosts: [...configured.signInHosts],
    chatHubPath: configured.chatHubPath,
    selectors: { ...configured.selectors },
    quietPeriodMs: positiveMs(defaults.copilot.quietPeriodMs, 'copilot.quietPeriodMs'),
    submitWaitMs: positiveMs(defaults.copilot.submitWaitMs, 'copilot.submitWaitMs'),
    submitConfirmMs: positiveMs(defaults.copilot.submitConfirmMs, 'copilot.submitConfirmMs'),
  }
}

function parseCopilotProduct(value: string, source: string): CopilotProduct {
  if ((COPILOT_PRODUCTS as readonly string[]).includes(value)) {
    return value as CopilotProduct
  }
  throw new Error(`${source} must be one of ${COPILOT_PRODUCTS.join(', ')}, got "${value}"`)
}

function parseHttpUrl(value: string, source: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${source} is not a valid URL: "${value}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${source} must use http or https, got "${value}"`)
  }
  return url.toString()
}

function positiveMs(value: unknown, source: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`harness-config.json: ${source} must be a positive whole number of milliseconds, got ${String(value)}`)
  }
  return value
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
