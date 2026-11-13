import { useEffect, useState } from 'react'
import type { AppInfo, SqliteStatus } from '../../shared/ipc'
import { Subject } from '../../shared/subjects'
import type { Trial, TrialEvent } from '../../shared/trials'

type Loadable<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

/** Electron prefixes errors that cross the bridge; show only the handler's own message. */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': /, '').replace(/^\w*Error: /, '')
}

/** Calls one bridge method on mount and tracks loading, value, and failure. */
function useBridgeCall<T>(call: () => Promise<T>, refreshKey = 0): Loadable<T> {
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
        if (!cancelled) setState({ status: 'error', message: describeError(error) })
      })
    return () => {
      cancelled = true
    }
    // The bridge methods are stable; the call is re-run only when refreshKey changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  return state
}

/** The session bar: this launch's session ID, which every saved trial carries. */
function SessionBar() {
  const session = useBridgeCall(() => window.harness.getSession())

  return (
    <p className="session-bar" data-testid="session-bar">
      {session.status === 'loading' && 'Starting session…'}
      {session.status === 'ready' && (
        <>
          Session <code data-testid="session-id">{session.value.sessionId}</code> started {session.value.startedAt}{' '}
          · harness {session.value.appVersion}
        </>
      )}
      {session.status === 'error' && (
        <span role="alert" className="error" data-testid="session-error">
          No session: {session.message}
        </span>
      )}
    </p>
  )
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

type TrialRunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; trial: Trial }
  | { status: 'error'; message: string }

