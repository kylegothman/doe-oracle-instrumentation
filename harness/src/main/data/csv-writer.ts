import { writeFile } from 'node:fs/promises'
import type { SupplementaryRow, TestLogRow } from './export-rows'
import {
  SUPPLEMENTARY_HEADERS,
  supplementaryCells,
  TESTLOG_V3_HEADERS,
  testLogCells,
  type LogWriter,
} from './log-writer'

/** UTF-8 byte order mark: tells Excel the file is UTF-8, so characters like "·" and "é" open correctly. */
const BOM = '﻿'
/** RFC 4180 line ending, which Excel expects. */
const EOL = '\r\n'

/**
 * Writes the export as CSV (UC-6): the 11 TestLogV3 columns, in the same
 * order and with the same headers as the workbook, to the chosen file, and
 * the supplementary columns to <name>-supplementary.csv beside it. Fields
 * are quoted per RFC 4180 when they hold a comma, a quote, or a line break,
 * so long multi-line answers stay in one field. Empty values are empty
 * fields. The header row is the first line: a CSV has no cells to offset.
 */
export class CsvWriter implements LogWriter {
  async write(main: readonly TestLogRow[], extra: readonly SupplementaryRow[], filePath: string): Promise<string[]> {
    const supplementaryPath = supplementaryPathFor(filePath)
    await writeFile(filePath, toCsv(TESTLOG_V3_HEADERS, main.map(testLogCsvCells)), 'utf8')
    await writeFile(supplementaryPath, toCsv(SUPPLEMENTARY_HEADERS, extra.map(supplementaryCells)), 'utf8')
    return [filePath, supplementaryPath]
  }
}

/** report.csv → report-supplementary.csv; a name without .csv just gets the suffix and the extension. */
export function supplementaryPathFor(filePath: string): string {
  const base = filePath.replace(/\.csv$/i, '')
  return `${base}-supplementary.csv`
}

/** Like the workbook's cells, but Size Kbytes always shows its 2 decimals, as the workbook's number format does. */
function testLogCsvCells(row: TestLogRow): Array<string | number | null> {
  const cells = testLogCells(row)
  cells[TESTLOG_V3_HEADERS.indexOf('Size Kbytes')] = row.sizeKb.toFixed(2)
  return cells
}

function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const lines = [headers, ...rows].map((cells) => cells.map(field).join(','))
  return BOM + lines.join(EOL) + EOL
}

/** One CSV field: empty for null, quoted (with quotes doubled) when it holds a comma, quote, or line break. */
export function field(value: string | number | null): string {
  if (value === null) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
