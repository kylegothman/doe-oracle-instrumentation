import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Subject } from '../../shared/subjects'
import type { BrowserLocation } from '../browser/browser-location'
import { BrowserManager, type BrowserLauncher } from '../browser/browser-manager'
import { MetricsRepository } from '../data/metrics-repository'
import { probeSqlite } from '../data/sqlite'
import { QuestionBank } from '../execution/question-bank'
import type { Check } from './self-check'

/** How many standard questions the harness ships with. */
export const EXPECTED_QUESTION_COUNT = 12

/** The scratch database the SQLite check opens. Never harness.db. */
export const SELF_CHECK_DB_FILE = 'self-check.db'
/** The folder under the per-user data folder for the report and the scratch browser profile. */
export const SELF_CHECK_DIR = 'self-check'

/** How long the browser check may take: two launches, two pages, and closing both. */
export const BROWSER_CHECK_TIMEOUT_MS = 120_000

/** The page the browser check shows. Set from a string: nothing is fetched from anywhere. */
const LOCAL_PAGE = '<!doctype html><title>DOE Oracle Test Harness self-check</title><p id="status">ok</p>'

/** The questions config loads from where the app looks for it, with every question. */
export function questionsCheck(configPath: string): Check {
  return {
    name: 'questions',
    timeoutMs: 10_000,
    run: async () => {
      const bank = QuestionBank.load(configPath)
      if (bank.size !== EXPECTED_QUESTION_COUNT) {
        throw new Error(`${configPath} has ${bank.size} questions, expected ${EXPECTED_QUESTION_COUNT}`)
      }
      return `${bank.size} questions loaded from ${configPath}`
    },
  }
}

/**
 * better-sqlite3 loads, and a database opens in the per-user data folder
 * through the same code a normal launch uses, migrations included. The
 * database is a scratch file that is removed afterwards; harness.db is not
 * opened, so the check cannot add a session to real data.
 */
export function sqliteCheck(userDataDir: string): Check {
  return {
    name: 'sqlite',
    timeoutMs: 30_000,
    run: async () => {
      const status = await probeSqlite()
      if (!status.ok) {
        throw new Error(`better-sqlite3 failed to load: ${status.error}`)
      }
      mkdirSync(userDataDir, { recursive: true })
      const filePath = join(userDataDir, SELF_CHECK_DB_FILE)
      removeDatabase(filePath)
      let schemaVersion: number
      try {
        const repository = await MetricsRepository.open(filePath)
        try {
          schemaVersion = repository.schemaVersion
        } finally {
          repository.close()
        }
        if (!existsSync(filePath)) {
          throw new Error(`opening ${filePath} created no file`)
        }
      } finally {
        removeDatabase(filePath)
      }
      return `SQLite ${status.version} loaded; opened ${filePath} at schema version ${schemaVersion}, then removed it`
    },
  }
}

function removeDatabase(filePath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${filePath}${suffix}`, { force: true })
  }
}

export interface BrowserCheckOptions {
  location: BrowserLocation
  /** A scratch profile folder for the persistent launch. Removed afterwards. */
  profileDir: string
  /** Whether the app is packaged. A packaged app must use the bundled browser. */
  packaged: boolean
  /** Tests pass a fake; the app uses Playwright. */
  launcher?: BrowserLauncher
  /** Replaces the check's time limit. Only the testing flag sets it. */
  timeoutMs?: number
}

/**
 * The Chromium a real trial would use launches and opens a page, through
 * BrowserManager, both ways the harness launches it: the shared browser (the
 * Oracle) and a persistent profile (Copilot, here on a scratch folder, never
 * the real profile). Headed, as in a trial. The pages are about:blank and a
 * page set from a string, so nothing outside the machine is contacted.
 */
export function browserCheck(options: BrowserCheckOptions): Check {
  return {
    name: 'browser',
    timeoutMs: options.timeoutMs ?? BROWSER_CHECK_TIMEOUT_MS,
    run: async () => {
      const { location, profileDir } = options
      if (options.packaged && location.source === 'cache') {
        throw new Error('a packaged app must use its bundled browser, not the Playwright cache')
      }
      rmSync(profileDir, { recursive: true, force: true })
      // The scratch profile stands in for Copilot's so the persistent launch
      // goes through the same code. Copilot itself is never opened.
      const manager = new BrowserManager({
        location,
        profiles: { [Subject.COPILOT]: profileDir },
        ...(options.launcher ? { launcher: options.launcher } : {}),
      })
      try {
        const page = await manager.getPage(Subject.DOE_ORACLE)
        await page.goto('about:blank')
        await page.setContent(LOCAL_PAGE)
        const status = await page.textContent('#status')
        if (status !== 'ok') {
          throw new Error(`the local test page did not render: read "${String(status)}"`)
        }
        const version = page.context().browser()?.version() ?? 'unknown'
        if (location.source === 'bundled' && version !== location.manifest.browserVersion) {
          throw new Error(`the bundled browser is version ${version}, but browser.json pins ${location.manifest.browserVersion}`)
        }

        const profilePage = await manager.getPage(Subject.COPILOT)
        await profilePage.goto('about:blank')
        const sum = await profilePage.evaluate('1 + 1')
        if (sum !== 2) {
          throw new Error(`the page on the scratch profile could not run a script: got ${String(sum)}`)
        }

        const from = location.source === 'bundled' ? location.executablePath : "Playwright's cache"
        return `Chromium ${version} from ${from} opened a page, in the shared browser and on a scratch profile`
      } finally {
        await manager.close().catch(() => undefined)
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    },
  }
}
