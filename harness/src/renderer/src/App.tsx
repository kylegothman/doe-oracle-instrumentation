import { useEffect, useState } from 'react'
import type { CopilotSignInStatus } from '../../shared/copilot'
import type { AppInfo, SqliteStatus } from '../../shared/ipc'
import { SUBJECT_LABELS, Subject } from '../../shared/subjects'
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
  | { status: 'cancelled'; message: string }
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
          <span className="event-status">{event.status.replaceAll('_', ' ')}</span> at {formatSeconds(event.elapsedMs)}
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

const QUESTION_NUMBER = 1
/** Subjects the window can run. TODO(#6): Google arrives with E5. */
const SUBJECT_CHOICES: readonly Subject[] = [Subject.DOE_ORACLE, Subject.COPILOT]

const SUBJECT_INSTRUCTIONS: Record<Subject, string> = {
  [Subject.DOE_ORACLE]:
    'Opens the Oracle chat in a Chromium window the harness controls, types question 1, submits it, times the answer from browser events, and saves the trial.',
  [Subject.COPILOT]:
    'Opens a new chat in the Copilot window and types question 1. You press Enter there: the clock runs from your Enter to the end of the streamed answer, which you confirm or correct before the trial is saved.',
  [Subject.GOOGLE]: 'Not available yet.',
}

/** One line on where the running trial is, from its latest event. */
function statusLine(event: TrialEvent | undefined): string | null {
  if (!event) return null
  switch (event.status) {
    case 'started':
      return 'Starting the trial…'
    case 'awaiting_submit':
      return event.message ?? 'Press Enter in the browser'
    case 'first_response':
      return `The answer started ${formatSeconds(event.elapsedMs)} into the trial.`
    case 'awaiting_confirmation':
      return event.beginMs !== undefined && event.endMs !== undefined
        ? `The answer finished ${formatSeconds(event.endMs - event.beginMs)} after your Enter. Confirm that end, adjust it, or cancel.`
        : (event.message ?? 'Confirm the end of the answer.')
    case 'completed':
      return 'Saved.'
    case 'failed':
      return `Failed: ${event.message ?? event.failureType ?? 'unknown failure'}`
    case 'cancelled':
      return 'Cancelled. Nothing was saved.'
    case 'aborted':
      return `Aborted: ${event.message ?? 'the harness could not run the trial'}`
  }
}

function TrialPanel({ onSaved }: { onSaved: () => void }) {
  const [subject, setSubject] = useState<Subject>(Subject.DOE_ORACLE)
  const [run, setRun] = useState<TrialRunState>({ status: 'idle' })
  const [events, setEvents] = useState<TrialEvent[]>([])
  const [adjustSeconds, setAdjustSeconds] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    // Subscribed for the panel's lifetime; the main process sends one stream for every trial.
    return window.harness.onTrialEvent((event) => {
      setEvents((prev) => [...prev, event])
      if (event.status === 'awaiting_confirmation' && event.beginMs !== undefined && event.endMs !== undefined) {
        setAdjustSeconds(((event.endMs - event.beginMs) / 1000).toFixed(3))
      }
    })
  }, [])

  const latest = events.at(-1)
  const trialId = events[0]?.trialId ?? null
  const running = run.status === 'running'
  const awaitingConfirmation = running && latest?.status === 'awaiting_confirmation'
  const beginMs = latest?.status === 'awaiting_confirmation' ? latest.beginMs : undefined

  const startTrial = () => {
    setRun({ status: 'running' })
    setEvents([])
    setActionError(null)
    window.harness
      .startTrial(subject, QUESTION_NUMBER)
      .then((trial) => {
        setRun({ status: 'done', trial })
        onSaved()
      })
      .catch((error: unknown) => {
        const message = describeError(error)
        setRun(/cancelled/i.test(message) ? { status: 'cancelled', message } : { status: 'error', message })
      })
  }

  /** Runs one of the Tester's actions on the trial, showing its error if it is refused. */
  const act = (work: Promise<void>) => {
    setActionError(null)
    work.catch((error: unknown) => setActionError(describeError(error)))
  }
  const confirm = () => {
    if (trialId) act(window.harness.confirmCompletion(trialId))
  }
  const confirmAdjusted = () => {
    if (!trialId || beginMs === undefined) return
    const seconds = Number(adjustSeconds)
    if (adjustSeconds.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
      setActionError('Enter the end as seconds after your Enter, for example 8.950')
      return
    }
    act(window.harness.confirmCompletion(trialId, Math.round(beginMs + seconds * 1000)))
  }
  const cancel = () => {
    if (trialId) act(window.harness.cancelTrial(trialId))
  }

  return (
    <section aria-labelledby="trial-heading">
      <h2 id="trial-heading">Trial</h2>
      <p>
        <label>
          Subject{' '}
          <select
            value={subject}
            onChange={(event) => setSubject(event.target.value as Subject)}
            disabled={running}
            data-testid="subject-select"
          >
            {SUBJECT_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {SUBJECT_LABELS[choice]}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p>{SUBJECT_INSTRUCTIONS[subject]}</p>
      <p className="actions">
        <button type="button" onClick={startTrial} disabled={running} data-testid="run-trial">
          {running ? `Running ${SUBJECT_LABELS[subject]} trial…` : `Run ${SUBJECT_LABELS[subject]} trial (Q${QUESTION_NUMBER})`}
        </button>
        {running && (
          <button type="button" onClick={cancel} className="secondary" data-testid="cancel-trial">
            Cancel
          </button>
        )}
      </p>
      {running && latest && (
        <p className="status-line" data-testid="trial-status-line" data-status={latest.status}>
          {statusLine(latest)}
        </p>
      )}
      {awaitingConfirmation && (
        <div className="confirm-box" data-testid="confirm-box">
          <p className="actions">
            <button type="button" onClick={confirm} data-testid="confirm-end">
              Confirm
            </button>
            <label>
              End, seconds after your Enter{' '}
              <input
                type="number"
                step="0.001"
                min="0"
                value={adjustSeconds}
                onChange={(event) => setAdjustSeconds(event.target.value)}
                data-testid="adjust-end-seconds"
              />
            </label>
            <button type="button" onClick={confirmAdjusted} className="secondary" data-testid="confirm-adjusted-end">
              Adjust and confirm
            </button>
          </p>
        </div>
      )}
      {actionError && (
        <p role="alert" className="error" data-testid="trial-action-error">
          {actionError}
        </p>
      )}
      <TrialEvents events={events} />
      {run.status === 'cancelled' && <p data-testid="trial-cancelled">{run.message}</p>}
      {run.status === 'error' && (
        <p role="alert" className="error" data-testid="trial-error">
          {run.message}
        </p>
      )}
      {run.status === 'done' && <TrialResult trial={run.trial} />}
    </section>
  )
}

