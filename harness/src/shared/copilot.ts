/**
 * What the Copilot page shows, as the harness reads it before and during a
 * trial (docs/copilot-spike.md):
 * - chat: the question input is there; the page is signed in and usable;
 * - signed_out: the sign-in landing page, or a sign-in host;
 * - offline: the "No internet connection" state that replaces the app;
 * - unknown: none of the above appeared in time.
 */
export type CopilotPageState = 'chat' | 'signed_out' | 'offline' | 'unknown'

/** Result of the "Open Copilot to sign in" action. */
export interface CopilotSignInStatus {
  /** The configured product: m365 or consumer. */
  product: string
  /** The product's label, for the UI. */
  label: string
  /** The chat page that was opened. */
  chatUrl: string
  /** Where the page ended up, origin and path only. */
  url: string
  state: CopilotPageState
  /** True when the chat input appeared: the Tester can run a trial. */
  signedIn: boolean
}
