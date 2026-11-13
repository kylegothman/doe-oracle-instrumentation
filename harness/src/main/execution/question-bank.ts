import { readFileSync } from 'node:fs'
import type { Question } from '../../shared/questions'

/**
 * The standard questions every subject is asked (story #27), loaded from
 * config/questions.json. Numbers run from 1 with no gaps, so the file's
 * order is the order the Tester runs them in.
 */
export class QuestionBank {
  private readonly byNumber: Map<number, Question>

  constructor(questions: readonly Question[]) {
    validate(questions)
    this.byNumber = new Map(questions.map((q) => [q.number, { number: q.number, text: q.text }]))
  }

  /** Reads and validates a questions config file. Throws with the path and the problem when it is unusable. */
  static load(configPath: string): QuestionBank {
    let raw: string
    try {
      raw = readFileSync(configPath, 'utf8')
    } catch (error) {
      throw new Error(`Could not read the questions config at ${configPath}: ${describe(error)}`, { cause: error })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`The questions config at ${configPath} is not valid JSON: ${describe(error)}`, { cause: error })
    }
    try {
      return new QuestionBank(questionsFrom(parsed))
    } catch (error) {
      throw new Error(`The questions config at ${configPath} is invalid: ${describe(error)}`, { cause: error })
    }
  }

  /** How many questions the bank holds. */
  get size(): number {
    return this.byNumber.size
  }

  /** The question with this number. Throws when there is none. */
  getByNumber(number: number): Question {
    const question = this.byNumber.get(number)
    if (!question) {
      throw new Error(`Question ${number} is not in the question bank (1 to ${this.size})`)
    }
    return { ...question }
  }

  /** Every question in order. */
  list(): Question[] {
    return [...this.byNumber.values()].map((q) => ({ ...q }))
  }
}

function questionsFrom(parsed: unknown): Question[] {
  if (typeof parsed !== 'object' || parsed === null || !('questions' in parsed) || !Array.isArray(parsed.questions)) {
    throw new Error('expected an object with a "questions" array')
  }
  return parsed.questions.map((item: unknown, index: number): Question => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`entry ${index + 1} is not an object`)
    }
    const { number, text } = item as { number?: unknown; text?: unknown }
    if (!Number.isInteger(number) || (number as number) < 1) {
      throw new Error(`entry ${index + 1} needs a positive whole "number"`)
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(`question ${String(number)} needs a non-empty "text"`)
    }
    return { number: number as number, text }
  })
}

function validate(questions: readonly Question[]): void {
  if (questions.length === 0) {
    throw new Error('the question bank is empty')
  }
  questions.forEach((question, index) => {
    if (question.number !== index + 1) {
      throw new Error(`questions must be numbered 1 to ${questions.length} in order; entry ${index + 1} is number ${question.number}`)
    }
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
