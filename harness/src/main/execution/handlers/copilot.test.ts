import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import type { CopilotPageState } from '../../../shared/copilot'
import { Subject } from '../../../shared/subjects'
import { SubjectUnreachableError } from '../../browser/navigation'
import { loadSettings } from '../../config/settings'
import { createOpenCopilotSignInHandler } from './copilot'

const settings = loadSettings({}).copilot

/** A page that records navigation and reports the URL it was sent to, or fails to load. */
function fakePage(options: { failWith?: string; landsOn?: string } = {}) {
  let url = 'about:blank'
  const page = {
    bringToFront: vi.fn(async () => {}),
    goto: vi.fn(async (target: string) => {
      if (options.failWith) throw new Error(options.failWith)
      url = options.landsOn ?? target
    }),
    url: () => url,
  }
  return page as unknown as Page & typeof page
}

describe('copilot:open-sign-in', () => {
  it('opens the chat page in the Copilot profile, brings it to the front, and reports signed in when the chat shows', async () => {
    const page = fakePage()
    const getPage = vi.fn(async () => page)
    const probe = vi.fn(async (): Promise<CopilotPageState> => 'chat')
    const handler = createOpenCopilotSignInHandler({ pages: { getPage }, settings, probe })

    const status = await handler()

    expect(getPage).toHaveBeenCalledWith(Subject.COPILOT)
    expect(page.bringToFront).toHaveBeenCalledTimes(1)
    expect(page.goto).toHaveBeenCalledWith('https://copilot.cloud.microsoft/chat', expect.objectContaining({ waitUntil: 'domcontentloaded' }))
    expect(probe).toHaveBeenCalledWith(page, settings)
    expect(status).toEqual({
      product: 'm365',
      label: settings.label,
      chatUrl: 'https://copilot.cloud.microsoft/chat',
      url: 'https://copilot.cloud.microsoft/chat',
      state: 'chat',
      signedIn: true,
    })
  })

  it('reports signed out with the landing page, without its query string', async () => {
    const page = fakePage({ landsOn: 'https://copilot.com/?redirect=chat&state=secret' })
    const handler = createOpenCopilotSignInHandler({
      pages: { getPage: async () => page },
      settings,
      probe: async () => 'signed_out',
    })

    await expect(handler()).resolves.toMatchObject({ url: 'https://copilot.com/', state: 'signed_out', signedIn: false })
  })

  it('fails with the unreachable message when the chat page cannot be loaded', async () => {
    const page = fakePage({ failWith: 'page.goto: net::ERR_INTERNET_DISCONNECTED at https://copilot.cloud.microsoft/chat' })
    const handler = createOpenCopilotSignInHandler({ pages: { getPage: async () => page }, settings, probe: async () => 'chat' })

    await expect(handler()).rejects.toThrow(SubjectUnreachableError)
    await expect(handler()).rejects.toThrow(/Could not reach the Microsoft Copilot at https:\/\/copilot\.cloud\.microsoft\/chat.*ERR_INTERNET_DISCONNECTED/)
  })
})
