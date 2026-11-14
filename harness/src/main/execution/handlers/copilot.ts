import type { Page } from 'playwright'
import type { CopilotPageState, CopilotSignInStatus } from '../../../shared/copilot'
import { Subject } from '../../../shared/subjects'
import { probeCopilotPage, safePageUrl } from '../../adapters/copilot-session'
import type { BrowserManager } from '../../browser/browser-manager'
import { openSubjectPage } from '../../browser/navigation'
import type { CopilotSettings } from '../../config/settings'

export interface OpenCopilotSignInDeps {
  pages: Pick<BrowserManager, 'getPage'>
  settings: CopilotSettings
  /** Reads the page's state once it is open; defaults to probeCopilotPage. Tests pass a stub. */
  probe?: (page: Page, settings: CopilotSettings) => Promise<CopilotPageState>
}

/**
 * Builds the handler for `copilot:open-sign-in`: brings the Copilot window
 * (its persistent profile) to the front on the chat page, so the Tester can
 * sign in there, and reports whether the chat input appeared. The harness
 * never types credentials or touches cookies; signing in is the Tester's.
 */
export function createOpenCopilotSignInHandler(deps: OpenCopilotSignInDeps): () => Promise<CopilotSignInStatus> {
  const probe = deps.probe ?? probeCopilotPage
  return async () => {
    const { settings } = deps
    const page = await deps.pages.getPage(Subject.COPILOT)
    await page.bringToFront()
    await openSubjectPage(page, Subject.COPILOT, settings.chatUrl)
    const state = await probe(page, settings)
    return {
      product: settings.product,
      label: settings.label,
      chatUrl: settings.chatUrl,
      url: safePageUrl(page),
      state,
      signedIn: state === 'chat',
    }
  }
}
