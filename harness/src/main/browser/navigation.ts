import { SUBJECT_LABELS, type Subject } from '../../shared/subjects'

/** The part of a Playwright page that navigation needs. Tests pass a stub. */
export interface Navigable {
  goto(url: string, options?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' }): Promise<unknown>
}

/** Thrown when a subject's page cannot be loaded, with a message the Tester can act on. */
export class SubjectUnreachableError extends Error {
  override readonly name = 'SubjectUnreachableError'

  constructor(
    readonly subject: Subject,
    readonly url: string,
    reason: string,
  ) {
    super(
      `Could not reach the ${SUBJECT_LABELS[subject]} at ${url}. Make sure it is running, then try again. (${reason})`,
    )
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Opens a subject's page and turns connection failures into a clear
 * SubjectUnreachableError. Any other error is passed through unchanged.
 */
export async function openSubjectPage(
  page: Navigable,
  subject: Subject,
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  try {
    await page.goto(url, { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = unreachableReason(message)
    if (reason) {
      throw new SubjectUnreachableError(subject, url, reason)
    }
    throw error
  }
}

/** Extracts a short reason when the error means "nothing answered", else null. */
function unreachableReason(message: string): string | null {
  const network = message.match(/net::ERR_[A-Z_]+/)
  if (network) {
    return network[0]
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(message)) {
    return message.match(/E[A-Z]+/)?.[0] ?? 'connection failed'
  }
  if (/Timeout \d+ms exceeded/i.test(message)) {
    return 'timed out waiting for the page'
  }
  return null
}
