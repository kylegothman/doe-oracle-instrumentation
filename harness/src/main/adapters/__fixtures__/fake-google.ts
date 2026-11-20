import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

const HOME_HTML = readFileSync(fileURLToPath(new URL('./google-search.html', import.meta.url)), 'utf8')
const RESULTS_HTML = readFileSync(fileURLToPath(new URL('./google-results.html', import.meta.url)), 'utf8')
const SORRY_HTML = readFileSync(fileURLToPath(new URL('./google-sorry.html', import.meta.url)), 'utf8')
/** A 1x1 transparent GIF, for the image that holds the results page's load event back. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** What the next requests get. A test sets what it needs; everything else keeps its default. */
export interface FakeGoogleOptions {
  /** Milliseconds before /search answers at all: the time to first response. */
  searchDelayMs: number
  /** Milliseconds before the results page's image arrives: holds the load event back. */
  assetDelayMs: number
  /** Status of /search. 400 or higher answers with an error page instead of results. */
  searchStatus: number
  /** Answers the first /search with a redirect to the same search, as Google does when it adds parameters. */
  redirectSearch: boolean
  /** Drops the connection on /search without answering. */
  dropSearch: boolean
  /**
   * Where the "unusual traffic" check stands: in front of the home page, or
   * in front of the results. The request is redirected to /sorry/index,
   * which answers 429 with the check, as Google does. It is lifted, back to
   * 'none', only by the button on that page being clicked.
   */
  challenge: 'none' | 'home' | 'search'
  /**
   * Which results page is served:
   * - standard: an AI overview under its heading, three organic results, a "People also ask" block;
   * - ai-without-heading: the same, but the AI overview has no heading, so only a selector finds it;
   * - no-ai-overview: organic results only;
   * - empty: the results list is there with nothing in it.
   */
  results: 'standard' | 'ai-without-heading' | 'no-ai-overview' | 'empty'
}

const DEFAULTS: FakeGoogleOptions = {
  searchDelayMs: 0,
  assetDelayMs: 0,
  searchStatus: 200,
  redirectSearch: false,
  dropSearch: false,
  challenge: 'none',
  results: 'standard',
}

export interface FakeGoogle {
  /** The origin the pages are served from, for example http://127.0.0.1:51234. */
  origin: string
  options: FakeGoogleOptions
  /** Every /search request received, in order. */
  searches: Array<{ query: string | null; receivedAt: number }>
  /** How many times the check's button was clicked. Only a test, standing in for the Tester, may click it. */
  challengesSolved: number
  /** Puts the options back to their defaults and forgets the searches. */
  reset(): void
  close(): Promise<void>
}

/**
 * A small real HTTP server standing in for Google in google-adapter.test.ts:
 * the home page at /, the results page at /search, a page a result links
 * to at /result/one, and the "unusual traffic" check at /sorry/index. A real server, not page.route, so the browser
 * sees real navigations, responses, and load events.
 */
export async function startFakeGoogle(): Promise<FakeGoogle> {
  const fake: FakeGoogle = {
    origin: '',
    options: { ...DEFAULTS },
    searches: [],
    challengesSolved: 0,
    reset: () => {
      fake.options = { ...DEFAULTS }
      fake.searches.length = 0
      fake.challengesSolved = 0
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }

  const server = createServer((request, response) => {
    void handle(fake, request, response).catch(() => response.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}

async function handle(fake: FakeGoogle, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', fake.origin)
  const options = fake.options
  switch (url.pathname) {
    case '/':
      if (options.challenge === 'home') {
        challengeRedirect(response, url)
        return
      }
      html(response, 200, HOME_HTML)
      return
    case '/sorry/index':
      html(response, 429, SORRY_HTML.replace('__CONTINUE__', escapeAttribute(url.searchParams.get('continue') ?? '/')))
      return
    case '/sorry/solve':
      fake.challengesSolved += 1
      fake.options.challenge = 'none'
      response.writeHead(302, { Location: url.searchParams.get('continue') ?? '/' })
      response.end()
      return
    case '/search': {
      fake.searches.push({ query: url.searchParams.get('q'), receivedAt: Date.now() })
      if (options.dropSearch) {
        request.socket.destroy()
        return
      }
      await delay(options.searchDelayMs)
      if (options.challenge === 'search') {
        challengeRedirect(response, url)
        return
      }
      if (options.redirectSearch && !url.searchParams.has('redirected')) {
        url.searchParams.set('redirected', '1')
        response.writeHead(302, { Location: `${url.pathname}${url.search}` })
        response.end()
        return
      }
      if (options.searchStatus >= 400) {
        html(response, options.searchStatus, `<!DOCTYPE html><title>Error ${options.searchStatus}</title><p>Error ${options.searchStatus}</p>`)
        return
      }
      html(response, options.searchStatus, resultsPage(options.results))
      return
    }
    case '/slow.gif':
      await delay(options.assetDelayMs)
      response.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' })
      response.end(PIXEL)
      return
    case '/result/one':
      html(
        response,
        200,
        '<!DOCTYPE html><title>Combinatorial testing | CSRC</title><h1>Combinatorial testing</h1>' +
          '<p id="passage">Most failures are triggered by one or two parameters interacting.</p><p>Other text on the page.</p>',
      )
      return
    default:
      html(response, 404, '<!DOCTYPE html><title>Not found</title>')
  }
}

function resultsPage(variant: FakeGoogleOptions['results']): string {
  switch (variant) {
    case 'standard':
      return RESULTS_HTML
    case 'ai-without-heading':
      return cut(RESULTS_HTML, 'AI_HEADING')
    case 'no-ai-overview':
      return cut(RESULTS_HTML, 'AI_OVERVIEW')
    case 'empty':
      return cut(RESULTS_HTML, 'RESULTS')
  }
}

/** Sends the request on to the check, which goes back to this URL once lifted. */
function challengeRedirect(response: ServerResponse, url: URL): void {
  response.writeHead(302, { Location: `/sorry/index?continue=${encodeURIComponent(`${url.pathname}${url.search}`)}` })
  response.end()
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Removes everything between <!--NAME--> and <!--/NAME-->. */
function cut(page: string, name: string): string {
  const start = page.indexOf(`<!--${name}-->`)
  const end = page.indexOf(`<!--/${name}-->`)
  if (start < 0 || end < 0) throw new Error(`The results fixture has no ${name} section`)
  return page.slice(0, start) + page.slice(end + `<!--/${name}-->`.length)
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(body)
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
