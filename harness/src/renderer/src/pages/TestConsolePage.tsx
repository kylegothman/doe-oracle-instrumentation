import { useEffect, useState } from 'react'
import type { CopilotSignInStatus } from '../../../shared/copilot'
import type { SqliteStatus, TrialLimit } from '../../../shared/ipc'
import type { Question } from '../../../shared/questions'
import { SUBJECT_LABELS, Subject } from '../../../shared/subjects'
import { TrialStatus, type Trial, type TrialEvent } from '../../../shared/trials'
import doneIcon from '../assets/step-done.svg'
import currentIcon from '../assets/radio-selected.svg'
import { describeError, useBridgeCall, type Loadable } from '../bridge'
import { Badge, Banner, Card, Field, Metric, Panel, SelectField } from '../components/ui'
import { elapsedAt, formatElapsed, IDLE, nextBarState } from '../status-bar'
import {
  adjustedEndMs,
  answerFoundTime,
  answerPreview,
  noAnswerMessage,
  savedResultsText,
  searchTimes,
  clockTime,
  failureTitle,
  formatMs,
  nextQuestionNumber,
  questionLabel,
  questionLine,
  recordDetails,
  sessionSummary,
  startHelp,
  SUBJECT_CHOICES,
  timerCaption,
  trialBadge,
  trialSteps,
  trialTitle,
  waitingBanner,
} from './test-console'

/** Where the console is: choosing a trial, running one, showing its result, or showing why it did not run. */
type Run =
  | { phase: 'idle'; note: string | null }
  | { phase: 'running'; subject: Subject; questionNumber: number; events: TrialEvent[]; latestAt: number }
  | { phase: 'done'; trial: Trial }
  | { phase: 'problem'; subject: Subject; questionNumber: number; message: string }

/** How often the timer is redrawn while it counts. */
const TICK_MS = 50

/**
 * The Test Console (story #38, UC-1 and UC-3), following the design's
 * screens 01, 02, and 04: pick a subject and one of the standard questions,
 * start the trial, follow it step by step, confirm Copilot's end, and see
 * the saved result. Every trial of this session is listed underneath.
 */
