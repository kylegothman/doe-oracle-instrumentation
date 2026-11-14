/**
 * The systems under test (Detailed Design 3.2). The enum values are the
 * subject codes: what the trials table stores in its subject column and
 * what a data set name starts with, for example DOE_ORACLE-2026-11-12.
 *
 * TODO(#6): the Google adapter arrives with E5; until then GOOGLE has no
 * adapter registered.
 */
export enum Subject {
  DOE_ORACLE = 'DOE_ORACLE',
  COPILOT = 'COPILOT',
  GOOGLE = 'GOOGLE',
}

/** Every subject, in the order the harness lists them. */
export const SUBJECTS: readonly Subject[] = [Subject.DOE_ORACLE, Subject.COPILOT, Subject.GOOGLE]

/** Human-readable names for messages and the UI. */
export const SUBJECT_LABELS: Record<Subject, string> = {
  [Subject.DOE_ORACLE]: 'DOE Oracle',
  [Subject.COPILOT]: 'Microsoft Copilot',
  [Subject.GOOGLE]: 'Google Search',
}

/** True when value is one of the subject codes. Use it on anything that crossed the IPC bridge. */
export function isSubject(value: unknown): value is Subject {
  return typeof value === 'string' && (SUBJECTS as readonly string[]).includes(value)
}
