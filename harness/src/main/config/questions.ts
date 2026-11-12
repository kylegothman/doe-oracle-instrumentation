import config from '../../shared/harness-config.json'

export interface Question {
  number: number
  text: string
}

/**
 * The questions the harness can ask. E1 ships question 1 only, read from
 * src/shared/harness-config.json so the adapter never hard-codes text.
 * TODO(#3): E2's QuestionBank owns the full 12-question set.
 */
export function listQuestions(): Question[] {
  return config.questions.map((q) => ({ number: q.number, text: q.text }))
}

/** The question with this number. Throws when it is not in the config. */
export function getQuestion(number: number): Question {
  const question = config.questions.find((q) => q.number === number)
  if (!question) {
    throw new Error(`Question ${number} is not in the harness config (known: ${config.questions.map((q) => q.number).join(', ')})`)
  }
  return { number: question.number, text: question.text }
}
