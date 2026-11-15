import ExcelJS from 'exceljs'
import type { SupplementaryRow, TestLogRow } from './export-rows'
import {
  SUPPLEMENTARY_HEADERS,
  supplementaryCells,
  TESTLOG_V3_HEADERS,
  testLogCells,
  type LogWriter,
} from './log-writer'

/** Tom's file names its only sheet "Sheet1"; the TestLogV3 sheet keeps that name. */
export const TESTLOG_SHEET_NAME = 'Sheet1'
export const SUPPLEMENTARY_SHEET_NAME = 'Supplementary'

/**
 * Tom's layout starts at B2: row 1 and column A are empty, the headers are
 * in row 2 from column B, and data starts in row 3. Both sheets use it.
 */
export const HEADER_ROW = 2
export const FIRST_COLUMN = 2

/** Column widths in characters, by header, so the sheet is readable on opening. */
const WIDTHS: Record<string, number> = {
  'Answer Text': 80,
  'log data set name': 24,
  'User Email': 38,
  'Begin Timestamp': 26,
  'End Timestamp': 26,
  'Source URL': 50,
  Citations: 60,
  'Time to First Response Milliseconds': 20,
  'Page Load Milliseconds': 14,
  'Time to Answer Milliseconds': 16,
}

/**
 * Writes the TestLogV3 workbook with ExcelJS (UC-6, NFR-8): the 11 columns
 * on the first sheet, exactly in Tom's layout, and the supplementary
 * columns on a second sheet. Empty values leave the cell empty, not 0 or "".
 */
export class TestLogV3Writer implements LogWriter {
  async write(main: readonly TestLogRow[], extra: readonly SupplementaryRow[], filePath: string): Promise<string[]> {
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'DOE Oracle Test Harness'

    const testLog = workbook.addWorksheet(TESTLOG_SHEET_NAME)
    writeTable(testLog, TESTLOG_V3_HEADERS, main.map(testLogCells))
    // Size Kbytes always shows its 2 decimals.
    testLog.getColumn(FIRST_COLUMN + TESTLOG_V3_HEADERS.indexOf('Size Kbytes')).numFmt = '0.00'

    const supplementary = workbook.addWorksheet(SUPPLEMENTARY_SHEET_NAME)
    writeTable(supplementary, SUPPLEMENTARY_HEADERS, extra.map(supplementaryCells))

    await workbook.xlsx.writeFile(filePath)
    return [filePath]
  }
}

function writeTable(
  sheet: ExcelJS.Worksheet,
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
): void {
  headers.forEach((header, index) => {
    const column = FIRST_COLUMN + index
    sheet.getRow(HEADER_ROW).getCell(column).value = header
    sheet.getColumn(column).width = WIDTHS[header.trim()] ?? Math.max(12, header.length + 2)
  })
  rows.forEach((cells, rowIndex) => {
    const row = sheet.getRow(HEADER_ROW + 1 + rowIndex)
    cells.forEach((value, index) => {
      if (value !== null) row.getCell(FIRST_COLUMN + index).value = value
    })
  })
}
