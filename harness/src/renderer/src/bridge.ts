import { useEffect, useState } from 'react'

/** A bridge call's state: still loading, its value, or why it failed. */
export type Loadable<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

/** Electron prefixes errors that cross the bridge; show only the handler's own message. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': /, '').replace(/^\w*Error: /, '')
}

/** Calls one bridge method on mount and tracks loading, value, and failure. */
export function useBridgeCall<T>(call: () => Promise<T>, refreshKey = 0): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    // Resolve inside a promise so a missing bridge surfaces as an error on
    // screen instead of an uncaught exception.
    Promise.resolve()
      .then(call)
      .then((value) => {
        if (!cancelled) setState({ status: 'ready', value })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: describeError(error) })
      })
    return () => {
      cancelled = true
    }
    // The bridge methods are stable; the call is re-run only when refreshKey changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  return state
}
