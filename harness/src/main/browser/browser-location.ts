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
 *
 * The manifest also records the platform and architecture the browser was
 * fetched for. A bundle made for another platform is refused with a message
 * that says so, not as a damaged install.
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
  /** Node's process.platform when the browser was fetched, for example "win32". */
  platform: string
  /** Node's process.arch when the browser was fetched, for example "x64". */
  arch: string
}

/**
 * What an installed user can do about a bundled browser that cannot be used:
 * - `reinstall`: files are missing or damaged, and the installer has good ones;
 * - `new-installer`: the installer itself carries the wrong browser, so
 *   running it again changes nothing.
 */
export type UnusableRemedy = 'reinstall' | 'new-installer'

/** Packaged, but the bundled browser cannot be used. `problem` says why. */
export interface UnusableBrowser {
  source: 'unusable'
  problem: string
  remedy: UnusableRemedy
}

export type BrowserLocation =
  /** Development: Playwright looks in its own cache. */
  | { source: 'cache' }
  /** Packaged, and the bundled browser is where the manifest says. */
  | { source: 'bundled'; executablePath: string; manifest: BrowserManifest }
  | UnusableBrowser

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
  /**
   * What this app was built for: process.platform and process.arch unless
   * given. This is the app's own build, not the machine's processor. An x64
   * build of the harness running on Windows on ARM reports "x64", and its
   * x64 browser runs there the same way the app does, so that is a match.
   */
  platform?: string
  arch?: string
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
    return { source: 'unusable', problem: `${manifestPath} could not be read`, remedy: 'reinstall' }
  }
  let fields: Record<string, unknown>
  let located: Omit<BrowserManifest, 'platform' | 'arch'>
  try {
    fields = asObject(JSON.parse(raw))
    located = parseManifest(fields)
  } catch (error) {
    return { source: 'unusable', problem: `${manifestPath} is not valid: ${describe(error)}`, remedy: 'reinstall' }
  }

  // A manifest that parses but does not say what the browser is for was
  // written by a packaging step that went wrong, not damaged afterwards.
  const { platform, arch } = fields
  if (!isText(platform) || !isText(arch)) {
    const names = [isText(platform) ? null : '"platform"', isText(arch) ? null : '"arch"'].filter((name) => name !== null).join(' and ')
    return {
      source: 'unusable',
      problem: `The browser in this installer does not say what it was built for: ${manifestPath} has no ${names}, so the harness cannot check that it fits this computer.`,
      remedy: 'new-installer',
    }
  }
  const appPlatform = input.platform ?? process.platform
  const appArch = input.arch ?? process.arch
  if (platform !== appPlatform || arch !== appArch) {
    return {
      source: 'unusable',
      problem: `The browser in this installer was built for ${describeBuild(platform, arch)}, but this harness is the ${describeBuild(appPlatform, appArch)} build.`,
      remedy: 'new-installer',
    }
  }

  const manifest: BrowserManifest = { ...located, platform, arch }
  const executablePath = join(browserDir, ...manifest.executable.split('/'))
  if (!fs.existsSync(executablePath)) {
    return { source: 'unusable', problem: `${executablePath} does not exist`, remedy: 'reinstall' }
  }
  return { source: 'bundled', executablePath, manifest }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object')
  }
  return value as Record<string, unknown>
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** The names people use for Node's platform codes. */
const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

/** A platform and architecture in plain words, for example "Windows (x64)". */
function describeBuild(platform: string, arch: string): string {
  return `${PLATFORM_NAMES[platform] ?? platform} (${arch})`
}

function parseManifest(fields: Record<string, unknown>): Omit<BrowserManifest, 'platform' | 'arch'> {
  const text = (name: keyof BrowserManifest): string => {
    const field = fields[name]
    if (!isText(field)) {
      throw new Error(`"${name}" must be a non-empty string`)
    }
    return field
  }
  const manifest = {
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

/** What the installed user is told to do when the bundled browser is missing or damaged. */
const REINSTALL = 'Reinstall DOE Oracle Test Harness from its installer (the .msi file), then try again.'
/** What they are told when the installer itself carries the wrong browser. */
const NEW_INSTALLER = 'Reinstalling will not fix it. Ask the team for the installer built for this computer.'

/** What is being launched: the shared Chromium, or a subject's browser profile. */
export type LaunchTarget =
  | { kind: 'browser' }
  /** `label` names the subject ("Microsoft Copilot"); `profileDir` is its profile folder. */
  | { kind: 'profile'; label: string; profileDir: string }

/**
 * The message shown when Chromium cannot be started. An installed user is
 * never told to run a developer command.
 *
 * The advice depends on what failed. The bundled browser lives in the
 * program folder, so the installer can put it back: reinstall. A profile
 * lives in the per-user data folder, which uninstall keeps, so reinstalling
 * changes nothing about it: the Tester is pointed at the profile folder
 * instead, and told that a new profile means signing in again.
 */
export function describeLaunchFailure(location: BrowserLocation, rawMessage: string, target: LaunchTarget = { kind: 'browser' }): string {
  const packaged = location.source !== 'cache'
  const profile = target.kind === 'profile' ? `${target.label} profile at ${target.profileDir}` : null
  if (/ProcessSingleton|profile .* in use|SingletonLock/i.test(rawMessage)) {
    return `Could not open the ${profile ?? 'Chromium'}: another Chromium is using it. Close that window, then try again.`
  }
  if (/Executable doesn't exist/i.test(rawMessage)) {
    return packaged
      ? missingBundledBrowserMessage(firstLine(rawMessage))
      : "Playwright's Chromium is not installed. From harness/, run `npm run setup:browser`, then try again."
  }
  if (target.kind === 'profile') {
    const reason = firstLine(rawMessage).replace(/[.\s]+$/, '')
    const rest = rawMessage.split('\n').slice(1).join('\n').trim()
    return (
      `Could not open the ${profile}: ${reason}. The profile folder may be damaged. ` +
      'Close the harness, rename or delete that folder, and start the harness again. ' +
      `It will create a new profile, and you will need to sign in to ${target.label} again.` +
      (rest ? `\nDetails: ${rest}` : '')
    )
  }
  if (packaged) {
    return `Could not launch Chromium: ${rawMessage} If this keeps happening, the browser that ships with the harness may be damaged. ${REINSTALL}`
  }
  return `Could not launch Chromium: ${rawMessage}`
}

/** The message for a packaged app whose bundled browser is missing or damaged. */
export function missingBundledBrowserMessage(problem: string): string {
  return `The browser that ships with the harness is missing or damaged (${problem}). ${REINSTALL}`
}

/** The message for a packaged app whose bundled browser cannot be used, with the fix that can work. */
export function unusableBrowserMessage(location: UnusableBrowser): string {
  return location.remedy === 'new-installer' ? `${location.problem} ${NEW_INSTALLER}` : missingBundledBrowserMessage(location.problem)
}

function firstLine(message: string): string {
  return message.split('\n')[0]?.trim() ?? message
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
