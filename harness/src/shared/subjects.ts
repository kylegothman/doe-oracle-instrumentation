/**
 * The systems under test. E1 drives the DOE Oracle only.
 * TODO(#25): the shared SubjectAdapter interface arrives with E2.
 * TODO(#5, #6): the Copilot and Google adapters add their ids here.
 */
export type SubjectId = 'oracle'

export const SUBJECT_IDS: readonly SubjectId[] = ['oracle']

/** Human-readable names for messages and the UI. */
export const SUBJECT_LABELS: Record<SubjectId, string> = {
  oracle: 'DOE Oracle',
}

/** Upper-case subject codes used in data set names, for example DOE_ORACLE-2026-11-11. */
export const SUBJECT_CODES: Record<SubjectId, string> = {
  oracle: 'DOE_ORACLE',
}
