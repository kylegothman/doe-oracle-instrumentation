import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'

/**
 * A minimal WebSocket server standing in for Copilot's ChatHub in the
 * adapter tests. Playwright reports frames only for real sockets, not for
 * ones mocked with page.routeWebSocket, so the fixture page connects here.
 * It speaks just enough of RFC 6455 for text frames, pings, and close. It
 * also serves the fixture page itself, at /chat: Chromium's local network
 * access check blocks a page on another origin from opening a socket to
 * the loopback address, so page and socket must share it.
 */
export interface FakeChatHubOptions {
  /** The HTML served at /chat (and every other path). */
  html?: string
  /** Frames to send after a request frame arrives, each at its delay after the request. Objects are JSON-encoded SignalR records. */
  replies?: Array<{ afterMs: number; payload: unknown }>
  /** Close the socket this long after the request; null keeps it open. Default: 50 ms after the last reply. */
  closeAfterMs?: number | null
  /** Refuse the handshake with this HTTP status instead of upgrading. */
  rejectStatus?: number
}

export interface FakeChatHub {
  /** The socket URL for the fixture page, ending in the ChatHub path. */
  url: string
  /** Where the fixture page is served. */
  chatUrl: string
  /** Text frames received, in order. */
  received: string[]
  /** When each request frame (an invocation with arguments) arrived, by this process's clock. */
  requestsAt: number[]
  close(): Promise<void>
}

const RS = '\u001e'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export async function startFakeChatHub(options: FakeChatHubOptions = {}): Promise<FakeChatHub> {
  const received: string[] = []
  const requestsAt: number[] = []
  const sockets = new Set<Socket>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(options.html ?? '<!doctype html><title>fake hub</title>')
  })

  server.on('upgrade', (request, socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    if (options.rejectStatus) {
      socket.end(`HTTP/1.1 ${options.rejectStatus} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const key = String(request.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      for (;;) {
        const frame = readFrame(buffered)
        if (!frame) break
        buffered = buffered.subarray(frame.length)
        if (frame.opcode === 0x8) {
          socket.end(closeFrame(1000))
          return
        }
        if (frame.opcode === 0x9) {
          socket.write(controlFrame(0xa, frame.payload))
          continue
        }
        if (frame.opcode !== 0x1) continue
        const text = frame.payload.toString('utf8')
        received.push(text)
        if (isRequest(text)) {
          requestsAt.push(Date.now())
          schedule(socket)
        }
      }
    })
    socket.on('error', () => undefined)
  })

  const schedule = (socket: Socket): void => {
    const replies = options.replies ?? []
    for (const reply of replies) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!socket.destroyed) socket.write(textFrame(JSON.stringify(reply.payload) + RS))
      }, reply.afterMs)
      timers.add(timer)
    }
    const closeAfterMs =
      options.closeAfterMs === undefined ? Math.max(0, ...replies.map((reply) => reply.afterMs)) + 50 : options.closeAfterMs
    if (closeAfterMs !== null) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!socket.destroyed) socket.end(closeFrame(1000))
      }, closeAfterMs)
      timers.add(timer)
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `ws://127.0.0.1:${port}/m365Copilot/Chathub/fixture-user`,
    chatUrl: `http://127.0.0.1:${port}/chat`,
    received,
    requestsAt,
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function isRequest(text: string): boolean {
  return text.split(RS).some((part) => {
    try {
      const record: unknown = JSON.parse(part)
      return (
        typeof record === 'object' &&
        record !== null &&
        (record as { type?: unknown }).type === 1 &&
        Array.isArray((record as { arguments?: unknown }).arguments)
      )
    } catch {
      return false
    }
  })
}

/** Parses one client frame (masked) from the front of the buffer, or returns null if it is incomplete. */
function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; length: number } | null {
  if (buffer.length < 2) return null
  const opcode = buffer[0]! & 0x0f
  const masked = (buffer[1]! & 0x80) !== 0
  let payloadLength = buffer[1]! & 0x7f
  let offset = 2
  if (payloadLength === 126) {
    if (buffer.length < 4) return null
    payloadLength = buffer.readUInt16BE(2)
    offset = 4
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null
    payloadLength = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null
  if (masked) offset += 4
  if (buffer.length < offset + payloadLength) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength))
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!
  }
  return { opcode, payload, length: offset + payloadLength }
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

function controlFrame(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
}

function closeFrame(code: number): Buffer {
  const payload = Buffer.alloc(2)
  payload.writeUInt16BE(code, 0)
  return controlFrame(0x8, payload)
}
