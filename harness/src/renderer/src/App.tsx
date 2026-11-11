import { useEffect, useState } from 'react'
import type { AppInfo, SqliteStatus } from '../../shared/ipc'

type Loadable<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

/** Calls one bridge method on mount and tracks loading, value, and failure. */
function useBridgeCall<T>(call: () => Promise<T>): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    // Resolve inside a promise so a missing bridge surfaces as an error on
    // screen instead of an uncaught exception.
    Promise.resolve()
      .then(call)
      .then((value) => {
        if (!cancelled) setState({ status: 'ready', value })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!cancelled) setState({ status: 'error', message })
      })
    return () => {
      cancelled = true
    }
    // The bridge methods are stable; each hook call binds one of them for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return state
}

function AppInfoPanel({ appInfo }: { appInfo: Loadable<AppInfo> }) {
  return (
    <section aria-labelledby="app-info-heading">
      <h2 id="app-info-heading">App info</h2>
      {appInfo.status === 'loading' && <p>Loading app info from the main process…</p>}
      {appInfo.status === 'ready' && (
        <dl className="facts">
          <dt>Name</dt>
          <dd data-testid="app-name">{appInfo.value.name}</dd>
          <dt>Version</dt>
          <dd data-testid="app-version">{appInfo.value.version}</dd>
        </dl>
      )}
      {appInfo.status === 'error' && (
        <p role="alert" className="error">
          Could not read app info from the main process: {appInfo.message}
        </p>
      )}
    </section>
  )
}

function SqlitePanel({ sqlite }: { sqlite: Loadable<SqliteStatus> }) {
  return (
    <section aria-labelledby="sqlite-heading">
      <h2 id="sqlite-heading">Storage</h2>
      {sqlite.status === 'loading' && <p>Checking SQLite…</p>}
      {sqlite.status === 'ready' && sqlite.value.ok && (
        <p className="ok" data-testid="sqlite-ok">
          SQLite {sqlite.value.version} loaded through better-sqlite3.
        </p>
      )}
      {sqlite.status === 'ready' && !sqlite.value.ok && (
        <div role="alert" className="error-box" data-testid="sqlite-error">
          <p>
            <strong>SQLite failed to load.</strong> The harness cannot store results on this install.
          </p>
          <p>
            The native module better-sqlite3 could not be opened: <code>{sqlite.value.error}</code>
          </p>
          <p>Please report this message, together with the app version above, to the team.</p>
        </div>
      )}
      {sqlite.status === 'error' && (
        <p role="alert" className="error" data-testid="sqlite-error">
          Could not reach the SQLite probe in the main process: {sqlite.message}
        </p>
      )}
    </section>
  )
}

export function App() {
  const appInfo = useBridgeCall(() => window.harness.getAppInfo())
  const sqlite = useBridgeCall(() => window.harness.getSqliteStatus())

  return (
    <main className="app">
      <h1>DOE Oracle Test Harness</h1>
      <AppInfoPanel appInfo={appInfo} />
      <SqlitePanel sqlite={sqlite} />
    </main>
  )
}
