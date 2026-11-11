import type { AppInfo } from '../../../shared/ipc'

/**
 * The slice of Electron's `app` the handler reads. Electron's `app` object
 * satisfies it directly; tests pass a plain object.
 */
export interface AppInfoSource {
  getName(): string
  getVersion(): string
}

/** Builds the handler for the `app:get-info` channel. */
export function createGetAppInfoHandler(source: AppInfoSource): () => AppInfo {
  return () => ({
    name: source.getName(),
    version: source.getVersion(),
  })
}
