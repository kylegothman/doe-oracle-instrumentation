import { describe, expect, it, vi } from 'vitest'
import { openSubjectPage, SubjectUnreachableError, type Navigable } from './navigation'

function failingPage(message: string): Navigable {
  return {
    goto: vi.fn(async () => {
      throw new Error(message)
    }),
  }
}

describe('openSubjectPage', () => {
  it('navigates with a timeout and waits for the DOM', async () => {
    const page: Navigable = { goto: vi.fn(async () => null) }

    await openSubjectPage(page, 'oracle', 'http://localhost:5173/chat', { timeoutMs: 1234 })

    expect(page.goto).toHaveBeenCalledWith('http://localhost:5173/chat', {
      timeout: 1234,
      waitUntil: 'domcontentloaded',
    })
  })

  it('turns a refused connection into a clear message naming the subject and URL', async () => {
    const page = failingPage('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/chat')

    const error = await openSubjectPage(page, 'oracle', 'http://localhost:5173/chat').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SubjectUnreachableError)
    expect((error as Error).message).toBe(
      'Could not reach the DOE Oracle at http://localhost:5173/chat. Make sure it is running, then try again. (net::ERR_CONNECTION_REFUSED)',
    )
  })

  it('treats a navigation timeout as unreachable', async () => {
    const page = failingPage('page.goto: Timeout 15000ms exceeded.')

    await expect(openSubjectPage(page, 'oracle', 'http://localhost:5173/chat')).rejects.toThrow(
      /Could not reach the DOE Oracle .*\(timed out waiting for the page\)/,
    )
  })

  it('passes other errors through unchanged', async () => {
    const page = failingPage('page.goto: Target page, context or browser has been closed')

    await expect(openSubjectPage(page, 'oracle', 'http://localhost:5173/chat')).rejects.toThrow(
      /Target page, context or browser has been closed/,
    )
  })
})