function formatSeconds(ms: number | null): string {
  return ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`
}

/** The status events the main process pushed for the current trial, oldest first. */
function TrialEvents({ events }: { events: TrialEvent[] }) {
  if (events.length === 0) return null
  return (
    <ol className="events" data-testid="trial-events">
      {events.map((event, index) => (
        <li key={index} data-status={event.status}>
          <span className="event-status">{event.status.replace('_', ' ')}</span> at {formatSeconds(event.elapsedMs)}
          {event.failureType && <> · {event.failureType}</>}
          {event.message && <> · {event.message}</>}
        </li>
      ))}
    </ol>
  )
}

const ANSWER_PREVIEW_CHARS = 400

function TrialResult({ trial }: { trial: Trial }) {
  const preview =
    trial.answerText && trial.answerText.length > ANSWER_PREVIEW_CHARS
      ? `${trial.answerText.slice(0, ANSWER_PREVIEW_CHARS)}…`
      : trial.answerText || '(no answer text)'
  return (
    <div className="result" data-testid="trial-result">
      <dl className="facts">
        <dt>Test number</dt>
        <dd data-testid="trial-test-number">{trial.testNumber}</dd>
        <dt>Data set</dt>
        <dd>{trial.dataSetName}</dd>
        <dt>Begin</dt>
        <dd data-testid="trial-begin">{trial.beginTs}</dd>
        <dt>First response</dt>
        <dd data-testid="trial-first-response">{trial.firstResponseTs}</dd>
        <dt>End</dt>
        <dd data-testid="trial-end">{trial.endTs}</dd>
        <dt>Status</dt>
        <dd data-testid="trial-status">
          {trial.status}
          {trial.failure && (
            <>
              {' '}
              · <strong data-testid="trial-failure-type">{trial.failure.type}</strong> after{' '}
              {formatSeconds(trial.failure.elapsedMs)}
            </>
          )}
        </dd>
        {trial.failure && (
          <>
            <dt>Failure</dt>
            <dd className="error" data-testid="trial-failure-message">
              {trial.failure.message}
            </dd>
          </>
        )}
        <dt>Response time</dt>
        <dd data-testid="trial-response-ms">{trial.responseMs === null ? '–' : `${trial.responseMs} ms`}</dd>
        <dt>Time to first response</dt>
        <dd data-testid="trial-first-response-ms">{trial.firstResponseMs === null ? '–' : `${trial.firstResponseMs} ms`}</dd>
        <dt>Citations</dt>
        <dd>{trial.citations.length > 0 ? trial.citations.join('; ') : 'none'}</dd>
      </dl>
      <p className="answer-preview" data-testid="trial-answer">
        {preview}
      </p>
    </div>
  )
}

function TrialPanel({ onSaved }: { onSaved: () => void }) {
  const [run, setRun] = useState<TrialRunState>({ status: 'idle' })
  const [events, setEvents] = useState<TrialEvent[]>([])

  useEffect(() => {
    // Subscribed for the panel's lifetime; the main process sends one stream for every trial.
    return window.harness.onTrialEvent((event) => setEvents((prev) => [...prev, event]))
  }, [])

  const startTrial = () => {
    setRun({ status: 'running' })
    setEvents([])
    window.harness
      .startTrial(Subject.DOE_ORACLE, 1)
      .then((trial) => {
        setRun({ status: 'done', trial })
        onSaved()
      })
      .catch((error: unknown) => setRun({ status: 'error', message: describeError(error) }))
  }

  return (
    <section aria-labelledby="trial-heading">
      <h2 id="trial-heading">Oracle trial</h2>
      <p>
        Asks question 1, "What is combinatorial testing?", in a Chromium window the harness controls, times it
        from browser events, and saves the trial.
      </p>
      <button type="button" onClick={startTrial} disabled={run.status === 'running'} data-testid="run-oracle-trial">
        {run.status === 'running' ? 'Running Oracle trial…' : 'Run Oracle trial (Q1)'}
      </button>
      {run.status === 'running' && (
        <p data-testid="trial-running">Watch the Chromium window. The question is typed and submitted for you.</p>
      )}
      <TrialEvents events={events} />
      {run.status === 'error' && (
        <p role="alert" className="error" data-testid="trial-error">
          {run.message}
        </p>
      )}
      {run.status === 'done' && <TrialResult trial={run.trial} />}
    </section>
  )
}

function SavedTrials({ refreshKey }: { refreshKey: number }) {
  const trials = useBridgeCall(() => window.harness.listTrials(), refreshKey)

  return (
    <section aria-labelledby="saved-heading">
      <h2 id="saved-heading">Saved trials</h2>
      {trials.status === 'loading' && <p>Loading saved trials…</p>}
      {trials.status === 'error' && (
        <p role="alert" className="error" data-testid="saved-trials-error">
          Could not list saved trials: {trials.message}
        </p>
      )}
      {trials.status === 'ready' && trials.value.length === 0 && (
        <p data-testid="saved-trials-empty">No trials saved yet.</p>
      )}
      {trials.status === 'ready' && trials.value.length > 0 && (
        <table className="trials" data-testid="saved-trials">
          <thead>
            <tr>
              <th>#</th>
              <th>Subject</th>
              <th>Q</th>
              <th>Status</th>
              <th>Response</th>
              <th>Begin</th>
              <th>Session</th>
            </tr>
          </thead>
          <tbody>
            {trials.value.map((trial) => (
              <tr key={trial.trialId}>
                <td>{trial.testNumber}</td>
                <td>{trial.subject}</td>
                <td>{trial.questionNumber}</td>
                <td title={trial.failure?.message}>
                  {trial.status}
                  {trial.failure && ` · ${trial.failure.type}`}
                </td>
                <td>{trial.responseMs === null ? '–' : `${trial.responseMs} ms`}</td>
                <td>{trial.beginTs}</td>
                <td title={trial.sessionId}>{trial.sessionId.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function App() {
  const appInfo = useBridgeCall(() => window.harness.getAppInfo())
  const sqlite = useBridgeCall(() => window.harness.getSqliteStatus())
  const [savedVersion, setSavedVersion] = useState(0)

  return (
    <main className="app">
      <h1>DOE Oracle Test Harness</h1>
      <SessionBar />
      <TrialPanel onSaved={() => setSavedVersion((v) => v + 1)} />
      <SavedTrials refreshKey={savedVersion} />
      <AppInfoPanel appInfo={appInfo} />
      <SqlitePanel sqlite={sqlite} />
    </main>
  )
}
