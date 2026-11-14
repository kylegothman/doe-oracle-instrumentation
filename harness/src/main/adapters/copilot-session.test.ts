import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadSettings, type CopilotSettings } from '../config/settings'
import { copilotPageState, isSignInHost, probeCopilotPage, safePageUrl } from './copilot-session'

const SETTINGS: CopilotSettings = { ...loadSettings({}).copilot, chatUrl: 'https://copilot.test/chat' }
const BROWSER_TEST_TIMEOUT_MS = 30_000

const CHAT_PAGE = `<!doctype html><title>Copilot</title>
<main><h1>Hi, what can I help you with?</h1>
<span id="m365-chat-editor-target-element" role="textbox" aria-label="Message Copilot" contenteditable="true"><p>&#8203;</p></span>
<button aria-label="Send">Send</button></main>`
const SIGN_IN_PAGE = `<!doctype html><title>Microsoft Copilot | Sign in</title>
<main><h1>Sign into Copilot</h1><button>Sign in</button></main>`
const OFFLINE_PAGE = `<!doctype html><title>Copilot</title>
<main><img alt="No network connection" src="data:," /><p>No internet connection. Check your connection.</p><button disabled>Offline</button></main>`
const LATE_CHAT_PAGE = `<!doctype html><title>Copilot</title><main><p>Loading…</p></main>
<script>setTimeout(() => { document.querySelector('main').innerHTML = ${JSON.stringify(CHAT_PAGE.replace(/^[\s\S]*?<main>/, '').replace('</main>', ''))} }, 300)</script>`

describe('Copilot page state', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch()
  }, BROWSER_TEST_TIMEOUT_MS)

  afterAll(async () => {
    await browser?.close()
  })

  beforeEach(async () => {
    page = await browser.newPage()
  })

  afterEach(async () => {
    await page.close()
  })

  /** Serves one HTML page for every URL on a host. */
  async function serve(host: string, html: string): Promise<void> {
    await page.route(`https://${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }))
  }

  it('sees the chat when the question input is on the page', async () => {
    await serve('copilot.test', CHAT_PAGE)
    await page.goto('https://copilot.test/chat')

    expect(await copilotPageState(page, SETTINGS)).toBe('chat')
    expect(await probeCopilotPage(page, SETTINGS)).toBe('chat')
  }, BROWSER_TEST_TIMEOUT_MS)

  it('sees signed out on the sign-in landing page, by its heading', async () => {
    await serve('copilot.test', SIGN_IN_PAGE)
    await page.goto('https://copilot.test/')

    expect(await copilotPageState(page, SETTINGS)).toBe('signed_out')
  }, BROWSER_TEST_TIMEOUT_MS)

  it('sees signed out on a sign-in host whatever the page shows', async () => {
    await serve('login.microsoftonline.com', '<!doctype html><title>Sign in</title><form><input name="loginfmt" /></form>')
    await page.goto('https://login.microsoftonline.com/common/oauth2/authorize?state=abc')

    expect(await copilotPageState(page, SETTINGS)).toBe('signed_out')
    expect(safePageUrl(page)).toBe('https://login.microsoftonline.com/common/oauth2/authorize')
  }, BROWSER_TEST_TIMEOUT_MS)

  it('sees offline on the no-connection screen', async () => {
    await serve('copilot.test', OFFLINE_PAGE)
    await page.goto('https://copilot.test/chat')

    expect(await copilotPageState(page, SETTINGS)).toBe('offline')
  }, BROWSER_TEST_TIMEOUT_MS)

  it('keeps probing until the input is rendered, and gives up as unknown when nothing appears in time', async () => {
    await serve('copilot.test', LATE_CHAT_PAGE)
    await page.goto('https://copilot.test/chat')

    expect(await copilotPageState(page, SETTINGS)).toBe('unknown')
    expect(await probeCopilotPage(page, SETTINGS, { timeoutMs: 5_000 })).toBe('chat')

    await serve('elsewhere.test', '<!doctype html><title>Something else</title><p>Not Copilot</p>')
    await page.goto('https://elsewhere.test/')
    expect(await probeCopilotPage(page, SETTINGS, { timeoutMs: 600 })).toBe('unknown')
  }, BROWSER_TEST_TIMEOUT_MS)
})

describe('isSignInHost', () => {
  const hosts = ['copilot.com', 'login.microsoftonline.com']

  it('matches a listed host and its subdomains, not a lookalike or the chat host', () => {
    expect(isSignInHost('https://copilot.com/', hosts)).toBe(true)
    expect(isSignInHost('https://login.microsoftonline.com/common/oauth2?x=1', hosts)).toBe(true)
    expect(isSignInHost('https://sso.login.microsoftonline.com/', hosts)).toBe(true)
    expect(isSignInHost('https://copilot.cloud.microsoft/chat', hosts)).toBe(false)
    expect(isSignInHost('https://notcopilot.com/', hosts)).toBe(false)
    expect(isSignInHost('not a url', hosts)).toBe(false)
  })
})
