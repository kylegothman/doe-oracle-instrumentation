import { useState, type KeyboardEvent } from 'react'
import { StatusBar } from './components/StatusBar'
import { ExpertResponsesPage } from './pages/ExpertResponsesPage'
import { ExportPage } from './pages/ExportPage'
import { TestConsolePage } from './pages/TestConsolePage'

type PageId = 'console' | 'expert' | 'export'

const PAGES: ReadonlyArray<{ id: PageId; label: string }> = [
  { id: 'console', label: 'Test Console' },
  { id: 'expert', label: 'Expert Responses' },
  { id: 'export', label: 'Export' },
]

/**
 * The app shell: the header with the three tabs, the page below it, and the
 * session status bar at the bottom of every page.
 *
 * Every page stays mounted and only the active one is shown. Switching to
 * Export in the middle of a trial must not unmount the Test Console, which
 * holds the running trial and its event subscription.
 */
export function App() {
  const [active, setActiveState] = useState<PageId>('console')
  // How many times Export was opened: it re-reads its sessions and count on each visit.
  const [exportVisits, setExportVisits] = useState(0)

  const setActive = (page: PageId) => {
    if (page === 'export' && active !== 'export') setExportVisits((visits) => visits + 1)
    setActiveState(page)
  }

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
          <ExportPage refreshKey={exportVisits} />
        </section>
      </main>
      <StatusBar />
    </div>
  )
}
