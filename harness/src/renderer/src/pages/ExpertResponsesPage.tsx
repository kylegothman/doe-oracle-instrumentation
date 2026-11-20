import { Card } from '../components/ui'

/**
 * The Expert Responses tab. E7 (stories #41 to #43) builds the page; until
 * then the tab only says so, so the shell already has its place.
 */
export function ExpertResponsesPage() {
  return (
    <Card title="Expert responses" subtitle="Entering the expert's answers arrives with E7.">
      <p className="caption">
        The Researcher will record the expert&apos;s name, how the answers arrived, the turnaround, and the answer to
        each of the 12 questions here.
      </p>
    </Card>
  )
}
