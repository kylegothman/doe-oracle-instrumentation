import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLocation } from '../browser/browser-location'
import type { BrowserLauncher } from '../browser/browser-manager'
import { browserCheck, EXPECTED_QUESTION_COUNT, questionsCheck, SELF_CHECK_DB_FILE, sqliteCheck } from './checks'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'self-check-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeQuestions(count: number): string {
  const filePath = join(dir, 'questions.json')
  const questions = Array.from({ length: count }, (_, index) => ({ number: index + 1, text: `Question ${index + 1}?` }))
  writeFileSync(filePath, JSON.stringify({ questions }))
  return filePath
}

describe('questionsCheck', () => {
  it('passes on the questions file the harness ships', async () => {
    const shipped = join(__dirname, '..', '..', '..', 'config', 'questions.json')

    await expect(questionsCheck(shipped).run()).resolves.toMatch(new RegExp(`^${EXPECTED_QUESTION_COUNT} questions loaded from `))
  })

  it('fails when the file is missing, naming the path', async () => {
    const missing = join(dir, 'config', 'questions.json')

    await expect(questionsCheck(missing).run()).rejects.toThrow(missing)
  })

  it('fails when the file does not hold all 12 questions', async () => {
    await expect(questionsCheck(writeQuestions(11)).run()).rejects.toThrow(/has 11 questions, expected 12/)
  })
})

describe('sqliteCheck', () => {
  it('opens a scratch database in the data folder, removes it, and never creates harness.db', async () => {
    const userData = join(dir, 'user data')

    const detail = await sqliteCheck(userData).run()

    expect(detail).toMatch(/^SQLite \d+\.\d+\.\d+ loaded; opened .*self-check\.db at schema version \d+, then removed it$/)
    expect(readdirSync(userData)).toEqual([])
  })

  it('leaves an existing harness.db and other files alone', async () => {
    writeFileSync(join(dir, 'harness.db'), 'real data')
    writeFileSync(join(dir, SELF_CHECK_DB_FILE), 'left over from an interrupted run')

    await sqliteCheck(dir).run()

    expect(readdirSync(dir)).toEqual(['harness.db'])
  })

  it('fails when the data folder cannot be used', async () => {
    const blocked = join(dir, 'not-a-folder')
    writeFileSync(blocked, '')

    await expect(sqliteCheck(blocked).run()).rejects.toThrow()
  })
})

/** A fake Playwright launcher whose pages behave like a working browser of the given version. */
function fakeLauncher(version: string, overrides: { status?: string | null } = {}) {
  const urls: string[] = []
  const makePage = (browser: unknown): Page => {
    const page = {
      isClosed: () => false,
      goto: vi.fn(async (url: string) => {
        urls.push(url)
        return null
      }),
      setContent: vi.fn(async () => undefined),
      textContent: vi.fn(async () => (overrides.status === undefined ? 'ok' : overrides.status)),
      evaluate: vi.fn(async () => 2),
      context: () => ({ browser: () => browser }),
    }
    return page as unknown as Page
  }
  const browser = {
    isConnected: () => true,
    on: vi.fn(),
    version: () => version,
    newContext: vi.fn(async () => ({ newPage: async () => makePage(browser) })),
    close: vi.fn(async () => undefined),
  }
  const context = {
    pages: () => [] as Page[],
    newPage: vi.fn(async () => makePage(null)),
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  }
  const launcher: BrowserLauncher = {
    launch: vi.fn(async () => browser as unknown as Browser),
    launchPersistentContext: vi.fn(async () => context as unknown as BrowserContext),
  }
  return { launcher, browser, context, urls }
}

describe('browserCheck', () => {
  const manifest = { playwrightVersion: '1.65.0', revision: '1254', browserVersion: '158.0.8127.18', executable: 'chromium-1254/chrome-win64/chrome.exe' }
  const bundled: BrowserLocation = { source: 'bundled', executablePath: '/app/resources/browser/chromium-1254/chrome-win64/chrome.exe', manifest }

  it('launches the bundled browser headed, shared and on the scratch profile, and opens only blank and local pages', async () => {
    const fake = fakeLauncher('158.0.8127.18')
    const profileDir = join(dir, 'self-check', 'profile')

    const detail = await browserCheck({ location: bundled, profileDir, packaged: true, launcher: fake.launcher }).run()

    const expected = { headless: false, executablePath: bundled.executablePath }
    expect(fake.launcher.launch).toHaveBeenCalledWith(expected)
    expect(fake.launcher.launchPersistentContext).toHaveBeenCalledWith(profileDir, expected)
    expect(fake.urls).toEqual(['about:blank', 'about:blank'])
    expect(detail).toBe(`Chromium 158.0.8127.18 from ${bundled.executablePath} opened a page, in the shared browser and on a scratch profile`)
    // Everything it started is closed, and the scratch profile is gone.
    expect(fake.browser.close).toHaveBeenCalledTimes(1)
    expect(fake.context.close).toHaveBeenCalledTimes(1)
    expect(existsSync(profileDir)).toBe(false)
  })

  it('fails when the browser that launched is not the pinned version', async () => {
    const fake = fakeLauncher('131.0.6778.33')

    await expect(browserCheck({ location: bundled, profileDir: join(dir, 'p'), packaged: true, launcher: fake.launcher }).run()).rejects.toThrow(
      /version 131\.0\.6778\.33, but browser\.json pins 158\.0\.8127\.18/,
    )
    expect(fake.browser.close).toHaveBeenCalledTimes(1)
  })

  it('fails when the page does not render', async () => {
    const fake = fakeLauncher('158.0.8127.18', { status: null })

    await expect(browserCheck({ location: bundled, profileDir: join(dir, 'p'), packaged: true, launcher: fake.launcher }).run()).rejects.toThrow(
      /did not render/,
    )
  })

  it('fails without launching when a packaged app has no usable bundled browser', async () => {
    const fake = fakeLauncher('158.0.8127.18')
    const unusable: BrowserLocation = { source: 'unusable', problem: 'browser.json could not be read' }

    await expect(browserCheck({ location: unusable, profileDir: join(dir, 'p'), packaged: true, launcher: fake.launcher }).run()).rejects.toThrow(
      /missing or damaged \(browser\.json could not be read\)/,
    )
    expect(fake.launcher.launch).not.toHaveBeenCalled()
  })

  it("refuses the Playwright cache in a packaged app, and accepts it in development", async () => {
    const fake = fakeLauncher('158.0.8127.18')
    const cache: BrowserLocation = { source: 'cache' }

    await expect(browserCheck({ location: cache, profileDir: join(dir, 'p'), packaged: true, launcher: fake.launcher }).run()).rejects.toThrow(
      /must use its bundled browser/,
    )
    await expect(browserCheck({ location: cache, profileDir: join(dir, 'p'), packaged: false, launcher: fake.launcher }).run()).resolves.toMatch(
      /from Playwright's cache/,
    )
  })
})
