import { describe, expect, it } from 'vitest'
import { FailureType, type FailureSignal } from '../../shared/failures'
import { FailureDetector } from './failure-detector'

describe('FailureDetector.classify', () => {
  const detector = new FailureDetector()

  it.each<[string, FailureSignal, FailureType | null]>([
    ['a timed-out trial', { timedOut: true }, FailureType.TIMEOUT],
    ['timed out, even with a status and an answer', { timedOut: true, httpStatus: 200, answerText: 'late' }, FailureType.TIMEOUT],
    ['HTTP 400 from the endpoint', { httpStatus: 400, timedOut: false }, FailureType.ERROR_RESPONSE],
    ['HTTP 500 from the endpoint', { httpStatus: 500, timedOut: false }, FailureType.ERROR_RESPONSE],
    ['HTTP 503 with a network error too', { httpStatus: 503, networkError: 'x', timedOut: false }, FailureType.ERROR_RESPONSE],
    ['HTTP 399 is not an error response', { httpStatus: 399, timedOut: false }, null],
    ['HTTP 200 is not a failure', { httpStatus: 200, timedOut: false }, null],
    ['an error shown in place of an answer', { errorMessage: 'Something went wrong. Try again.', timedOut: false }, FailureType.ERROR_RESPONSE],
    ['an error shown, with a network error too', { errorMessage: 'Something went wrong', networkError: 'x', timedOut: false }, FailureType.ERROR_RESPONSE],
    ['a blank error message is no error', { errorMessage: ' ', timedOut: false }, null],
    ['a refused connection', { networkError: 'net::ERR_CONNECTION_REFUSED', timedOut: false }, FailureType.UNREACHABLE],
    ['a page that could not be loaded', { networkError: 'Could not reach the DOE Oracle at http://localhost:5173/chat', timedOut: false }, FailureType.UNREACHABLE],
    ['the frontend up but its backend down', { networkError: 'The request to /api/search failed before a response arrived (net::ERR_CONNECTION_REFUSED)', timedOut: false }, FailureType.UNREACHABLE],
    ['a blank network error is no error', { networkError: '   ', timedOut: false }, null],
    ['an empty answer', { answerText: '', timedOut: false }, FailureType.EMPTY_ANSWER],
    ['a whitespace-only answer', { answerText: ' \n\t ', timedOut: false }, FailureType.EMPTY_ANSWER],
    ['an empty answer with a 200', { httpStatus: 200, answerText: '', timedOut: false }, FailureType.EMPTY_ANSWER],
    ['a real answer', { answerText: 'Combinatorial testing covers t-way interactions.', timedOut: false }, null],
    ['a refusal is an answer, not a failure', { answerText: "I can't answer that question.", timedOut: false }, null],
    ['a refusal with a 200', { httpStatus: 200, answerText: 'I am not able to help with that.', timedOut: false }, null],
    ['nothing observed', { timedOut: false }, null],
  ])('%s', (_label, signal, expected) => {
    expect(detector.classify(signal)).toBe(expected)
  })
})

describe('FailureDetector.isEmptyAnswer', () => {
  const detector = new FailureDetector()

  it.each([
    ['', true],
    ['   ', true],
    ['\n\t', true],
    ['x', false],
    ['  Sorry, I cannot answer that.  ', false],
    ['0', false],
  ])('%j → %s', (text, expected) => {
    expect(detector.isEmptyAnswer(text)).toBe(expected)
  })
})
