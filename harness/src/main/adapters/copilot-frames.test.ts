import { describe, expect, it } from 'vitest'
import {
  completionError,
  extractReferences,
  handshakeStatus,
  isChatRequestFrame,
  isCompletionFrame,
  parseSignalRRecords,
} from './copilot-frames'

const RS = '\u001e'

describe('parseSignalRRecords', () => {
  it('splits a frame into its JSON records and skips what is not an object', () => {
    expect(parseSignalRRecords(`{"type":6}${RS}{"type":1,"target":"update","arguments":[{}]}${RS}`)).toEqual([
      { type: 6 },
      { type: 1, target: 'update', arguments: [{}] },
    ])
    expect(parseSignalRRecords(`not json${RS}[1,2]${RS}"text"${RS}`)).toEqual([])
    expect(parseSignalRRecords(Buffer.from(`{"type":3}${RS}`))).toEqual([{ type: 3 }])
    expect(parseSignalRRecords('')).toEqual([])
  })
})

describe('isChatRequestFrame', () => {
  it('recognises an invocation with arguments and nothing else', () => {
    expect(isChatRequestFrame(`{"arguments":[{"source":"officeweb"}],"target":"chat","type":1}${RS}`)).toBe(true)
    expect(isChatRequestFrame(`{"protocol":"json","version":1}${RS}`)).toBe(false)
    expect(isChatRequestFrame(`{"type":6}${RS}`)).toBe(false)
    expect(isChatRequestFrame(`{"type":1,"target":"update","arguments":[]}${RS}`)).toBe(false)
    expect(isChatRequestFrame(`{"type":2,"item":{"messages":[]}}${RS}`)).toBe(false)
    expect(isChatRequestFrame('binary-ish')).toBe(false)
  })
})

describe('extractReferences', () => {
  it('reads the final message\'s references map, in order, one per URL, and nothing without a link and a title', () => {
    const frame =
      JSON.stringify({
        type: 2,
        item: {
          messages: [
            {
              text: 'The answer [1][2]',
              references: {
                '1': { targetLink: 'https://www.speedtest.net/global-index', Title: 'Speedtest Global Index', provider: 'speedtest' },
                '2': { targetLink: 'https://example.test/report', Title: ' A report ' },
                '3': { targetLink: 'https://www.speedtest.net/global-index', Title: 'Duplicate of 1' },
                '4': { Title: 'No link' },
                '5': { targetLink: 'ftp://not-http.test/x', Title: 'Wrong scheme' },
                '6': { targetLink: 'https://example.test/untitled' },
              },
            },
          ],
        },
      }) + RS
    expect(extractReferences(frame)).toEqual([
      { title: 'Speedtest Global Index', url: 'https://www.speedtest.net/global-index' },
      { title: 'A report', url: 'https://example.test/report' },
    ])
  })

  it('accepts the plainer url and title spellings too, and finds nothing in an update frame', () => {
    expect(extractReferences(JSON.stringify({ type: 1, arguments: [{ sources: [{ url: 'https://a.test/', title: 'A' }] }] }) + RS)).toEqual([
      { title: 'A', url: 'https://a.test/' },
    ])
    expect(extractReferences(`{"type":1,"target":"update","arguments":[{"text":"hello"}]}${RS}`)).toEqual([])
    expect(extractReferences('')).toEqual([])
  })
})

describe('completion frames', () => {
  it('recognises the completion record and the error it may carry', () => {
    expect(isCompletionFrame(`{"type":3,"invocationId":"0"}${RS}`)).toBe(true)
    expect(isCompletionFrame(`{"type":1,"target":"update","arguments":[{}]}${RS}`)).toBe(false)
    expect(completionError(`{"type":3,"invocationId":"0"}${RS}`)).toBeNull()
    expect(completionError(`{"type":3,"error":"Something went wrong on the server."}${RS}`)).toBe('Something went wrong on the server.')
  })
})

describe('handshakeStatus', () => {
  it('finds the status in a handshake error and nothing in a connection error', () => {
    expect(handshakeStatus('Error during WebSocket handshake: Unexpected response code: 503')).toBe(503)
    expect(handshakeStatus('Unexpected server response: 401')).toBe(401)
    expect(handshakeStatus('Error in connection establishment: net::ERR_CONNECTION_REFUSED')).toBeNull()
    expect(handshakeStatus('')).toBeNull()
  })
})
