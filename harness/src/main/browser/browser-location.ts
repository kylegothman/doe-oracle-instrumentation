import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the harness gets its Chromium (story #44).
 *
 * In development Playwright finds the browser itself, in the user's cache
 * (`npm run setup:browser` puts it there). The installed app cannot rely on
 * that cache: a clean machine has none. So the installer ships the pinned
 * build under resources/browser, next to a manifest that
 * scripts/bundle-browser.mjs writes at packaging time, and the packaged app
 * launches exactly that copy. It never falls back to the cache or to a
 * browser installed on the machine, so every run uses the same build.
 */

/** Folder under the app's resources that holds the bundled browser. */
export const BUNDLED_BROWSER_DIR = 'browser'
/** The manifest inside that folder. */
export const BROWSER_MANIFEST_FILE = 'browser.json'

/** What scripts/bundle-browser.mjs records about the browser it bundled. */
export interface BrowserManifest {
  /** The Playwright version that pinned this build. */
  playwrightVersion: string
  /** Playwright's revision of the build, for example "1254". */
  revision: string
  /** The browser's own version, for example "158.0.8127.18". */
  browserVersion: string
  /** Path of the executable under the browser folder, with forward slashes. */
  executable: string
}

export type BrowserLocation =
  /** Development: Playwright looks in its own cache. */
  | { source: 'cache' }
  /** Packaged, and the bundled browser is where the manifest says. */
  | { source: 'bundled'; executablePath: string; manifest: BrowserManifest }
  /** Packaged, but the bundled browser cannot be used. `problem` says why. */
  | { source: 'unusable'; problem: string }

/** The file-system calls the lookup makes. Tests pass fakes. */
export interface BrowserLocationFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
}

export interface BrowserLocationInput {
  /** Electron's app.isPackaged. */
  isPackaged: boolean
  /** Electron's process.resourcesPath. */
  resourcesPath: string
  fs?: BrowserLocationFs
}

/**
 * Decides which Chromium the harness launches. Never throws: a packaged app
 * whose browser is missing gets an `unusable` location, and the problem is
 * reported when a trial (or the self-check) tries to launch it.
 */
export function resolveBrowserLocation(input: BrowserLocationInput): BrowserLocation {
  if (!input.isPackaged) {
    return { source: 'cache' }
  }
  const fs = input.fs ?? { existsSync, readFileSync }
  const browserDir = join(input.resourcesPath, BUNDLED_BROWSER_DIR)
  const manifestPath = join(browserDir, BROWSER_MANIFEST_FILE)

  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch {
    return { source: 'unusable', problem: `${manifestPath} could not be read` }
  }
  let manifest: BrowserManifest
  try {
    manifest = parseManifest(JSON.parse(raw))
  } catch (error) {
    return { source: 'unusable', problem: `${manifestPath} is not valid: ${describe(error)}` }
  }
  const executablePath = join(browserDir, ...manifest.executable.split('/'))
  if (!fs.existsSync(executablePath)) {
    return { source: 'unusable', problem: `${executablePath} does not exist` }
  }
  return { source: 'bundled', executablePath, manifest }
}

function parseManifest(value: unknown): BrowserManifest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected an object')
  }
  const fields = value as Record<string, unknown>
  const text = (name: keyof BrowserManifest): string => {
    const field = fields[name]
    if (typeof field !== 'string' || field.trim().length === 0) {
      throw new Error(`"${name}" must be a non-empty string`)
    }
    return field
  }
  const manifest: BrowserManifest = {
    playwrightVersion: text('playwrightVersion'),
    revision: text('revision'),
    browserVersion: text('browserVersion'),
    executable: text('executable'),
  }
  const segments = manifest.executable.split('/')
  if (manifest.executable.includes('\\') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('"executable" must be a relative path inside the browser folder, with forward slashes')
  }
  return manifest
}

/** What the installed user is told to do when the bundled browser cannot be used. */
const REINSTALL = 'Reinstall DOE Oracle Test Harness from its installer (the .msi file), then try again.'

/**
 * The message shown when Chromium cannot be started. `what` names the thing
 * being launched ("Chromium", or a subject's profile). An installed user is
 * never told to run a developer command: the only fix they have is the
 * installer.
 */
export function describeLaunchFailure(location: BrowserLocation, rawMessage: string, what = 'Chromium'): string {
  const packaged = location.source !== 'cache'
  if (/ProcessSingleton|profile .* in use|SingletonLock/i.test(rawMessage)) {
    return `Could not open the ${what}: another Chromium is using it. Close that window, then try again.`
  }
  if (/Executable doesn't exist/i.test(rawMessage)) {
    return packaged
      ? missingBundledBrowserMessage(firstLine(rawMessage))
      : "Playwright's Chromium is not installed. From harness/, run `npm run setup:browser`, then try again."
  }
  if (packaged) {
    return `Could not launch ${what}: ${rawMessage} If this keeps happening, the browser that ships with the harness may be damaged. ${REINSTALL}`
  }
  return `Could not launch ${what}: ${rawMessage}`
}

/** The message for a packaged app whose bundled browser is missing or damaged. */
export function missingBundledBrowserMessage(problem: string): string {
  return `The browser that ships with the harness is missing or damaged (${problem}). ${REINSTALL}`
}

function firstLine(message: string): string {
  return message.split('\n')[0]?.trim() ?? message
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
