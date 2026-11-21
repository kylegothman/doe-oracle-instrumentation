import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ExpertField } from '../../../shared/expert-entry'
import type { Expert } from '../../../shared/experts'
import { describeError, type Loadable } from '../bridge'
import { Banner, Card, Field, Segmented, SelectField } from '../components/ui'
import {
  buildExpertInput,
  defaultExpertId,
  expertChoices,
  formFor,
  formatTurnaround,
  formTurnaroundMs,
  NEW_EXPERT,
  NEW_EXPERT_FORM,
  SOURCE_CHOICES,
  turnaroundDetail,
  withSavedExpert,
  type ExpertForm,
} from './expert-responses'

/**
 * The Expert Responses page (stories #41 to #43, UC-5): the Researcher
 * records the expert (name, how the answers arrived, when the questions
 * went out and when the first answer came back) and then the expert's
 * answer to each of the 12 standard questions. Everything is saved as it
 * is entered, so a partial entry is resumed on the next launch.
 *
 * The name is the only personal detail the page asks for (NFR-7).
 *
 * `refreshKey` changes each time the Researcher opens the tab, so the page
 * shows saves that were retried from the Export tab since the last visit.
 */
export function ExpertResponsesPage({ refreshKey }: { refreshKey: number }) {
  const [experts, setExperts] = useState<Loadable<Expert[]>>({ status: 'loading' })
  // Undefined until the Researcher picks: the page then opens on the only saved expert, if there is one.
  const [pickedId, setPickedId] = useState<string | null | undefined>(undefined)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => window.harness.listExperts())
      .then((value) => {
        if (!cancelled) setExperts({ status: 'ready', value })
      })
      .catch((error: unknown) => {
        if (!cancelled) setExperts({ status: 'error', message: describeError(error) })
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const expertList = experts.status === 'ready' ? experts.value : []
  const selectedId = pickedId === undefined ? defaultExpertId(expertList) : pickedId
  const selected = expertList.find((expert) => expert.expertId === selectedId) ?? null

  const onSaved = (expert: Expert, created: boolean) => {
    setExperts({ status: 'ready', value: withSavedExpert(expertList, expert) })
    setPickedId(expert.expertId)
    setSavedNote(created ? `Saved ${expert.name}. Enter the answers below.` : `Saved the changes to ${expert.name}.`)
  }

  return (
    <>
      {experts.status === 'error' && (
        <Banner tone="danger" title="The saved experts could not be read" testId="expert-list-error">
          <p>{experts.message}</p>
        </Banner>
      )}
      <ExpertCard
        // A new card per expert, so one expert's unsaved edits never show under another.
        key={`expert-${selected?.expertId ?? NEW_EXPERT}`}
        experts={expertList}
        loading={experts.status === 'loading'}
        selected={selected}
        savedNote={savedNote}
        onSelect={(expertId) => {
          setPickedId(expertId)
          setSavedNote(null)
        }}
        onEdited={() => setSavedNote(null)}
        onSaved={onSaved}
      />
      <Card title="Answers" subtitle="The expert's answer to each of the 12 standard questions.">
        <p className="caption" data-testid="expert-answers-waiting">
          Save the expert first, or pick a saved expert. The answers are entered here, one question at a time.
        </p>
      </Card>
    </>
  )
}

/** A problem with the expert record: under its field when it has one, otherwise in a banner. */
type ExpertProblem = { field: ExpertField | null; message: string }

function ExpertCard({
  experts,
  loading,
  selected,
  savedNote,
  onSelect,
  onEdited,
  onSaved,
}: {
  experts: readonly Expert[]
  loading: boolean
  selected: Expert | null
  savedNote: string | null
  onSelect: (expertId: string | null) => void
  onEdited: () => void
  onSaved: (expert: Expert, created: boolean) => void
}) {
  // Null while the form shows what is saved; the Researcher's changes once they type.
  const [edits, setEdits] = useState<ExpertForm | null>(null)
  const [problem, setProblem] = useState<ExpertProblem | null>(null)
  const [saving, setSaving] = useState(false)
  const outreachInput = useRef<HTMLInputElement>(null)
  const firstAnswerInput = useRef<HTMLInputElement>(null)

  const form = edits ?? (selected ? formFor(selected) : NEW_EXPERT_FORM)
  const turnaround = formTurnaroundMs(form)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const change = (patch: Partial<ExpertForm>) => {
    setEdits({ ...form, ...patch })
    setProblem(null)
    onEdited()
  }
  const errorFor = (field: ExpertField): string | null => (problem?.field === field ? problem.message : null)

  const save = () => {
    // A date without its time leaves the input's value empty; only the input itself knows it holds half an entry.
    const outcome = buildExpertInput({ ...form, outreachIncomplete: holdsHalfAnEntry(outreachInput), firstAnswerIncomplete: holdsHalfAnEntry(firstAnswerInput) })
    if (!outcome.ok) {
      setProblem(outcome)
      return
    }
    setSaving(true)
    setProblem(null)
    window.harness
      .saveExpert(outcome.input)
      .then((result) => {
        if (result.status === 'INVALID') {
          setProblem(result)
          return
        }
        setEdits(null)
        onSaved(result.expert, outcome.input.expertId === null)
      })
      .catch((error: unknown) => setProblem({ field: null, message: describeError(error) }))
      .finally(() => setSaving(false))
  }

  return (
    <Card title="Expert" subtitle="Who answered, how the answers arrived, and the turnaround. Only the name is stored about the person.">
      <SelectField
        label="Expert"
        value={selected?.expertId ?? NEW_EXPERT}
        choices={loading ? [{ value: NEW_EXPERT, label: 'Loading experts…' }] : expertChoices(experts)}
        onChange={(value) => onSelect(value === NEW_EXPERT ? null : value)}
        disabled={loading || saving}
        testId="expert-select"
      />
      <div className="field-row">
        <Field label="Name" error={errorFor('name')}>
          {(id, errorId) => (
            <input
              id={id}
              type="text"
              className="control"
              value={form.name}
              onChange={(event) => change({ name: event.target.value })}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errorId ? true : undefined}
              aria-describedby={errorId}
              data-testid="expert-name"
            />
          )}
        </Field>
        <Segmented label="Source" value={form.source} choices={SOURCE_CHOICES} onChange={(source) => change({ source })} testId="expert-source" />
      </div>
      <div className="field-row">
        <Field label="Outreach sent" error={errorFor('outreachTs')}>
          {(id, errorId) => (
            <input
              id={id}
              ref={outreachInput}
              type="datetime-local"
              className="control"
              value={form.outreachLocal}
              onChange={(event) => change({ outreachLocal: event.target.value })}
              aria-invalid={errorId ? true : undefined}
              aria-describedby={errorId}
              data-testid="expert-outreach"
            />
          )}
        </Field>
        <Field label="First answer received" error={errorFor('firstAnswerTs')}>
          {(id, errorId) => (
            <input
              id={id}
              ref={firstAnswerInput}
              type="datetime-local"
              className="control"
              value={form.firstAnswerLocal}
              onChange={(event) => change({ firstAnswerLocal: event.target.value })}
              aria-invalid={errorId ? true : undefined}
              aria-describedby={errorId}
              data-testid="expert-first-answer"
            />
          )}
        </Field>
        <div className="field">
          <span className="label">Turnaround</span>
          <p className="turnaround" data-testid="expert-turnaround">
            {formatTurnaround(turnaround)}
          </p>
          <p className="caption mono" data-testid="expert-turnaround-ms">
            {turnaroundDetail(turnaround)}
          </p>
        </div>
      </div>
      <p className="caption">
        Enter both times in this computer&apos;s local time ({timeZone}). They are stored in UTC. Leave the first answer empty until the
        reply arrives; the turnaround is stored once, with the expert.
      </p>
      {problem && problem.field !== 'name' && problem.field !== 'outreachTs' && problem.field !== 'firstAnswerTs' && (
        <Banner tone="danger" title="The expert was not saved" testId="expert-save-error">
          <p>{problem.message}</p>
        </Banner>
      )}
      {savedNote && <Banner tone="success" title={savedNote} testId="expert-saved" />}
      <div className="actions">
        <button
          type="button"
          className="button"
          onClick={save}
          // A new expert can always be tried, so an empty form says what is missing; a saved one only once it is changed.
          disabled={saving || loading || (selected !== null && edits === null)}
          data-testid="expert-save"
        >
          {saving ? 'Saving…' : selected ? 'Save Changes' : 'Save Expert'}
        </button>
      </div>
    </Card>
  )
}

/** True when a date and time input holds part of an entry, which it reports as an empty value. */
function holdsHalfAnEntry(input: RefObject<HTMLInputElement | null>): boolean {
  return input.current?.validity.badInput ?? false
}
