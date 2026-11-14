/**
 * Reading the SignalR frames on Copilot's ChatHub WebSocket, for two things
 * only: whether a frame is the request that carries the question (the
 * cross-check for the Tester's submit, docs/copilot-spike.md) and, in #35,
 * the citation URLs in the final message. Frames are parsed in memory and
 * never logged or stored; nothing here keeps a payload.
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
