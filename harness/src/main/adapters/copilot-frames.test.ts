import { describe, expect, it } from 'vitest'
import { isChatRequestFrame, parseSignalRRecords } from './copilot-frames'

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
