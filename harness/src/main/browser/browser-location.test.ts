import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeLaunchFailure,
  missingBundledBrowserMessage,
  resolveBrowserLocation,
  unusableBrowserMessage,
  type BrowserLocation,
  type BrowserLocationFs,
  type BrowserManifest,
  type LaunchTarget,
} from './browser-location'

const RESOURCES = join('/opt', 'harness', 'resources')
const MANIFEST_PATH = join(RESOURCES, 'browser', 'browser.json')
const MANIFEST: BrowserManifest = {
  playwrightVersion: '1.65.0',
  revision: '1254',
  browserVersion: '158.0.8127.18',
  executable: 'chromium-1254/chrome-win64/chrome.exe',
  platform: 'win32',
  arch: 'x64',
}
/** The app the tests stand in for: the Windows x64 build, whatever machine runs the tests. */
const APP = { isPackaged: true, resourcesPath: RESOURCES, platform: 'win32', arch: 'x64' }
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

    expect(resolveBrowserLocation({ ...APP, fs })).toEqual({
      source: 'bundled',
      executablePath: EXECUTABLE_PATH,
      manifest: MANIFEST,
    })
  })

  it('keeps only the fields it knows from the manifest', () => {
    const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify({ ...MANIFEST, notices: ['ABOUT'], builtBy: 'ci' }) }, [EXECUTABLE_PATH])

    const location = resolveBrowserLocation({ ...APP, fs })

    expect(location).toEqual({ source: 'bundled', executablePath: EXECUTABLE_PATH, manifest: MANIFEST })
  })

  it('never falls back to the cache when a packaged app has no manifest', () => {
    const location = resolveBrowserLocation({ ...APP, fs: fakeFs({}) })

    expect(location).toEqual({ source: 'unusable', problem: `${MANIFEST_PATH} could not be read`, remedy: 'reinstall' })
  })

  it('reports a manifest that is not JSON or lacks a field', () => {
    const notJson = resolveBrowserLocation({ ...APP, fs: fakeFs({ [MANIFEST_PATH]: '{' }) })
    expect(notJson).toMatchObject({ source: 'unusable', problem: expect.stringContaining('is not valid') })

    const withoutExecutable = { playwrightVersion: MANIFEST.playwrightVersion, revision: MANIFEST.revision, browserVersion: MANIFEST.browserVersion }
    const incomplete = resolveBrowserLocation({ ...APP, fs: fakeFs({ [MANIFEST_PATH]: JSON.stringify(withoutExecutable) }) })
    expect(incomplete).toMatchObject({
      source: 'unusable',
      problem: expect.stringContaining('"executable" must be a non-empty string'),
      remedy: 'reinstall',
    })
  })

  it.each(['../outside/chrome.exe', '/abs/chrome.exe', 'chromium-1254\\chrome-win64\\chrome.exe', 'chromium-1254//chrome.exe'])(
    'rejects an executable path that could leave the browser folder: %s',
    (executable) => {
      const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify({ ...MANIFEST, executable }) })

      const location = resolveBrowserLocation({ ...APP, fs })

      expect(location).toMatchObject({ source: 'unusable', problem: expect.stringContaining('relative path inside the browser folder') })
    },
  )

  it('reports a manifest whose executable is not on disk', () => {
    const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify(MANIFEST) })

    expect(resolveBrowserLocation({ ...APP, fs })).toEqual({
      source: 'unusable',
      problem: `${EXECUTABLE_PATH} does not exist`,
      remedy: 'reinstall',
    })
  })

  describe('the platform the bundle was built for', () => {
    const MAC_MANIFEST = {
      ...MANIFEST,
      executable: 'chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      platform: 'darwin',
      arch: 'arm64',
    }

    it('reports a bundle for another platform as a mismatch, naming both sides, even when its executable is there', () => {
      const macExecutable = join(RESOURCES, 'browser', ...MAC_MANIFEST.executable.split('/'))
      const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify(MAC_MANIFEST) }, [macExecutable])

      const location = resolveBrowserLocation({ ...APP, fs })

      expect(location).toEqual({
        source: 'unusable',
        problem: 'The browser in this installer was built for macOS (arm64), but this harness is the Windows (x64) build.',
        remedy: 'new-installer',
      })
    })

    it('reports the same platform with another architecture as a mismatch', () => {
      const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify({ ...MANIFEST, arch: 'arm64' }) }, [EXECUTABLE_PATH])

      expect(resolveBrowserLocation({ ...APP, fs })).toMatchObject({
        source: 'unusable',
        problem: 'The browser in this installer was built for Windows (arm64), but this harness is the Windows (x64) build.',
        remedy: 'new-installer',
      })
    })

    it('accepts an x64 bundle in an x64 build of the harness running on Windows on ARM', () => {
      // Under emulation the app's own process.arch is still "x64": that is
      // what the app was built for, and what its browser has to match. The
      // machine's processor (ARM64 here) is never looked at.
      const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify(MANIFEST) }, [EXECUTABLE_PATH])
      const nativeArch = process.env.PROCESSOR_ARCHITEW6432
      process.env.PROCESSOR_ARCHITEW6432 = 'ARM64'
      try {
        expect(resolveBrowserLocation({ isPackaged: true, resourcesPath: RESOURCES, platform: 'win32', arch: 'x64', fs })).toEqual({
          source: 'bundled',
          executablePath: EXECUTABLE_PATH,
          manifest: MANIFEST,
        })
      } finally {
        if (nativeArch === undefined) delete process.env.PROCESSOR_ARCHITEW6432
        else process.env.PROCESSOR_ARCHITEW6432 = nativeArch
      }
    })

    it("compares with this process's own platform and architecture when none is given", () => {
      const own = { ...MANIFEST, platform: process.platform, arch: process.arch }
      const other = { ...MANIFEST, platform: process.platform, arch: process.arch === 'x64' ? 'arm64' : 'x64' }
      const resolve = (manifest: BrowserManifest): BrowserLocation =>
        resolveBrowserLocation({ isPackaged: true, resourcesPath: RESOURCES, fs: fakeFs({ [MANIFEST_PATH]: JSON.stringify(manifest) }, [EXECUTABLE_PATH]) })

      expect(resolve(own)).toMatchObject({ source: 'bundled' })
      expect(resolve(other)).toMatchObject({ source: 'unusable', remedy: 'new-installer' })
    })

    it('names a platform it has no plain word for as recorded', () => {
      const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify({ ...MANIFEST, platform: 'freebsd' }) }, [EXECUTABLE_PATH])

      expect(resolveBrowserLocation({ ...APP, fs })).toMatchObject({
        problem: 'The browser in this installer was built for freebsd (x64), but this harness is the Windows (x64) build.',
      })
    })

    it.each([
      ['platform', '"platform"'],
      ['arch', '"arch"'],
    ] as const)('says so when the manifest has no %s, instead of calling the install damaged', (field, named) => {
      const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify({ ...MANIFEST, [field]: undefined }) }, [EXECUTABLE_PATH])

      const location = resolveBrowserLocation({ ...APP, fs })

      expect(location).toEqual({
        source: 'unusable',
        problem: `The browser in this installer does not say what it was built for: ${MANIFEST_PATH} has no ${named}, so the harness cannot check that it fits this computer.`,
        remedy: 'new-installer',
      })
    })

    it('names both fields when a manifest from before they were recorded has neither, or they are empty', () => {
      // JSON.stringify leaves out a field whose value is undefined.
      const old = { ...MANIFEST, platform: undefined, arch: undefined }
      for (const manifest of [old, { ...old, platform: '', arch: 7 }]) {
        const fs = fakeFs({ [MANIFEST_PATH]: JSON.stringify(manifest) }, [EXECUTABLE_PATH])

        expect(resolveBrowserLocation({ ...APP, fs })).toMatchObject({
          source: 'unusable',
          problem: expect.stringContaining('has no "platform" and "arch"'),
          remedy: 'new-installer',
        })
      }
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

  it('keeps the underlying reason for any other failure of the browser itself', () => {
    expect(describeLaunchFailure(cache, 'spawn EACCES')).toBe('Could not launch Chromium: spawn EACCES')
    expect(describeLaunchFailure(bundled, 'spawn EACCES')).toBe(
      'Could not launch Chromium: spawn EACCES If this keeps happening, the browser that ships with the harness may be damaged. Reinstall DOE Oracle Test Harness from its installer (the .msi file), then try again.',
    )
  })

  describe('for a browser profile', () => {
    const profileDir = 'C:\\Users\\tester\\AppData\\Roaming\\DOE Oracle Test Harness\\browser-profiles\\copilot'
    const copilot: LaunchTarget = { kind: 'profile', label: 'Microsoft Copilot', profileDir }

    it('points at the profile folder and says what to do, in the installed app and in development', () => {
      for (const location of [cache, bundled]) {
        expect(describeLaunchFailure(location, 'browserType.launchPersistentContext: Target page, context or browser has been closed.', copilot)).toBe(
          `Could not open the Microsoft Copilot profile at ${profileDir}: browserType.launchPersistentContext: Target page, context or browser has been closed. ` +
            'The profile folder may be damaged. Close the harness, rename or delete that folder, and start the harness again. ' +
            'It will create a new profile, and you will need to sign in to Microsoft Copilot again.',
        )
      }
    })

    it('never says to reinstall: uninstalling keeps the profile, so a reinstall changes nothing', () => {
      const message = describeLaunchFailure(bundled, 'spawn EACCES', copilot)

      expect(message).not.toMatch(/reinstall|installer|\.msi/i)
      expect(message).toContain(profileDir)
      expect(message).toMatch(/rename or delete that folder/)
      expect(message).toMatch(/sign in to Microsoft Copilot again/)
    })

    it("puts the advice before Playwright's launch log, and keeps the log", () => {
      const raw = 'browserType.launchPersistentContext: Failed to launch\nBrowser logs:\n<launching> chrome.exe --user-data-dir=...'

      const message = describeLaunchFailure(bundled, raw, copilot)

      expect(message).toMatch(/^Could not open the Microsoft Copilot profile at .*: browserType\.launchPersistentContext: Failed to launch\. The profile folder may be damaged\./)
      expect(message).toMatch(/sign in to Microsoft Copilot again\.\nDetails: Browser logs:\n<launching> chrome\.exe --user-data-dir=\.\.\.$/)
    })

    it('still says to reinstall when it is the bundled browser that is missing', () => {
      const message = describeLaunchFailure(bundled, missing, copilot)

      expect(message).toMatch(/missing or damaged/)
      expect(message).toMatch(/Reinstall DOE Oracle Test Harness from its installer/)
      expect(message).not.toMatch(/profile folder/)
    })

    it('says another Chromium holds the profile, in both modes, without suggesting a reinstall or a new profile', () => {
      for (const location of [cache, bundled]) {
        const message = describeLaunchFailure(location, 'Failed to launch: ProcessSingleton lock held', { ...copilot, profileDir: '/p' })
        expect(message).toBe('Could not open the Microsoft Copilot profile at /p: another Chromium is using it. Close that window, then try again.')
      }
    })
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

describe('unusableBrowserMessage', () => {
  it('says to reinstall when files are missing or damaged', () => {
    const message = unusableBrowserMessage({ source: 'unusable', problem: `${EXECUTABLE_PATH} does not exist`, remedy: 'reinstall' })

    expect(message).toBe(missingBundledBrowserMessage(`${EXECUTABLE_PATH} does not exist`))
  })

  it('reports a bundle for another platform as a mismatch, and says a reinstall will not fix it', () => {
    const message = unusableBrowserMessage({
      source: 'unusable',
      problem: 'The browser in this installer was built for macOS (arm64), but this harness is the Windows (x64) build.',
      remedy: 'new-installer',
    })

    expect(message).toBe(
      'The browser in this installer was built for macOS (arm64), but this harness is the Windows (x64) build. ' +
        'Reinstalling will not fix it. Ask the team for the installer built for this computer.',
    )
    expect(message).not.toMatch(/missing or damaged/)
  })
})
