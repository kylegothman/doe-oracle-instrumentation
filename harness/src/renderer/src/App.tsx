import { useEffect, useState } from 'react'
import type { AppInfo } from '../../shared/ipc'

type AppInfoState =
  | { status: 'loading' }
  | { status: 'ready'; info: AppInfo }
  | { status: 'error'; message: string }

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfoState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    // Resolve inside a promise so a missing bridge surfaces as an error on
    // screen instead of an uncaught exception.
    Promise.resolve()
      .then(() => window.harness.getAppInfo())
      .then((info) => {
        if (!cancelled) setAppInfo({ status: 'ready', info })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!cancelled) setAppInfo({ status: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="app">
      <h1>DOE Oracle Test Harness</h1>
      <section aria-labelledby="app-info-heading">
        <h2 id="app-info-heading">App info</h2>
        {appInfo.status === 'loading' && <p>Loading app info from the main process…</p>}
        {appInfo.status === 'ready' && (
          <dl className="app-info">
            <dt>Name</dt>
            <dd data-testid="app-name">{appInfo.info.name}</dd>
            <dt>Version</dt>
            <dd data-testid="app-version">{appInfo.info.version}</dd>
          </dl>
        )}
        {appInfo.status === 'error' && (
          <p role="alert" className="error">
            Could not read app info from the main process: {appInfo.message}
          </p>
        )}
      </section>
    </main>
  )
}
