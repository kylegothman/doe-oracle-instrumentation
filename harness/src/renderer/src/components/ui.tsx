import { useId, type ReactNode } from 'react'
import dotAccent from '../assets/dot-accent.svg'
import dotDanger from '../assets/dot-danger.svg'
import dotNeutral from '../assets/dot-neutral.svg'
import dotSuccess from '../assets/dot-success.svg'
import dotWarning from '../assets/dot-warning.svg'

/**
 * The design's building blocks (Figma "Mockups" page, components Card,
 * Field, SegmentOption, RadioOption, Banner, Button). The look lives in
 * styles.css; these only fix the markup and the accessible names.
 */

export function Card({
  title,
  subtitle,
  aside,
  children,
}: {
  title: string
  subtitle?: string
  /** Shown at the right of the header, for example a status badge. */
  aside?: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section className="card" aria-labelledby={headingId}>
      <header className="card-header">
        <div className="heading-group">
          <h2 id={headingId} className="card-title">
            {title}
          </h2>
          {subtitle && <p className="caption">{subtitle}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  )
}

/**
 * A labeled control. `children` renders the control with the id it is
 * given. With an `error`, the message is shown under the control and
 * announced, and `children` gets its id as a second argument, to point the
 * control's `aria-describedby` at.
 */
export function Field({
  label,
  error,
  children,
}: {
  label: string
  /** What is wrong with this field's value, shown under the control. */
  error?: string | null
  children: (id: string, errorId: string | undefined) => ReactNode
}) {
  const id = useId()
  const errorId = `${id}-error`
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children(id, error ? errorId : undefined)}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export interface Choice<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

/** A dropdown field. */
export function SelectField<T extends string>({
  label,
  value,
  choices,
  onChange,
  disabled,
  testId,
}: {
  label: string
  value: T
  choices: ReadonlyArray<Choice<T>>
  onChange: (value: T) => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <Field label={label}>
      {(id) => (
        <select
          id={id}
          className="control select"
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          disabled={disabled}
          data-testid={testId}
        >
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

/** A segmented control: two or three options, one selected. A radio group underneath. */
export function Segmented<T extends string>({
  label,
  value,
  choices,
  onChange,
  testId,
}: {
  label: string
  value: T
  choices: ReadonlyArray<Choice<T>>
  onChange: (value: T) => void
  testId?: string
}) {
  const name = useId()
  return (
    <fieldset className="field">
      <legend className="label">{label}</legend>
      <div className="segmented" data-testid={testId}>
        {choices.map((choice) => (
          <label key={choice.value} className="segment">
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={choice.value === value}
              disabled={choice.disabled}
              onChange={() => onChange(choice.value)}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** One choice of a radio group, with a description below its label. */
export function RadioOption({
  name,
  checked,
  label,
  description,
  onSelect,
  testId,
}: {
  name: string
  checked: boolean
  label: string
  description: string
  onSelect: () => void
  testId?: string
}) {
  return (
    <label className="radio-option" data-testid={testId}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} />
      <span className="radio-mark" aria-hidden="true" />
      <span className="radio-text">
        <span className="radio-label">{label}</span>
        <span className="caption">{description}</span>
      </span>
    </label>
  )
}

/**
 * The badge's dot per tone. Neutral and accent are the design's own SVGs;
 * success, danger, and warning are the same 6 px circle in the design's
 * text colors for those tones.
 */
const BADGE_DOTS = { neutral: dotNeutral, accent: dotAccent, success: dotSuccess, danger: dotDanger, warning: dotWarning } as const

export type BadgeTone = keyof typeof BADGE_DOTS

/** A trial or record status pill: a dot and a short label. */
export function Badge({ tone, label, testId }: { tone: BadgeTone; label: string; testId?: string }) {
  return (
    <span className={`badge badge-${tone}`} data-testid={testId} data-tone={tone}>
      <img className="badge-dot" src={BADGE_DOTS[tone]} width={6} height={6} alt="" />
      {label}
    </span>
  )
}

/** A label over a value, as in the result cards: "Response time / 4,812 ms". */
export function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value mono" data-testid={testId}>
        {value}
      </span>
    </div>
  )
}

/** A boxed block with a small capitalized label: "EXACT TEXT SENT", "ANSWER PREVIEW". */
export function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="panel">
      <p className="overline">{label}</p>
      {children}
    </div>
  )
}

export type Tone = 'info' | 'success' | 'warning' | 'danger'

/** An inline message: instructions (info), outcomes (success, danger), confirmations (warning). */
export function Banner({ tone, title, children, testId }: { tone: Tone; title: string; children?: ReactNode; testId?: string }) {
  // Outcomes that went wrong are announced; the others are read in place.
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'} data-testid={testId}>
      <p className="banner-title">{title}</p>
      {children && <div className="banner-message">{children}</div>}
    </div>
  )
}
