import ExcelJS from 'exceljs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResponseSource } from '../../shared/experts'
import { FailureType } from '../../shared/failures'
import type { SupplementaryRow, TestLogRow } from './export-rows'
import { SUPPLEMENTARY_HEADERS, TESTLOG_V3_HEADERS } from './log-writer'
import { SUPPLEMENTARY_SHEET_NAME, TESTLOG_SHEET_NAME, TestLogV3Writer } from './testlog-v3-writer'

/** The headers in Tom's TestLogV3.xlsx, cell B2 to L2, written out by hand so a typo in the code cannot hide. */
const TOMS_HEADERS = [
  'Test #',
  'Question Number ',
  'Test Subject ',
  'log data set name',
  'Answer Text',
  'Response Milliseconds',
  'User Email',
  'Begin Timestamp',
  'End Timestamp',
  'Keywords',
  'Size Kbytes',
]

const oracleRow: TestLogRow = {
  testNumber: 1,
  questionNumber: 1,
  testSubject: 'DOE Oracle',
  dataSetName: 'DOE_ORACLE-2026-11-14',
  answerText: 'Combinatorial testing covers t-way interactions.\nIt finds faults caused by a few factors together.',
  responseMs: 22_383,
  userEmail: '9f1e3a04-efd5-448f-b8d0-17fad7336726',
  beginTs: '2026-11-14T11:00:00.000Z',
  endTs: '2026-11-14T11:00:22.383Z',
  keywords: null,
  sizeKb: 1.5,
}

const expertRow: TestLogRow = {
  testNumber: 2,
  questionNumber: 2,
  testSubject: 'Expert',
  dataSetName: 'EXPERT-2026-11-03',
  answerText: 'Combinatorial Testing (CT) is based on combinatorics.',
  responseMs: null,
  userEmail: '9f1e3a04-efd5-448f-b8d0-17fad7336726',
  beginTs: null,
  endTs: null,
  keywords: null,
  sizeKb: 0.05,
}

const extraRows: SupplementaryRow[] = [
  {
    testNumber: 1,
    firstResponseMs: 22_347,
    pageLoadMs: null,
    timeToAnswerMs: null,
    sourceUrl: null,
    citations: 'paper-a.pdf · p.3; paper-b.pdf · p.12',
    failureType: FailureType.TIMEOUT,
    responseSource: null,
  },
  {
    testNumber: 2,
    firstResponseMs: null,
    pageLoadMs: null,
    timeToAnswerMs: null,
    sourceUrl: null,
    citations: null,
    failureType: null,
    responseSource: ResponseSource.EMAIL,
  },
]

describe('TestLogV3Writer', () => {
  let dir: string
  let filePath: string

  const read = async (): Promise<ExcelJS.Workbook> => {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    return workbook
  }
  const rowValues = (sheet: ExcelJS.Worksheet, row: number, from: number, count: number): unknown[] =>
    Array.from({ length: count }, (_, i) => sheet.getRow(row).getCell(from + i).value)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-testlog-'))
    filePath = join(dir, 'TestLog.xlsx')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("uses Tom's exact headers, trailing spaces included", () => {
    expect([...TESTLOG_V3_HEADERS]).toEqual(TOMS_HEADERS)
  })

  it('returns the one file it wrote', async () => {
    await expect(new TestLogV3Writer().write([oracleRow], extraRows.slice(0, 1), filePath)).resolves.toEqual([filePath])
  })

  it("puts the headers in B2:L2 like Tom's file, with row 1 and column A empty", async () => {
    await new TestLogV3Writer().write([oracleRow], extraRows.slice(0, 1), filePath)

    const sheet = (await read()).getWorksheet(TESTLOG_SHEET_NAME)
    expect(sheet).toBeDefined()
    if (!sheet) return
    expect(rowValues(sheet, 2, 2, 11)).toEqual(TOMS_HEADERS)
    expect(rowValues(sheet, 1, 1, 12).every((value) => value === null)).toBe(true)
    expect([1, 2, 3].map((row) => sheet.getRow(row).getCell(1).value)).toEqual([null, null, null])
    expect(sheet.getRow(2).getCell(13).value).toBeNull()
  })

  it('writes each row from row 3 in column order, keeping numbers as numbers and multi-line answers intact', async () => {
    await new TestLogV3Writer().write([oracleRow, expertRow], extraRows, filePath)

    const sheet = (await read()).getWorksheet(TESTLOG_SHEET_NAME)
    if (!sheet) throw new Error('missing sheet')
    expect(rowValues(sheet, 3, 2, 11)).toEqual([
      1,
      1,
      'DOE Oracle',
      'DOE_ORACLE-2026-11-14',
      'Combinatorial testing covers t-way interactions.\nIt finds faults caused by a few factors together.',
      22_383,
      '9f1e3a04-efd5-448f-b8d0-17fad7336726',
      '2026-11-14T11:00:00.000Z',
      '2026-11-14T11:00:22.383Z',
      null,
      1.5,
    ])
    expect(sheet.getRow(4).getCell(2).value).toBe(2)
    expect(sheet.getRow(5).getCell(2).value).toBeNull()
  })

  it('leaves empty values as empty cells, not 0 or ""', async () => {
    await new TestLogV3Writer().write([expertRow], extraRows.slice(1), filePath)

    const sheet = (await read()).getWorksheet(TESTLOG_SHEET_NAME)
    if (!sheet) throw new Error('missing sheet')
    // Response Milliseconds, Begin, End, Keywords: columns G, I, J, K.
    expect([7, 9, 10, 11].map((column) => sheet.getRow(3).getCell(column).value)).toEqual([null, null, null, null])
  })

  it('shows Size Kbytes with 2 decimals', async () => {
    await new TestLogV3Writer().write([oracleRow], extraRows.slice(0, 1), filePath)

    const sheet = (await read()).getWorksheet(TESTLOG_SHEET_NAME)
    expect(sheet?.getRow(3).getCell(12).numFmt).toBe('0.00')
  })

  it('writes the supplementary rows on a second sheet in the same B2 layout', async () => {
    await new TestLogV3Writer().write([oracleRow, expertRow], extraRows, filePath)

    const workbook = await read()
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([TESTLOG_SHEET_NAME, SUPPLEMENTARY_SHEET_NAME])
    const sheet = workbook.getWorksheet(SUPPLEMENTARY_SHEET_NAME)
    if (!sheet) throw new Error('missing sheet')
    expect(rowValues(sheet, 2, 2, 8)).toEqual([...SUPPLEMENTARY_HEADERS])
    expect(rowValues(sheet, 3, 2, 8)).toEqual([1, 22_347, null, null, null, 'paper-a.pdf · p.3; paper-b.pdf · p.12', 'TIMEOUT', null])
    expect(rowValues(sheet, 4, 2, 8)).toEqual([2, null, null, null, null, null, null, 'EMAIL'])
  })

  it('writes a workbook with only the headers when there are no rows', async () => {
    await new TestLogV3Writer().write([], [], filePath)

    const sheet = (await read()).getWorksheet(TESTLOG_SHEET_NAME)
    if (!sheet) throw new Error('missing sheet')
    expect(rowValues(sheet, 2, 2, 11)).toEqual(TOMS_HEADERS)
    expect(sheet.getRow(3).getCell(2).value).toBeNull()
  })

  it('fails when the file cannot be written', async () => {
    await expect(new TestLogV3Writer().write([oracleRow], [], join(dir, 'missing-folder', 'TestLog.xlsx'))).rejects.toThrow()
  })
})
