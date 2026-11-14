import type { Page } from 'playwright'
import type { CopilotPageState } from '../../shared/copilot'
import type { CopilotSettings } from '../config/settings'

/** Thrown when a trial finds Copilot signed out. The trial is aborted, not saved: nothing was measured. */
export class CopilotSignedOutError extends Error {
  override readonly name = 'CopilotSignedOutError'

  constructor(url: string) {
    super(
      `Copilot is not signed in (the browser is at ${url}). Use "Open Copilot to sign in", sign in in the Copilot window, then run the trial again.`,
    )
  }
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const PROBE_POLL_MS = 250

/**
 * Reads the Copilot page's state once: the chat input, the offline screen,
 * a sign-in host or the sign-in landing page, or none of them yet.
 */
export async function copilotPageState(page: Page, settings: CopilotSettings): Promise<CopilotPageState> {
  if (page.isClosed()) return 'unknown'
  const { selectors } = settings
  if (await isVisible(page, selectors.input)) return 'chat'
  if (await isVisible(page, selectors.offline)) return 'offline'
  if (isSignInHost(page.url(), settings.signInHosts) || (await isVisible(page, selectors.signInPrompt))) {
    return 'signed_out'
  }
  return 'unknown'
}

/**
 * Polls the page's state until it is something other than unknown, or the
 * time is up. A freshly loaded page needs a moment before its input, sign-in
 * prompt, or offline screen is rendered.
 */
export async function probeCopilotPage(
  page: Page,
  settings: CopilotSettings,
  options: { timeoutMs?: number } = {},
): Promise<CopilotPageState> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
  for (;;) {
    const state = await copilotPageState(page, settings)
    if (state !== 'unknown' || Date.now() >= deadline || page.isClosed()) return state
    await page.waitForTimeout(PROBE_POLL_MS).catch(() => undefined)
  }
}

/** True when the URL's host is one of the sign-in hosts or a subdomain of one. */
export function isSignInHost(url: string, signInHosts: readonly string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return signInHosts.some((signIn) => host === signIn || host.endsWith(`.${signIn}`))
}

/** The page's URL without its query or fragment, which on a sign-in host carry state that must not be logged. */
export function safePageUrl(page: Page): string {
  try {
    const url = new URL(page.url())
    return url.origin + url.pathname
  } catch {
    return 'about:blank'
  }
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible()
  } catch {
    return false
  }
}