export function TestConsolePage() {
  const questions = useBridgeCall(() => window.harness.listQuestions())
  const limits = useBridgeCall(() => window.harness.getTrialLimits())
  const session = useBridgeCall(() => window.harness.getSession())
  const sqlite = useBridgeCall(() => window.harness.getSqliteStatus())

  const [subject, setSubject] = useState<Subject>(Subject.DOE_ORACLE)
  const [questionNumber, setQuestionNumber] = useState(1)
  const [run, setRun] = useState<Run>({ phase: 'idle', note: null })
  const [savedVersion, setSavedVersion] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)

  const questionList = questions.status === 'ready' ? questions.value : []
  const limitFor = (forSubject: Subject): TrialLimit | undefined => (limits.status === 'ready' ? limits.value[forSubject] : undefined)

  useEffect(
    () =>
      // One stream for every trial; only the running one's events are kept.
      window.harness.onTrialEvent((event) =>
        setRun((current) =>
          current.phase === 'running' && (current.events.length === 0 || current.events[0]?.trialId === event.trialId)
            ? { ...current, events: [...current.events, event], latestAt: Date.now() }
            : current,
        ),
      ),
    [],
  )

  const startTrial = (forSubject: Subject, forQuestion: number) => {
    setSubject(forSubject)
    setQuestionNumber(forQuestion)
    setActionError(null)
    setRun({ phase: 'running', subject: forSubject, questionNumber: forQuestion, events: [], latestAt: Date.now() })
    window.harness
      .startTrial(forSubject, forQuestion)
      .then((trial) => setRun({ phase: 'done', trial }))
      .catch((error: unknown) => {
        const message = describeError(error)
        setRun(
          /cancelled/i.test(message)
            ? { phase: 'idle', note: 'Trial cancelled. Nothing was saved.' }
            : { phase: 'problem', subject: forSubject, questionNumber: forQuestion, message },
        )
      })
      // Failed trials are saved too, so the list is read again however it ended.
      .finally(() => setSavedVersion((version) => version + 1))
  }

  /** Runs one of the Tester's actions on the running trial, showing its error if it is refused. */
  const act = (work: Promise<void>) => {
    setActionError(null)
    work.catch((error: unknown) => setActionError(describeError(error)))
  }

  const newTrial = () => {
    if (run.phase === 'done') setQuestionNumber(nextQuestionNumber(run.trial, questionList.length))
    setRun({ phase: 'idle', note: null })
  }

  return (
    <>
      {sqlite.status === 'ready' && !sqlite.value.ok && (
        <Banner tone="danger" title="SQLite failed to load" testId="sqlite-error">
          <p>
            The harness cannot store results on this install. The native module better-sqlite3 could not be opened:{' '}
            <code>{sqlite.value.error}</code>. Please report this message, with the version under App info, to the team.
          </p>
        </Banner>
      )}
      {questions.status === 'error' && (
        <Banner tone="danger" title="The standard questions could not be loaded" testId="questions-error">
          <p>{questions.message}</p>
        </Banner>
      )}

      {run.phase === 'idle' && (
        <NewTrialCard
          subject={subject}
          questionNumber={questionNumber}
          questions={questions}
          note={run.note}
          onSubject={setSubject}
          onQuestion={setQuestionNumber}
          onStart={() => startTrial(subject, questionNumber)}
        />
      )}
      {run.phase === 'running' && (
        <ActiveTrialCard
          run={run}
          questions={questionList}
          limit={limitFor(run.subject)}
          actionError={actionError}
          onConfirm={(trialId, endMs) => act(window.harness.confirmCompletion(trialId, endMs))}
          onNoAnswer={(trialId) => act(window.harness.reportNoAnswer(trialId))}
          onCancel={(trialId) => act(window.harness.cancelTrial(trialId))}
        />
      )}
      {run.phase === 'done' && (
        <ResultCard
          trial={run.trial}
          questions={questionList}
          limit={limitFor(run.trial.subject)}
          onRetry={() => startTrial(run.trial.subject, run.trial.questionNumber)}
          onNewTrial={newTrial}
        />
      )}
      {run.phase === 'problem' && (
        <ProblemCard
          run={run}
          questions={questionList}
          onRetry={() => startTrial(run.subject, run.questionNumber)}
          onNewTrial={newTrial}
        />
      )}

      {session.status === 'ready' && <SessionTrialsCard sessionId={session.value.sessionId} refreshKey={savedVersion} />}
      <AppInfoCard sqlite={sqlite} />
    </>
  )
}

function NewTrialCard({
  subject,
  questionNumber,
  questions,
  note,
  onSubject,
  onQuestion,
  onStart,
}: {
  subject: Subject
  questionNumber: number
  questions: Loadable<Question[]>
  note: string | null
  onSubject: (subject: Subject) => void
  onQuestion: (questionNumber: number) => void
  onStart: () => void
}) {
  const list = questions.status === 'ready' ? questions.value : []
  const question = list.find((candidate) => candidate.number === questionNumber)
  const questionChoices =
    list.length > 0
      ? list.map((candidate) => ({ value: String(candidate.number), label: questionLabel(candidate) }))
      : [{ value: String(questionNumber), label: questions.status === 'loading' ? 'Loading questions…' : 'No questions' }]

  return (
    <Card title="New trial" subtitle={`Pick a subject and one of the ${list.length || 12} standard questions.`}>
      <div className="field-row">
        <SelectField label="Subject" value={subject} choices={SUBJECT_CHOICES} onChange={onSubject} testId="subject-select" />
        <SelectField
          label="Question"
          value={String(questionNumber)}
          choices={questionChoices}
          onChange={(value) => onQuestion(Number(value))}
          disabled={list.length === 0}
          testId="question-select"
        />
      </div>
      <Panel label="Exact text sent">
        <p className="panel-text" data-testid="question-text">
          {question?.text ?? '—'}
        </p>
      </Panel>
      <p className="caption">{startHelp(subject)}</p>
      {subject === Subject.COPILOT && <CopilotSignIn />}
      {note && (
        <p className="caption" role="status" data-testid="trial-note">
          {note}
        </p>
      )}
      <div className="actions">
        <button type="button" className="button" onClick={onStart} disabled={!question} data-testid="run-trial">
          Start Trial
        </button>
      </div>
    </Card>
  )
}

