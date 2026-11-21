import { useEffect, useState } from 'react'
import type { ExpertAnswerField, ExpertAnswerInput } from '../../../shared/expert-entry'
import type { Expert, ExpertResponse } from '../../../shared/experts'
import type { Question } from '../../../shared/questions'
import doneIcon from '../assets/step-done.svg'
import { describeError, type Loadable } from '../bridge'
import { Badge, Banner, Card, Field, Panel, SelectField } from '../components/ui'
import {
  answerQuestionLabel,
  answerTo,
  draftNote,
  draftState,
  firstOpenQuestion,
  localDateTime,
  progressLabel,
  progressSummary,
  questionProgress,
  withSavedAnswer,
} from './expert-responses'

/** A problem with an answer: under the answer box when it is the text, otherwise in a banner. */
type AnswerProblem = { field: ExpertAnswerField | null; message: string }

/**
 * The answers card of the Expert Responses page (story #41): which of the
 * standard questions the expert has answered, and one question at a time,
 * its text and the answer box. Picking an answered question shows its saved
 * answer. A question that already has an answer is not saved over.
 *
 * The page gives each expert its own card (by `key`), so drafts and the
 * picked question never carry from one expert to another.
 */
export function ExpertAnswersCard({ expert, questions, refreshKey }: { expert: Expert; questions: readonly Question[]; refreshKey: number }) {
  const [answers, setAnswers] = useState<Loadable<ExpertResponse[]>>({ status: 'loading' })
  // Null until the Researcher picks: the card then opens on the first open question.
  const [pickedQuestion, setPickedQuestion] = useState<number | null>(null)
  // Text typed for a question and not saved yet, kept while the Researcher looks at other questions.
  const [drafts, setDrafts] = useState<Readonly<Record<number, string>>>({})
  const [problem, setProblem] = useState<AnswerProblem | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => window.harness.listExpertAnswers(expert.expertId))
      .then((value) => {
        if (!cancelled) setAnswers({ status: 'ready', value })
      })
      .catch((error: unknown) => {
        if (!cancelled) setAnswers({ status: 'error', message: describeError(error) })
      })
    return () => {
      cancelled = true
    }
  }, [expert.expertId, refreshKey])

  const answerList = answers.status === 'ready' ? answers.value : []
  const progress = questionProgress(questions, answerList)
  const questionNumber = pickedQuestion ?? firstOpenQuestion(progress)
  const question = questions.find((candidate) => candidate.number === questionNumber)
  const saved = answerTo(answerList, questionNumber)
  const draft = drafts[questionNumber] ?? saved?.answerText ?? ''
  const state = draftState(draft, saved)
  // Nothing can be entered until the questions and the saved answers are both on screen.
  const locked = answers.status !== 'ready' || questions.length === 0 || saving

  const pickQuestion = (number: number) => {
    setPickedQuestion(number)
    setProblem(null)
    setSavedNote(null)
  }

  const save = (input: ExpertAnswerInput) => {
    setSaving(true)
    setProblem(null)
    setSavedNote(null)
    window.harness
      .saveExpertAnswer(input)
      .then((result) => {
        switch (result.status) {
          case 'INVALID':
            setProblem(result)
            return
          case 'ANSWER_EXISTS':
            // Show what the database holds; it is not replaced.
            setAnswers({ status: 'ready', value: withSavedAnswer(answerList, result.existing) })
            setProblem({ field: 'answerText', message: `Question ${input.questionNumber} already has an answer. It was not replaced.` })
            return
          case 'SAVED':
            setAnswers({ status: 'ready', value: withSavedAnswer(answerList, result.saved) })
            // The box now shows the answer as it was stored.
            setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([number]) => Number(number) !== input.questionNumber)))
            setPickedQuestion(input.questionNumber)
            setSavedNote(
              result.superseded
                ? `Replaced the answer to question ${input.questionNumber}. The earlier answer is kept as superseded and is left out of exports.`
                : `Saved the answer to question ${input.questionNumber}.`,
            )
            return
        }
      })
      .catch((error: unknown) => setProblem({ field: null, message: describeError(error) }))
      .finally(() => setSaving(false))
  }

  const questionChoices =
    questions.length > 0
      ? questions.map((candidate) => ({
          value: String(candidate.number),
          label: answerQuestionLabel(candidate, answerTo(answerList, candidate.number) !== undefined),
        }))
      : [{ value: String(questionNumber), label: 'No questions' }]

  return (
    <Card
      title={`Answers from ${expert.name}`}
      subtitle="One answer per question. Each is saved when you click Save Answer."
      aside={answers.status === 'ready' && questions.length > 0 ? <Badge tone={progressTone(progress)} label={progressLabel(progress)} testId="expert-progress" /> : undefined}
    >
      {answers.status === 'error' && (
        <Banner tone="danger" title="The saved answers could not be read" testId="expert-answers-error">
          <p>{answers.message}</p>
        </Banner>
      )}
      <div className="question-markers" role="group" aria-label="Questions, answered or open">
        {progress.map((each) => (
          <button
            key={each.number}
            type="button"
            className="question-marker"
            onClick={() => pickQuestion(each.number)}
            disabled={locked}
            aria-pressed={each.number === questionNumber}
            aria-label={`Question ${each.number}, ${each.answered ? 'answered' : 'open'}`}
            data-answered={each.answered}
            data-testid={`expert-question-${each.number}`}
          >
            {each.answered ? (
              <img className="step-icon" src={doneIcon} width={16} height={16} alt="" />
            ) : (
              <span className="step-icon step-icon-pending" aria-hidden="true" />
            )}
            Q{each.number}
          </button>
        ))}
      </div>
      <p className="caption" data-testid="expert-progress-summary">
        {answers.status === 'loading' ? 'Reading the saved answers…' : progressSummary(progress)}
      </p>
      <SelectField
        label="Question"
        value={String(questionNumber)}
        choices={questionChoices}
        onChange={(value) => pickQuestion(Number(value))}
        disabled={locked}
        testId="expert-question-select"
      />
      <Panel label="Question">
        <p className="panel-text" data-testid="expert-question-text">
          {question?.text ?? '—'}
        </p>
      </Panel>
      <Field label={`Answer to question ${questionNumber}`} error={problem?.field === 'answerText' ? problem.message : null}>
        {(id, errorId) => (
          <textarea
            id={id}
            className="control answer-input"
            value={draft}
            onChange={(event) => {
              setDrafts((current) => ({ ...current, [questionNumber]: event.target.value }))
              setProblem(null)
              setSavedNote(null)
            }}
            readOnly={locked}
            rows={8}
            aria-invalid={errorId ? true : undefined}
            aria-describedby={errorId}
            data-testid="expert-answer"
          />
        )}
      </Field>
      {problem && problem.field !== 'answerText' && (
        <Banner tone="danger" title="The answer was not saved" testId="expert-answer-error">
          <p>{problem.message}</p>
        </Banner>
      )}
      {savedNote && <Banner tone="success" title={savedNote} testId="expert-answer-saved" />}
      <div className="actions actions-split">
        <p className="caption" data-testid="expert-answer-note">
          {saved ? `${draftNote(state)} Saved ${localDateTime(saved.recordedAt)}, Test # ${saved.testNumber ?? '—'}.` : draftNote(state)}
        </p>
        <button
          type="button"
          className="button"
          onClick={() => save({ expertId: expert.expertId, questionNumber, answerText: draft, replace: false })}
          // An empty box can still be tried, so the page says the answer is empty; the saved answer unchanged has nothing to save.
          disabled={locked || state === 'saved'}
          data-testid="expert-answer-save"
        >
          {saving ? 'Saving…' : 'Save Answer'}
        </button>
      </div>
    </Card>
  )
}

/** The progress badge is neutral until something is answered, then accent, and success once all are. */
function progressTone(progress: ReadonlyArray<{ answered: boolean }>): 'neutral' | 'accent' | 'success' {
  const answered = progress.filter((question) => question.answered).length
  if (answered === 0) return 'neutral'
  return answered === progress.length ? 'success' : 'accent'
}