type SignInState =
  | { status: 'idle' }
  | { status: 'opening' }
  | { status: 'done'; result: CopilotSignInStatus }
  | { status: 'error'; message: string }

function describeSignIn(result: CopilotSignInStatus): string {
  switch (result.state) {
    case 'chat':
      return `Copilot is signed in (${result.label}). You can run a Copilot trial.`
    case 'signed_out':
      return `Not signed in yet: the Copilot window is at ${result.url}. Sign in there, then run the trial.`
    case 'offline':
      return 'The Copilot window shows "No internet connection". Check the network, then try again.'
    case 'unknown':
      return `The chat input did not appear at ${result.url}. Look at the Copilot window.`
  }
}

/**
 * The sign-in action for Copilot: opens its window on the chat page and
 * reports what it shows. The Tester signs in there; the harness never does.
 */
function CopilotSignInPanel() {
  const [state, setState] = useState<SignInState>({ status: 'idle' })

  const open = () => {
    setState({ status: 'opening' })
    window.harness
      .openCopilotSignIn()
      .then((result) => setState({ status: 'done', result }))
      .catch((error: unknown) => setState({ status: 'error', message: describeError(error) }))
  }

  return (
    <section aria-labelledby="copilot-heading">
      <h2 id="copilot-heading">Copilot sign-in</h2>
      <p>
        Copilot keeps its own browser profile, so signing in once is enough until the session expires. Sign in with the
        account the trials should run under.
      </p>
      <button type="button" onClick={open} disabled={state.status === 'opening'} data-testid="open-copilot-sign-in">
        {state.status === 'opening' ? 'Opening Copilot…' : 'Open Copilot to sign in'}
      </button>
      {state.status === 'done' && (
        <p data-testid="copilot-sign-in-status" data-state={state.result.state} className={state.result.signedIn ? 'ok' : undefined}>
          {describeSignIn(state.result)}
        </p>
      )}
      {state.status === 'error' && (
        <p role="alert" className="error" data-testid="copilot-sign-in-error">
          {state.message}
        </p>
      )}
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
      <CopilotSignInPanel />
      <TrialPanel onSaved={() => setSavedVersion((v) => v + 1)} />
      <SavedTrials refreshKey={savedVersion} />
      <AppInfoPanel appInfo={appInfo} />
      <SqlitePanel sqlite={sqlite} />
    </main>
  )
}
