import { useEffect, useMemo, useState } from 'react'
import { ExportFormat, type ExportPreview } from '../../../shared/export'
import { describeError, useBridgeCall, type Loadable } from '../bridge'
import { Banner, Card, Field, RadioOption, Segmented, SelectField } from '../components/ui'
import {
  buildFilter,
  describeExport,
  describeMatches,
  describePendingSaves,
  describeRetry,
  FORMAT_CHOICES,
  sessionLabel,
  SUBJECT_CHOICES,
  toDayValue,
  type ExportOutcome,
  type FilterMode,
  type SubjectChoice,
} from './export-page'

const FILTER_MODES = [
  { value: 'session' as const, label: 'Session' },
  { value: 'range' as const, label: 'Date range' },
]

/**
 * The Export Page (story #40, UC-6): choose the records by session or by
 * date range, optionally one subject, and the format. Export asks where to
 * save (the main process's save dialog) and the page then says how many
 * rows were written and where.
 *
 * `refreshKey` changes each time the Tester opens the tab, so the session
 * list and the count include trials saved since the last visit.
 */
export function ExportPage({ refreshKey }: { refreshKey: number }) {
  const [mode, setMode] = useState<FilterMode>('session')
  const [pickedSessionId, setPickedSessionId] = useState<string | null>(null)
  const [fromDay, setFromDay] = useState(() => toDayValue(new Date()))
  const [toDay, setToDay] = useState(() => toDayValue(new Date()))
  const [subject, setSubject] = useState<SubjectChoice>('ALL')
  const [format, setFormat] = useState<ExportFormat>(ExportFormat.TESTLOG_V3_XLSX)
  const [exporting, setExporting] = useState(false)
  const [outcome, setOutcome] = useState<ExportOutcome>(null)
  // Bumped after every export, so the count is read again.
  const [exportCount, setExportCount] = useState(0)

  const current = useBridgeCall(() => window.harness.getSession())
  const sessions = useBridgeCall(() => window.harness.listSessions(), refreshKey)
  const currentSessionId = current.status === 'ready' ? current.value.sessionId : null

  // Until the Tester picks one, the running session is chosen, or the newest.
  const sessionList = useMemo(() => (sessions.status === 'ready' ? sessions.value : []), [sessions])
  const sessionId =
    pickedSessionId ??
    (sessionList.some((session) => session.sessionId === currentSessionId) ? currentSessionId : (sessionList[0]?.sessionId ?? null))

  const filterOutcome = buildFilter({ mode, sessionId, fromDay, toDay, subject })
  // A string, so the count is only read again when the filter really changed.
  const filterKey = filterOutcome.ok ? JSON.stringify(filterOutcome.filter) : null
  const preview = usePreview(filterKey, refreshKey + exportCount)

  const sessionChoices = useMemo(() => {
    const now = new Date()
    return sessionList.map((session) => ({ value: session.sessionId, label: sessionLabel(session, now, currentSessionId) }))
  }, [sessionList, currentSessionId])

  const nothingMatches = preview.status === 'ready' && preview.value.trials + preview.value.expertAnswers === 0
  const canExport = filterOutcome.ok && !exporting && !nothingMatches

  const runExport = () => {
    if (!filterOutcome.ok) return
    setExporting(true)
    setOutcome(null)
    window.harness
      .exportLog({ filter: filterOutcome.filter, format })
      .then((result) => {
        setOutcome(describeExport(result))
        setExportCount((count) => count + 1)
      })
      .catch((error: unknown) => setOutcome({ tone: 'danger', title: 'The export did not run', message: describeError(error) }))
      .finally(() => setExporting(false))
  }

  return (
    <>
      <PendingSaves refreshKey={refreshKey} onRetried={() => setExportCount((count) => count + 1)} />
      <Card title="Records to export" subtitle="Superseded expert answers are always left out.">
        <Segmented label="Filter by" value={mode} choices={FILTER_MODES} onChange={setMode} testId="export-filter-mode" />
        <div className="field-row">
          {mode === 'session' ? (
            <SessionField sessions={sessions} value={sessionId} choices={sessionChoices} onChange={setPickedSessionId} />
          ) : (
            <>
              <Field label="First day">
                {(id) => (
                  <input
                    id={id}
                    type="date"
                    className="control"
                    value={fromDay}
                    max={toDay || undefined}
                    onChange={(event) => setFromDay(event.target.value)}
                    data-testid="export-from"
                  />
                )}
              </Field>
              <Field label="Last day">
                {(id) => (
                  <input
                    id={id}
                    type="date"
                    className="control"
                    value={toDay}
                    min={fromDay || undefined}
                    onChange={(event) => setToDay(event.target.value)}
                    data-testid="export-to"
                  />
                )}
              </Field>
            </>
          )}
          <SelectField label="Subject" value={subject} choices={SUBJECT_CHOICES} onChange={setSubject} testId="export-subject" />
        </div>
        <MatchCount problem={filterOutcome.ok ? null : filterOutcome.problem} preview={preview} />
      </Card>

      <Card title="Format">
        <div className="radio-group" role="radiogroup" aria-label="Format">
          {FORMAT_CHOICES.map((choice) => (
            <RadioOption
              key={choice.value}
              name="export-format"
              checked={format === choice.value}
              label={choice.label}
              description={choice.description}
              onSelect={() => setFormat(choice.value)}
              testId={`export-format-${choice.value}`}
            />
          ))}
        </div>
        <div className="actions">
          <button type="button" className="button" onClick={runExport} disabled={!canExport} data-testid="export-run">
            {exporting ? 'Exporting…' : 'Export…'}
          </button>
        </div>
      </Card>

      {outcome && (
        <Banner tone={outcome.tone} title={outcome.title} testId="export-outcome">
          <p data-testid="export-outcome-message">{outcome.message}</p>
        </Banner>
      )}
    </>
  )
}