function ActiveTrialCard({
  run,
  questions,
  limit,
  actionError,
  onConfirm,
  onNoAnswer,
  onCancel,
}: {
  run: Extract<Run, { phase: 'running' }>
  questions: readonly Question[]
  limit: TrialLimit | undefined
  actionError: string | null
  onConfirm: (trialId: string, endMs?: number) => void
  onNoAnswer: (trialId: string) => void
  onCancel: (trialId: string) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [adjusting, setAdjusting] = useState(false)
  const [adjustSeconds, setAdjustSeconds] = useState('')
  const [adjustError, setAdjustError] = useState<string | null>(null)

  const latest = run.events.at(-1)
  const trialId = run.events[0]?.trialId ?? null
  const clock = latest ? nextBarState(latest, run.latestAt) : IDLE
  // Google waiting for Answer Found (design screen 03): the page-load time and a counting "Searching for".
  const search = searchTimes(latest, limit, now)
  const ticking = clock.anchorAt !== null || search !== null
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [ticking])

  const elapsed = elapsedAt(clock, now) ?? 0
  const confirming = latest?.status === 'awaiting_confirmation'
  const caption = timerCaption(limit, confirming && latest.beginMs !== undefined && latest.endMs !== undefined)
  const progress = limit && caption.showProgress ? Math.min(1, elapsed / limit.timeoutMs) : null
  const banner = waitingBanner(latest, limit)
  const beginMs = confirming ? latest.beginMs : undefined

  const startAdjusting = () => {
    if (latest?.beginMs !== undefined && latest.endMs !== undefined) {
      setAdjustSeconds(((latest.endMs - latest.beginMs) / 1000).toFixed(3))
    }
    setAdjustError(null)
    setAdjusting(true)
  }
  const confirmAdjusted = () => {
    if (!trialId || beginMs === undefined) return
    const endMs = adjustedEndMs(beginMs, adjustSeconds)
    if (endMs === null) {
      setAdjustError('Enter the end as seconds after your Enter, for example 8.950')
      return
    }
    onConfirm(trialId, endMs)
  }

  return (
    <Card
      title={`${SUBJECT_LABELS[run.subject]} trial`}
      subtitle={questionLine(run.questionNumber, questions)}
      aside={<Badge tone="accent" label={search ? 'Searching' : 'Running'} testId="trial-badge" />}
    >
      {search ? (
        <div className="metric-row" data-testid="trial-search">
          <Metric label="Page load" value={formatMs(search.pageLoadMs)} testId="trial-page-load" />
          <Metric label="Searching for" value={formatElapsed(search.searchingMs)} testId="trial-searching" />
        </div>
      ) : (
        <>
          <div className="timer">
            <div className="timer-readout">
              <span className="timer-elapsed" data-testid="trial-timer">
                {formatElapsed(elapsed)}
              </span>
              <span className="caption timer-limit">{caption.text}</span>
            </div>
            {progress !== null && (
              <div className="progress-track" role="progressbar" aria-label="Time used of the limit" aria-valuenow={Math.round(progress * 100)}>
                <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
              </div>
            )}
          </div>

          {/* The step times and the response time count from different moments; say which. */}
          <p className="caption steps-note">Step times: since the trial started</p>
          <ol className="steps" data-testid="trial-steps">
            {trialSteps(run.subject, run.events).map((step) => (
              <li key={step.label} className={`step step-${step.state}`} data-state={step.state}>
                <StepIcon state={step.state} />
                <span className="step-label">{step.label}</span>
                <span className="step-time mono">{step.time}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      {banner && (
        <Banner tone="info" title={banner.title} testId="trial-waiting">
          <p>{banner.message}</p>
        </Banner>
      )}

      {confirming && adjusting && (
        <div className="adjust-row">
          <Field label="End, in seconds after your Enter">
            {(id) => (
              <input
                id={id}
                type="number"
                step="0.001"
                min="0"
                className="control"
                value={adjustSeconds}
                onChange={(event) => setAdjustSeconds(event.target.value)}
                data-testid="adjust-end-seconds"
              />
            )}
          </Field>
        </div>
      )}
      {(adjustError ?? actionError) && (
        <p role="alert" className="caption match-count-problem" data-testid="trial-action-error">
          {adjustError ?? actionError}
        </p>
      )}

      <div className="actions actions-split">
        <button type="button" className="button button-ghost" onClick={() => trialId && onCancel(trialId)} disabled={!trialId} data-testid="cancel-trial">
          Cancel Trial
        </button>
        {search && (
          <span className="actions">
            <button type="button" className="button button-secondary" onClick={() => trialId && onNoAnswer(trialId)} data-testid="no-answer">
              No Answer Found
            </button>
            {/* Answer Found is the confirm call: the moment it reaches the harness is the time to answer. */}
            <button type="button" className="button" onClick={() => trialId && onConfirm(trialId)} data-testid="answer-found">
              Answer Found
            </button>
          </span>
        )}
        {confirming && !search && !adjusting && (
          <span className="actions">
            <button type="button" className="button button-secondary" onClick={startAdjusting} data-testid="adjust-end">
              Adjust
            </button>
            <button type="button" className="button" onClick={() => trialId && onConfirm(trialId)} data-testid="confirm-end">
              Confirm Completion
            </button>
          </span>
        )}
        {confirming && !search && adjusting && (
          <span className="actions">
            <button type="button" className="button button-secondary" onClick={() => setAdjusting(false)} data-testid="adjust-back">
              Back
            </button>
            <button type="button" className="button" onClick={confirmAdjusted} data-testid="confirm-adjusted-end">
              Confirm Adjusted End
            </button>
          </span>
        )}
      </div>
    </Card>
  )
}

function StepIcon({ state }: { state: 'done' | 'current' | 'pending' }) {
  if (state === 'pending') return <span className="step-icon step-icon-pending" aria-hidden="true" />
  return <img className="step-icon" src={state === 'done' ? doneIcon : currentIcon} width={16} height={16} alt="" />
}

function ResultCard({
  trial,
  questions,
  limit,
  onRetry,
  onNewTrial,
}: {
  trial: Trial
  questions: readonly Question[]
  limit: TrialLimit | undefined
  onRetry: () => void
  onNewTrial: () => void
}) {
  const badge = trialBadge(trial)
  const failed = trial.status === TrialStatus.FAILED

  return (
    <Card
      title={trialTitle(trial)}
      subtitle={questionLine(trial.questionNumber, questions)}
      aside={<Badge tone={badge.tone} label={failed ? 'Failed' : badge.label} testId="trial-badge" />}
    >
      {failed && trial.failure ? (
        <>
          <Banner tone="danger" title={failureTitle(trial.failure, limit)} testId="trial-failure">
            <p>Saved as a failed request. Timings captured before the failure are kept.</p>
          </Banner>
          <div className="metric-row metric-row-3">
            <Metric label="Failure type" value={trial.failure.type} testId="trial-failure-type" />
            <Metric label="Elapsed" value={formatMs(trial.failure.elapsedMs)} />
            <Metric label="First response" value={formatMs(trial.firstResponseMs)} testId="trial-first-response-ms" />
          </div>
        </>
      ) : trial.status === TrialStatus.NO_ANSWER_FOUND ? (
        <>
          <Banner tone="warning" title="No answer found" testId="trial-no-answer">
            <p>{noAnswerMessage(limit)}</p>
          </Banner>
          <div className="metric-row">
            <Metric label="Page load" value={formatMs(trial.pageLoadMs)} testId="trial-page-load" />
            <Metric label="Begin" value={clockTime(trial.beginTs)} testId="trial-begin" />
          </div>
        </>
      ) : trial.subject === Subject.GOOGLE ? (
        <>
          <div className="metric-row">
            <Metric label="Page load" value={formatMs(trial.pageLoadMs)} testId="trial-page-load" />
            <Metric label="Time to answer" value={formatMs(trial.timeToAnswerMs)} testId="trial-time-to-answer" />
          </div>
          <div className="metric-row">
            <Metric label="Begin" value={clockTime(trial.beginTs)} testId="trial-begin" />
            <Metric label="Answer found" value={answerFoundTime(trial)} testId="trial-answer-found" />
          </div>
          {savedResultsText(trial) && (
            <Banner tone="warning" title="No passage was highlighted" testId="trial-results-text">
              <p>
                Answer Found saved the text of the whole results page. If you meant to save a passage, run the trial again,
                highlight it, and click Answer Found while it is still highlighted.
              </p>
            </Banner>
          )}
          <Panel label={savedResultsText(trial) ? 'Results page text' : 'Selected passage'}>
            <p className="panel-text answer-text" data-testid="trial-answer">
              {answerPreview(trial.answerText)}
            </p>
          </Panel>
          <Panel label="Source">
            <p className="panel-text mono" data-testid="trial-source">
              {trial.sourceUrl ?? '—'}
            </p>
          </Panel>
          <p className="caption" data-testid="trial-details">
            {recordDetails(trial)}
          </p>
        </>
      ) : (
        <>
          <div className="metric-row">
            <Metric label="Response time" value={formatMs(trial.responseMs)} testId="trial-response-ms" />
            <Metric label="First response" value={formatMs(trial.firstResponseMs)} testId="trial-first-response-ms" />
          </div>
          <div className="metric-row">
            <Metric label="Begin" value={clockTime(trial.beginTs)} testId="trial-begin" />
            <Metric label="End" value={clockTime(trial.endTs)} testId="trial-end" />
          </div>
          <Panel label="Answer preview">
            <p className="panel-text answer-text" data-testid="trial-answer">
              {answerPreview(trial.answerText)}
            </p>
            {trial.citations.length > 0 && <p className="citation">Cited: {trial.citations.join('; ')}</p>}
          </Panel>
          <p className="caption" data-testid="trial-details">
            {recordDetails(trial)}
          </p>
        </>
      )}
      <div className="actions actions-split">
        <ReadyNote />
        <span className="actions">
          {failed && (
            <button type="button" className="button button-secondary" onClick={onRetry} data-testid="retry-trial">
              Retry Q{trial.questionNumber}
            </button>
          )}
          <button type="button" className="button" onClick={onNewTrial} data-testid="new-trial">
            New Trial
          </button>
        </span>
      </div>
    </Card>
  )
}

function ProblemCard({
  run,
  questions,
  onRetry,
  onNewTrial,
}: {
  run: Extract<Run, { phase: 'problem' }>
  questions: readonly Question[]
  onRetry: () => void
  onNewTrial: () => void
}) {
  return (
    <Card
      title={`${SUBJECT_LABELS[run.subject]} trial`}
      subtitle={questionLine(run.questionNumber, questions)}
      aside={<Badge tone="danger" label="Not saved" testId="trial-badge" />}
    >
      <Banner tone="danger" title="The trial did not run to the end" testId="trial-error">
        <p>{run.message}</p>
      </Banner>
      <div className="actions actions-split">
        <ReadyNote />
        <span className="actions">
          <button type="button" className="button button-secondary" onClick={onRetry} data-testid="retry-trial">
            Retry Q{run.questionNumber}
          </button>
          <button type="button" className="button" onClick={onNewTrial} data-testid="new-trial">
            New Trial
          </button>
        </span>
      </div>
    </Card>
  )
}

function ReadyNote() {
  return (
    <span className="ready-note" role="status">
      <span className="ready-dot" aria-hidden="true" />
      Ready for the next trial
    </span>
  )
}

/** Every trial of this session, newest first, read again after each trial. */
function SessionTrialsCard({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const trials = useBridgeCall(() => window.harness.listTrials(sessionId), refreshKey)

  return (
    <Card title="This session" subtitle={trials.status === 'ready' ? sessionSummary(trials.value) : 'Loading trials…'}>
      {trials.status === 'error' && (
        <p role="alert" className="caption match-count-problem" data-testid="saved-trials-error">
          Could not list this session&apos;s trials: {trials.message}
        </p>
      )}
      {trials.status === 'ready' && trials.value.length > 0 && (
        <table className="trials-table" data-testid="saved-trials">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Subject</th>
              <th scope="col">Q</th>
              <th scope="col">Status</th>
              <th scope="col" className="numeric">
                Response
              </th>
            </tr>
          </thead>
          <tbody>
            {trials.value.map((trial) => {
              const badge = trialBadge(trial)
              return (
                <tr key={trial.trialId} title={trial.failure?.message}>
                  <td className="muted">{trial.testNumber}</td>
                  <td>{SUBJECT_LABELS[trial.subject]}</td>
                  <td className="mono muted">Q{trial.questionNumber}</td>
                  <td>
                    <Badge tone={badge.tone} label={badge.label} />
                  </td>
                  <td className="mono numeric">{formatMs(trial.failure ? trial.failure.elapsedMs : trial.responseMs)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}

/** The app's name and version, and whether SQLite loaded: what an install check and a bug report need. */
function AppInfoCard({ sqlite }: { sqlite: Loadable<SqliteStatus> }) {
  const appInfo = useBridgeCall(() => window.harness.getAppInfo())
  return (
    <Card title="App info">
      <div className="metric-row">
        <div className="metric">
          <span className="metric-label">Version</span>
          <span className="metric-value mono">
            {appInfo.status === 'ready' && (
              <>
                <span data-testid="app-name">{appInfo.value.name}</span> <span data-testid="app-version">{appInfo.value.version}</span>
              </>
            )}
            {appInfo.status === 'loading' && 'Loading…'}
            {appInfo.status === 'error' && <span className="match-count-problem">{appInfo.message}</span>}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Storage</span>
          <span className="metric-value mono">
            {sqlite.status === 'ready' && sqlite.value.ok && (
              <span className="ok-text" data-testid="sqlite-ok">
                SQLite {sqlite.value.version} loaded
              </span>
            )}
            {sqlite.status === 'ready' && !sqlite.value.ok && <span className="match-count-problem">SQLite failed to load</span>}
            {sqlite.status === 'loading' && 'Checking SQLite…'}
            {sqlite.status === 'error' && <span className="match-count-problem">{sqlite.message}</span>}
          </span>
        </div>
      </div>
    </Card>
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
      return `Not signed in yet: the Copilot window is at ${result.url}. Sign in there, then click the button again to check.`
    case 'offline':
      return 'The Copilot window shows "No internet connection". Check the network, then try again.'
    case 'unknown':
      return `The chat input did not appear at ${result.url}. Look at the Copilot window.`
  }
}

/**
 * Opens the Copilot window on the chat page and reports what it shows. The
 * Tester signs in there; the harness never does. With the work account
 * tested, the sign-in lasted only until the harness quit.
 */
function CopilotSignIn() {
  const [state, setState] = useState<SignInState>({ status: 'idle' })

  const open = () => {
    setState({ status: 'opening' })
    window.harness
      .openCopilotSignIn()
      .then((result) => setState({ status: 'done', result }))
      .catch((error: unknown) => setState({ status: 'error', message: describeError(error) }))
  }

  return (
    <div className="sign-in-row">
      <p className="caption">
        {state.status === 'done' ? (
          <span data-testid="copilot-sign-in-status" data-state={state.result.state} className={state.result.signedIn ? 'ok-text' : undefined}>
            {describeSignIn(state.result)}
          </span>
        ) : state.status === 'error' ? (
          <span role="alert" className="match-count-problem" data-testid="copilot-sign-in-error">
            {state.message}
          </span>
        ) : (
          'Copilot runs in its own browser profile. Sign in once after launching the harness, with the account the trials should run under.'
        )}
      </p>
      <button
        type="button"
        className="button button-secondary"
        onClick={open}
        disabled={state.status === 'opening'}
        data-testid="open-copilot-sign-in"
      >
        {state.status === 'opening' ? 'Opening Copilot…' : 'Open Copilot to sign in'}
      </button>
    </div>
  )
}
