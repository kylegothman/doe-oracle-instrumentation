import { useEffect, useState } from 'react'
import { SUBJECT_LABELS } from '../../../shared/subjects'
import { useBridgeCall } from '../bridge'
import { badgeFor, elapsedAt, formatElapsed, IDLE, nextBarState, type BarState } from '../status-bar'
import { Badge } from './ui'

/** How often the counting time is redrawn: often enough for the hundredths to move. */
const TICK_MS = 50

/**
 * The session status bar (story #39, UC-2), at the bottom of every page:
 * this launch's session ID, the running trial's subject and question, its
 * elapsed time, and the trial status. It follows the trial events on its
 * own, so it is right whichever tab is open.
 */
export function StatusBar() {
  const session = useBridgeCall(() => window.harness.getSession())
  const [bar, setBar] = useState<BarState>(IDLE)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => window.harness.onTrialEvent((event) => setBar(nextBarState(event, Date.now()))), [])

  // Redraw only while the time is counting.
  const counting = bar.anchorAt !== null
  useEffect(() => {
    if (!counting) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [counting])

  const badge = badgeFor(bar)
  const sessionId = session.status === 'ready' ? session.value.sessionId : null
  const sessionTitle =
    session.status === 'ready'
      ? `Session ${session.value.sessionId}, started ${session.value.startedAt}`
      : session.status === 'error'
        ? `No session: ${session.message}`
        : 'Starting session…'

  return (
    <footer className="status-bar" aria-label="Session status" data-testid="status-bar">
      <span className="status-session" title={sessionTitle}>
        <span className="status-muted">Session</span>
        {session.status === 'error' ? (
          // Trials cannot be saved without a session, so this one is not left to a tooltip.
          <span role="alert" className="status-error" data-testid="status-session-error">
            No session: {session.message}
          </span>
        ) : (
          <span className="mono" data-testid="status-session-id">
            {sessionId === null ? '—' : sessionId.slice(0, 8)}
          </span>
        )}
      </span>
      <span className="status-divider" aria-hidden="true" />
      <span data-testid="status-subject">Subject: {bar.subject === null ? '—' : SUBJECT_LABELS[bar.subject]}</span>
      <span className="status-divider" aria-hidden="true" />
      <span data-testid="status-question">Question: {bar.questionNumber === null ? '—' : `Q${bar.questionNumber}`}</span>
      <span className="status-divider" aria-hidden="true" />
      <span className="mono" data-testid="status-elapsed">
        {formatElapsed(elapsedAt(bar, now))}
      </span>
      <span className="status-spacer" />
      {/* Only the status is announced; the time changes too often to read out. */}
      <span aria-live="polite">
        <Badge tone={badge.tone} label={badge.label} testId="status-badge" />
      </span>
    </footer>
  )
}
