import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeLaunchFailure,
  missingBundledBrowserMessage,
  resolveBrowserLocation,
  type BrowserLocation,
  type BrowserLocationFs,
  type BrowserManifest,
} from './browser-location'

const RESOURCES = join('/opt', 'harness', 'resources')
const MANIFEST_PATH = join(RESOURCES, 'browser', 'browser.json')
const MANIFEST: BrowserManifest = {
  playwrightVersion: '1.65.0',
  revision: '1254',
  browserVersion: '158.0.8127.18',
  executable: 'chromium-1254/chrome-win64/chrome.exe',
}
const EXECUTABLE_PATH = join(RESOURCES, 'browser', 'chromium-1254', 'chrome-win64', 'chrome.exe')

/** A fake file system holding the given text files; existsSync is true for those paths and any in `present`. */
function fakeFs(files: Record<string, string>, present: string[] = []): BrowserLocationFs {
  return {
    existsSync: (path) => path in files || present.includes(path),
    readFileSync: (path) => {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      return content
    },
  }
}

describe('resolveBrowserLocation', () => {
  it("leaves the browser to Playwright's cache in development, without reading anything", () => {
    const fs: BrowserLocationFs = {
      existsSync: () => {
        throw new Error('must not be called')
      },
      readFileSync: () => {
        throw new Error('must not be called')
      },
    }

    expect(resolveBrowserLocation({ isPackaged: false, resourcesPath: RESOURCES, fs })).toEqual({ source: 'cache' })
  })

  it('uses the bundled browser named by the manifest in a packaged app', () => {
    const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify(MANIFEST) }, [EXECUTABLE_PATH])

    expect(resolveBrowserLocation({ isPackaged: true, resourcesPath: RESOURCES, fs })).toEqual({
      source: 'bundled',
      executablePath: EXECUTABLE_PATH,
      manifest: MANIFEST,
    })
  })

  it('keeps only the fields it knows from the manifest', () => {
    const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify({ ...MANIFEST, platform: 'win32', notices: ['ABOUT'] }) }, [EXECUTABLE_PATH])

    const location = resolveBrowserLocation({ isPackaged: true, resourcesPath: RESOURCES, fs })

    expect(location).toMatchObject({ source: 'bundled', manifest: MANIFEST })
  })

  it('never falls back to the cache when a packaged app has no manifest', () => {
    const location = resolveBrowserLocation({ isPackaged: true, resourcesPath: RESOURCES, fs: fakeFs({}) })

    expect(location).toEqual({ source: 'unusable', problem: `${MANIFEST_PATH} could not be read` })
  })

  it('reports a manifest that is not JSON or lacks a field', () => {
    const notJson = resolveBrowserLocation({ isPackaged: true, resourcesPath: RESOURCES, fs: fakeFs({ [MANIFEST_PATH]: '{' }) })
    expect(notJson).toMatchObject({ source: 'unusable', problem: expect.stringContaining('is not valid') })

    const withoutExecutable = { playwrightVersion: MANIFEST.playwrightVersion, revision: MANIFEST.revision, browserVersion: MANIFEST.browserVersion }
    const incomplete = resolveBrowserLocation({
      isPackaged: true,
      resourcesPath: RESOURCES,
      fs: fakeFs({ [MANIFEST_PATH]: JSON.stringify(withoutExecutable) }),
    })
    expect(incomplete).toMatchObject({ source: 'unusable', problem: expect.stringContaining('"executable" must be a non-empty string') })
  })

  it.each(['../outside/chrome.exe', '/abs/chrome.exe', 'chromium-1254\\chrome-win64\\chrome.exe', 'chromium-1254//chrome.exe'])(
    'rejects an executable path that could leave the browser folder: %s',
    (executable) => {
      const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify({ ...MANIFEST, executable }) })

      const location = resolveBrowserLocation({ isPackaged: true, resourcesPath: RESOURCES, fs })

      expect(location).toMatchObject({ source: 'unusable', problem: expect.stringContaining('relative path inside the browser folder') })
    },
  )

  it('reports a manifest whose executable is not on disk', () => {
    const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify(MANIFEST) })

    expect(resolveBrowserLocation({ isPackaged: true, resourcesPath: RESOURCES, fs })).toEqual({
      source: 'unusable',
      problem: `${EXECUTABLE_PATH} does not exist`,
    })
  })
})

describe('describeLaunchFailure', () => {
  const cache: BrowserLocation = { source: 'cache' }
  const bundled: BrowserLocation = { source: 'bundled', executablePath: EXECUTABLE_PATH, manifest: MANIFEST }
  const missing = "browserType.launch: Executable doesn't exist at /x/chrome\n╔═══╗ Looks like Playwright was just installed"

  it('tells a developer to run the setup script when the cache has no browser', () => {
    expect(describeLaunchFailure(cache, missing)).toMatch(/npm run setup:browser/)
  })

  it('tells an installed user to reinstall, and never mentions npm', () => {
    const playwrightWithPath = `browserType.launch: Failed to launch chromium because executable doesn't exist at ${EXECUTABLE_PATH}`

    for (const raw of [missing, playwrightWithPath, 'spawn EACCES']) {
      const message = describeLaunchFailure(bundled, raw)
      expect(message).toMatch(/Reinstall DOE Oracle Test Harness from its installer \(the \.msi file\)/)
      expect(message).not.toMatch(/npm|setup:browser|Playwright was just installed/i)
    }
    expect(describeLaunchFailure(bundled, playwrightWithPath)).toContain(EXECUTABLE_PATH)
  })

  it('keeps the underlying reason for any other failure', () => {
    expect(describeLaunchFailure(cache, 'spawn EACCES')).toBe('Could not launch Chromium: spawn EACCES')
    expect(describeLaunchFailure(bundled, 'spawn EACCES', 'Microsoft Copilot profile at C:\\p')).toMatch(
      /^Could not launch Microsoft Copilot profile at C:\\p: spawn EACCES /,
    )
  })

  it('says another Chromium holds the profile, in both modes, without suggesting a reinstall', () => {
    for (const location of [cache, bundled]) {
      const message = describeLaunchFailure(location, 'Failed to launch: ProcessSingleton lock held', 'Microsoft Copilot profile at /p')
      expect(message).toBe('Could not open the Microsoft Copilot profile at /p: another Chromium is using it. Close that window, then try again.')
    }
  })
})

describe('missingBundledBrowserMessage', () => {
  it('names the problem and the fix an installed user has', () => {
    const message = missingBundledBrowserMessage(`${MANIFEST_PATH} could not be read`)

    expect(message).toContain(MANIFEST_PATH)
    expect(message).toMatch(/missing or damaged/)
    expect(message).toMatch(/Reinstall DOE Oracle Test Harness from its installer/)
    expect(message).not.toMatch(/npm/i)
  })
})