/**
 * Saves that failed in the database wait in the error log (E3) and are not
 * in any export until they are retried. When there are any, the page says
 * so above the filters and offers Retry; otherwise it shows nothing.
 */
function PendingSaves({ refreshKey, onRetried }: { refreshKey: number; onRetried: () => void }) {
  // Bumped after a retry, so the list is read again.
  const [retries, setRetries] = useState(0)
  const pending = useBridgeCall(() => window.harness.listFailedWrites(), refreshKey + retries)
  const [retrying, setRetrying] = useState(false)
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null)

  const waiting = pending.status === 'ready' ? pending.value : []

  const retry = () => {
    setRetrying(true)
    setResult(null)
    window.harness
      .retryFailedWrites()
      .then((saved) => {
        setResult(describeRetry(waiting.length, saved))
        onRetried()
      })
      .catch((error: unknown) => setResult({ tone: 'danger', title: `Retry did not run: ${describeError(error)}` }))
      .finally(() => {
        setRetrying(false)
        setRetries((count) => count + 1)
      })
  }

  return (
    <>
      {result && <Banner tone={result.tone} title={result.title} testId="pending-saves-result" />}
      {pending.status === 'error' && (
        <Banner tone="danger" title="Could not check for saves waiting for a retry" testId="pending-saves-error">
          <p>{pending.message}</p>
        </Banner>
      )}
      {waiting.length > 0 && (
        <Banner tone="warning" title={describePendingSaves(waiting.length)} testId="pending-saves">
          <p>
            {waiting.length === 1
              ? 'It did not reach the database, so it is not in an export yet. Retry it first.'
              : 'They did not reach the database, so they are not in an export yet. Retry them first.'}
          </p>
          <ul>
            {waiting.map((write) => (
              <li key={write.id} title={write.error}>
                {write.description}
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" className="button button-secondary" onClick={retry} disabled={retrying} data-testid="pending-saves-retry">
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </Banner>
      )}
    </>
  )
}

function SessionField({
  sessions,
  value,
  choices,
  onChange,
}: {
  sessions: Loadable<unknown>
  value: string | null
  choices: ReadonlyArray<{ value: string; label: string }>
  onChange: (sessionId: string) => void
}) {
  if (sessions.status === 'ready' && value !== null) {
    return <SelectField label="Session" value={value} choices={choices} onChange={onChange} testId="export-session" />
  }
  const text =
    sessions.status === 'loading' ? 'Loading sessions…' : sessions.status === 'error' ? sessions.message : 'No session saved yet'
  return (
    <Field label="Session">
      {(id) => (
        <select id={id} className="control select" disabled data-testid="export-session">
          <option>{text}</option>
        </select>
      )}
    </Field>
  )
}

function MatchCount({ problem, preview }: { problem: string | null; preview: Loadable<ExportPreview> | { status: 'idle' } }) {
  if (problem !== null) {
    return (
      <p className="caption match-count match-count-problem" data-testid="export-match-count">
        {problem}
      </p>
    )
  }
  return (
    <p
      className={`caption match-count${preview.status === 'error' ? ' match-count-problem' : ''}`}
      aria-live="polite"
      data-testid="export-match-count"
    >
      {preview.status === 'ready' && describeMatches(preview.value)}
      {preview.status === 'error' && `Could not count the records: ${preview.message}`}
      {(preview.status === 'loading' || preview.status === 'idle') && 'Counting records…'}
    </p>
  )
}

/**
 * Reads how many records the filter matches whenever it changes. The last
 * count stays on screen while the next one is read, and a reply to a filter
 * the Tester has already changed is dropped.
 */
function usePreview(filterKey: string | null, refreshKey: number): Loadable<ExportPreview> | { status: 'idle' } {
  const [preview, setPreview] = useState<Loadable<ExportPreview> | { status: 'idle' }>({ status: 'idle' })

  useEffect(() => {
    if (filterKey === null) return
    let cancelled = false
    Promise.resolve()
      .then(() => window.harness.previewExport(JSON.parse(filterKey)))
      .then((value) => {
        if (!cancelled) setPreview({ status: 'ready', value })
      })
      .catch((error: unknown) => {
        if (!cancelled) setPreview({ status: 'error', message: describeError(error) })
      })
    return () => {
      cancelled = true
    }
  }, [filterKey, refreshKey])

  return preview
}
