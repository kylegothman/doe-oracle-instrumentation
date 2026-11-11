/// <reference types="vite/client" />
import type { HARNESS_API_KEY, HarnessApi } from '../../shared/ipc'

declare global {
  interface Window {
    /** Typed bridge to the main process, exposed by the preload script. */
    readonly [HARNESS_API_KEY]: HarnessApi
  }
}
