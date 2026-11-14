/**
 * Reading the SignalR frames on Copilot's ChatHub WebSocket, for two things
 * only: whether a frame is the request that carries the question (the
 * cross-check for the Tester's submit, docs/copilot-spike.md) and the
 * citation URLs in the final message. Plus whether the stream completed, or
 * ended in an error, so a socket that closes early is told apart from one
 * that closes after the answer. Frames are parsed in memory and never
 * logged or stored; nothing here keeps a payload.
 */

/** SignalR's record separator: a text frame holds one or more JSON records ending in it. */
const RECORD_SEPARATOR = '\u001e'

/** The JSON records in one frame; records that are not JSON objects are skipped. */
export function parseSignalRRecords(payload: string | Buffer): Record<string, unknown>[] {
  const text = typeof payload === 'string' ? payload : payload.toString('utf8')
  const records: Record<string, unknown>[] = []
  for (const part of text.split(RECORD_SEPARATOR)) {
    if (part.trim() === '') continue
    try {
      const value: unknown = JSON.parse(part)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        records.push(value as Record<string, unknown>)
      }
    } catch {
      // Not JSON (a binary or malformed frame): nothing to read.
    }
  }
  return records
}

/**
 * True for a frame the page sends to invoke the chat: a SignalR invocation
 * (type 1) with arguments. The page's later telemetry invocation looks the
 * same, which is why the adapter only counts the first one after a submit.
 */
export function isChatRequestFrame(payload: string | Buffer): boolean {
  return parseSignalRRecords(payload).some(
    (record) => record.type === 1 && Array.isArray(record.arguments) && record.arguments.length > 0,
  )
}

/** A source the answer cites, as the final message's `references` map carries it. */
export interface CitationReference {
  title: string
  url: string
}

const URL_KEYS = ['targetLink', 'url', 'Url', 'link'] as const
const TITLE_KEYS = ['Title', 'title', 'name'] as const
const MAX_DEPTH = 12

/**
 * The cited sources in a received frame: every object, however nested, that
 * carries an http(s) link and a title, in document order, one per URL. The
 * final message's `references` map is where they live; nothing else in the
 * frame is read.
 */
export function extractReferences(payload: string | Buffer): CitationReference[] {
  const found: CitationReference[] = []
  const seen = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const record = value as Record<string, unknown>
    const url = firstString(record, URL_KEYS)
    const title = firstString(record, TITLE_KEYS)
    if (url && /^https?:\/\//.test(url) && title && title.trim() !== '' && !seen.has(url)) {
      seen.add(url)
      found.push({ title: title.trim(), url })
    }
    for (const child of Object.values(record)) visit(child, depth + 1)
  }
  for (const record of parseSignalRRecords(payload)) visit(record, 0)
  return found
}

/** True for a frame that ends the invocation: SignalR's completion record (type 3). */
export function isCompletionFrame(payload: string | Buffer): boolean {
  return parseSignalRRecords(payload).some((record) => record.type === 3)
}

/** The error a completion record carries when the invocation failed, or null. */
export function completionError(payload: string | Buffer): string | null {
  for (const record of parseSignalRRecords(payload)) {
    if (record.type === 3 && typeof record.error === 'string' && record.error.trim() !== '') {
      return record.error.trim()
    }
  }
  return null
}

/** The HTTP status in a WebSocket handshake error, for example "Unexpected response code: 503", or null. */
export function handshakeStatus(errorText: string): number | null {
  const match = errorText.match(/response code:\s*(\d{3})/i) ?? errorText.match(/\b(4\d\d|5\d\d)\b/)
  return match ? Number(match[1]) : null
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return null
}
