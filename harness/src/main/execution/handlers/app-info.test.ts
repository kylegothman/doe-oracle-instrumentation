import { describe, expect, it } from 'vitest'
import { createGetAppInfoHandler } from './app-info'

describe('app:get-info handler', () => {
  it('returns the app name and version from the app source', () => {
    const handler = createGetAppInfoHandler({
      getName: () => 'DOE Oracle Test Harness',
      getVersion: () => '0.1.0',
    })

    expect(handler()).toEqual({ name: 'DOE Oracle Test Harness', version: '0.1.0' })
  })

  it('returns only plain data that can cross the bridge', () => {
    const handler = createGetAppInfoHandler({ getName: () => 'x', getVersion: () => '1.2.3' })

    const info = handler()

    expect(Object.keys(info).sort()).toEqual(['name', 'version'])
    expect(structuredClone(info)).toEqual(info)
  })
})
