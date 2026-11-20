import { useState, type KeyboardEvent } from 'react'
import { Card } from './components/ui'
import { ExpertResponsesPage } from './pages/ExpertResponsesPage'
import { TestConsolePage } from './pages/TestConsolePage'

type PageId = 'console' | 'expert' | 'export'

const PAGES: ReadonlyArray<{ id: PageId; label: string }> = [
  { id: 'console', label: 'Test Console' },
  { id: 'expert', label: 'Expert Responses' },
  { id: 'export', label: 'Export' },
]

/**
 * The app shell: the header with the three tabs, and the page below it.
 *
 * Every page stays mounted and only the active one is shown. Switching to
 * Export in the middle of a trial must not unmount the Test Console, which
 * holds the running trial and its event subscription.
 */
export function App() {
  const [active, setActive] = useState<PageId>('console')

  // Arrow keys move between tabs, as in any tab list.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const index = PAGES.findIndex((page) => page.id === active)
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = PAGES[(index + step + PAGES.length) % PAGES.length]
    if (!next) return
    setActive(next.id)
    document.getElementById(`tab-${next.id}`)?.focus()
  }

  return (
    <div className="shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">DOE Oracle Test Harness</span>
        </div>
        <nav className="tabs" role="tablist" aria-label="Pages">
          {PAGES.map((page) => (
            <button
              key={page.id}
              id={`tab-${page.id}`}
              type="button"
              role="tab"
              className="tab"
              aria-selected={page.id === active}
              aria-controls={`page-${page.id}`}
              tabIndex={page.id === active ? 0 : -1}
              onClick={() => setActive(page.id)}
              onKeyDown={onTabKeyDown}
              data-testid={`tab-${page.id}`}
            >
              {page.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        <section id="page-console" role="tabpanel" aria-labelledby="tab-console" hidden={active !== 'console'}>
          <TestConsolePage />
        </section>
        <section id="page-expert" role="tabpanel" aria-labelledby="tab-expert" hidden={active !== 'expert'}>
          <ExpertResponsesPage />
        </section>
        <section id="page-export" role="tabpanel" aria-labelledby="tab-export" hidden={active !== 'export'}>
          <Card title="Export" subtitle="The Export Page arrives with story #40.">
            <p className="caption">Exporting the test log as a TestLogV3 workbook or CSV will be done here.</p>
          </Card>
        </section>
      </main>
    </div>
  )
}
