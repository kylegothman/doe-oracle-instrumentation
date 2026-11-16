// Puts the Chromium build pinned by the installed Playwright into
// harness/.browser-bundle/, ready for electron-builder to ship inside the app
// (see extraResources in electron-builder.yml), and writes browser.json, the
// manifest the packaged app reads to find the executable.
//
// Run through `npm run bundle:browser`; `npm run dist:win` and `dist:dir` run
// it for you. It only ever writes inside .browser-bundle/. Playwright's cache
// in your user folder (where `npm run setup:browser` installs) is not read,
// changed, or cleaned up.
//
// Only the headed build is fetched (`--no-shell`): the harness never launches
// the headless shell outside its unit tests.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const harnessDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(harnessDir, '.browser-bundle')
const manifestPath = join(bundleDir, 'browser.json')
const require = createRequire(join(harnessDir, 'package.json'))

function fail(message) {
  console.error(`bundle-browser: ${message}`)
  process.exit(1)
}

/** Runs node with Playwright pointed at the bundle folder instead of the user's cache. */
function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: harnessDir,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: bundleDir },
    ...options,
  })
  if (result.error) fail(`could not run node ${args[0]}: ${result.error.message}`)
  if (result.status !== 0) fail(`node ${args.slice(0, 3).join(' ')} exited with code ${result.status}`)
  return result
}

const playwrightDir = dirname(require.resolve('playwright/package.json'))
const playwrightVersion = JSON.parse(readFileSync(join(playwrightDir, 'package.json'), 'utf8')).version
const coreDir = dirname(require.resolve('playwright-core/package.json'))
const pinned = JSON.parse(readFileSync(join(coreDir, 'browsers.json'), 'utf8')).browsers.find((browser) => browser.name === 'chromium')
if (!pinned?.revision || !pinned.browserVersion) {
  fail(`playwright-core ${playwrightVersion} lists no chromium build in browsers.json`)
}

mkdirSync(bundleDir, { recursive: true })

// Playwright's own installer: it skips the download when this revision is
// already in the folder, so a second run (or a CI cache hit) is quick.
console.log(`bundle-browser: Chromium ${pinned.browserVersion} (revision ${pinned.revision}) for Playwright ${playwrightVersion}`)
runNode([join(playwrightDir, 'cli.js'), 'install', '--no-shell', 'chromium'], { stdio: 'inherit' })

// Ask Playwright where the executable is rather than rebuilding its folder
// layout here: the layout differs per platform and changes between versions.
const executablePath = runNode(['-e', "process.stdout.write(require('playwright').chromium.executablePath())"], {
  encoding: 'utf8',
}).stdout.trim()
if (!executablePath || !existsSync(executablePath)) {
  fail(`Playwright reports the executable at "${executablePath}", which does not exist`)
}
const executable = relative(bundleDir, executablePath).split(sep).join('/')
if (executable.startsWith('..')) {
  fail(`the executable Playwright reports (${executablePath}) is outside ${bundleDir}`)
}
const revisionDir = executable.split('/')[0]
if (revisionDir !== `chromium-${pinned.revision}`) {
  fail(`expected the executable under chromium-${pinned.revision}, got ${executable}`)
}

// Only the pinned revision ships. An older one left in this folder by an
// earlier Playwright version would double the installer's size.
for (const entry of readdirSync(bundleDir)) {
  if (/^chromium-\d+$/.test(entry) && entry !== revisionDir) {
    console.log(`bundle-browser: removing stale ${entry} from .browser-bundle`)
    rmSync(join(bundleDir, entry), { recursive: true, force: true })
  }
}

// The browser's own notice files ship with it, untouched. Chrome for Testing
// carries a single ABOUT file; its full credits and terms are built into the
// browser (chrome://credits, chrome://terms).
const notices = []
const walk = (dir, depth) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (depth < 1) walk(full, depth + 1)
    } else if (/^(about|licen[cs]e|notice|credits)/i.test(entry)) {
      notices.push(relative(bundleDir, full).split(sep).join('/'))
    }
  }
}
walk(join(bundleDir, revisionDir), 0)
if (notices.length === 0) {
  fail(`no notice or license file found under ${revisionDir}; the browser must ship with the ones it came with`)
}

const manifest = {
  playwrightVersion,
  revision: String(pinned.revision),
  browserVersion: pinned.browserVersion,
  executable,
  platform: process.platform,
  arch: process.arch,
  notices,
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`bundle-browser: wrote ${relative(harnessDir, manifestPath)}`)
console.log(JSON.stringify(manifest, null, 2))
