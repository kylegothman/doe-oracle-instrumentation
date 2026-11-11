import { describe, expect, it } from 'vitest'
import { createGetSqliteStatusHandler } from './sqlite-status'

describe('diagnostics:get-sqlite-status handler', () => {
  it('reports a successful probe with the SQLite version', async () => {
    const handler = createGetSqliteStatusHandler(Promise.resolve({ ok: true, version: '3.50.4' }))

    await expect(handler()).resolves.toEqual({ ok: true, version: '3.50.4' })
  })

  it('reports a failed probe with its error text', async () => {
    const handler = createGetSqliteStatusHandler({
      ok: false,
      error: 'The specified module could not be found. (ERR_DLOPEN_FAILED)',
    })

    await expect(handler()).resolves.toEqual({
      ok: false,
      error: 'The specified module could not be found. (ERR_DLOPEN_FAILED)',
    })
  })

  it('returns the same startup result on every call', async () => {
    const handler = createGetSqliteStatusHandler(Promise.resolve({ ok: true, version: '3.50.4' }))

    const [first, second] = await Promise.all([handler(), handler()])

    expect(first).toEqual(second)
  })
})
