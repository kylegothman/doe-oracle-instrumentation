import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResponseSource } from '../../shared/experts'
import { FailureType } from '../../shared/failures'
import { CsvWriter, field, supplementaryPathFor } from './csv-writer'
import type { SupplementaryRow, TestLogRow } from './export-rows'

const row: TestLogRow = {
  testNumber: 1,
  questionNumber: 1,
  testSubject: 'DOE Oracle',
  dataSetName: 'DOE_ORACLE-2026-11-14',
  answerText: 'Combinatorial testing covers t-way interactions.',
  responseMs: 22_383,
  userEmail: '9f1e3a04-efd5-448f-b8d0-17fad7336726',
  beginTs: '2026-11-14T11:00:00.000Z',
  endTs: '2026-11-14T11:00:22.383Z',
  keywords: null,
  sizeKb: 1.5,
}

const extra: SupplementaryRow = {
  testNumber: 1,
  firstResponseMs: 22_347,
  pageLoadMs: null,
  timeToAnswerMs: null,
  sourceUrl: null,
  citations: 'paper-a.pdf · p.3; paper-b.pdf · p.12',
  failureType: FailureType.TIMEOUT,
  responseSource: null,
}

/** A minimal RFC 4180 reader, so the tests check what a CSV reader gets back, not just the raw text. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let rowCells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      rowCells.push(cell)
      cell = ''
    } else if (char === '\r' && text[i + 1] === '\n') {
      rowCells.push(cell)
      rows.push(rowCells)
      rowCells = []
      cell = ''
      i++
    } else {
      cell += char
    }
  }
  return rows
}

describe('field', () => {
  it('leaves plain values alone and empties null', () => {
    expect(field('DOE Oracle')).toBe('DOE Oracle')
    expect(field(22_383)).toBe('22383')
    expect(field(null)).toBe('')
  })

  it('quotes values with a comma, a quote, or a line break, doubling the quotes', () => {
    expect(field('a, b')).toBe('"a, b"')
    expect(field('say "hi"')).toBe('"say ""hi"""')
    expect(field('line 1\nline 2')).toBe('"line 1\nline 2"')
    expect(field('line 1\r\nline 2')).toBe('"line 1\r\nline 2"')
  })
})

describe('supplementaryPathFor', () => {
  it('puts -supplementary before the extension, whatever its case, or adds one', () => {
    expect(supplementaryPathFor('C:\\Exports\\TestLog-2026-11-14.csv')).toBe('C:\\Exports\\TestLog-2026-11-14-supplementary.csv')
    expect(supplementaryPathFor('C:\\Exports\\Log.CSV')).toBe('C:\\Exports\\Log-supplementary.csv')
    expect(supplementaryPathFor('C:\\Exports\\Log')).toBe('C:\\Exports\\Log-supplementary.csv')
  })
})

describe('CsvWriter', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-csv-'))
    filePath = join(dir, 'TestLog.csv')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the main file and the supplementary file beside it, and returns both paths', async () => {
    const written = await new CsvWriter().write([row], [extra], filePath)

    expect(written).toEqual([filePath, join(dir, 'TestLog-supplementary.csv')])
    expect(written.every((path) => existsSync(path))).toBe(true)
  })

  it("starts with a UTF-8 byte order mark and Tom's 11 headers, trailing spaces included, and ends lines with CRLF", async () => {
    await new CsvWriter().write([row], [extra], filePath)

    const text = readFileSync(filePath, 'utf8')
    expect(text.startsWith('\uFEFFTest #,Question Number ,Test Subject ,log data set name,Answer Text,')).toBe(true)
    expect(text.split('\r\n')[0]).toBe(
      '\uFEFFTest #,Question Number ,Test Subject ,log data set name,Answer Text,Response Milliseconds,User Email,Begin Timestamp,End Timestamp,Keywords,Size Kbytes',
    )
    expect(text.endsWith('\r\n')).toBe(true)
  })

  it('writes each row in column order, with empty fields for empty values and Size Kbytes to 2 decimals', async () => {
    await new CsvWriter().write([row], [extra], filePath)

    const [, first] = parseCsv(readFileSync(filePath, 'utf8'))
    expect(first).toEqual([
      '1',
      '1',
      'DOE Oracle',
      'DOE_ORACLE-2026-11-14',
      'Combinatorial testing covers t-way interactions.',
      '22383',
      '9f1e3a04-efd5-448f-b8d0-17fad7336726',
      '2026-11-14T11:00:00.000Z',
      '2026-11-14T11:00:22.383Z',
      '',
      '1.50',
    ])
  })

  it('keeps a long multi-line answer with commas and quotes in one field', async () => {
    const answer = 'Combinatorial testing, or CT, covers "t-way" interactions:\n- pairwise\r\n- 3-way\n\nIt finds faults.'

    await new CsvWriter().write([{ ...row, answerText: answer }], [extra], filePath)

    const rows = parseCsv(readFileSync(filePath, 'utf8'))
    expect(rows).toHaveLength(2)
    expect(rows[1]?.[4]).toBe(answer)
    expect(rows[1]).toHaveLength(11)
  })

  it('writes the supplementary columns, keyed by Test #, with characters like "·" intact', async () => {
    const expertExtra: SupplementaryRow = { ...extra, testNumber: 2, firstResponseMs: null, citations: null, failureType: null, responseSource: ResponseSource.EMAIL }

    await new CsvWriter().write([row], [extra, expertExtra], filePath)

    const rows = parseCsv(readFileSync(join(dir, 'TestLog-supplementary.csv'), 'utf8').replace(/^\uFEFF/, ''))
    expect(rows).toEqual([
      [
        'Test #',
        'Time to First Response Milliseconds',
        'Page Load Milliseconds',
        'Time to Answer Milliseconds',
        'Source URL',
        'Citations',
        'Failure Type',
        'Response Source',
      ],
      ['1', '22347', '', '', '', 'paper-a.pdf · p.3; paper-b.pdf · p.12', 'TIMEOUT', ''],
      ['2', '', '', '', '', '', '', 'EMAIL'],
    ])
  })

  it('writes only the headers when there are no rows', async () => {
    await new CsvWriter().write([], [], filePath)

    expect(parseCsv(readFileSync(filePath, 'utf8'))).toHaveLength(1)
  })

  it('fails when the file cannot be written', async () => {
    await expect(new CsvWriter().write([row], [extra], join(dir, 'missing-folder', 'TestLog.csv'))).rejects.toThrow()
  })
})
