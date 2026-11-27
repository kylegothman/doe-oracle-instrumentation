/**
 * Works out the two NFR-2 results (story #47) from what the Tester recorded:
 *
 * - TC-NFR2-01, timing overhead: for each Oracle trial, the difference
 *   between the harness's time from begin to first response and the duration
 *   Chromium's developer tools showed for the same POST to /api/search. The
 *   median of the differences, taken without sign, must be 50 ms or less.
 * - TC-NFR2-02, CPU use: the average CPU use of the harness's own processes,
 *   from scripts/log-cpu.ps1, over the samples taken during those trials.
 *   It must be 10% of the machine or less. The subject's browser and Ollama
 *   are shown beside it and not counted.
 *
 * Usage, from the harness folder:
 *
 *   node scripts/nfr2-report.mjs --log TestLog.csv --devtools devtools.csv [--cpu cpu-log.csv]
 *
 * --log       the session exported as CSV; its -supplementary.csv must be beside it
 * --devtools  a CSV with the columns "Test #" and "DevTools ms", one row per trial
 * --cpu       the file scripts/log-cpu.ps1 wrote during the trials (optional)
 *
 * It prints Markdown tables ready for the Test Plan, and exits with 1 when a
 * result fails or a trial cannot be compared.
 */
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const OVERHEAD_LIMIT_MS = 50
export const CPU_LIMIT_PCT = 10
const CPU_GROUPS = ['harness', 'browser', 'ollama']

/** Parses RFC 4180 CSV, as the harness and Excel write it: quoted fields may hold commas, quotes, and line breaks. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  // The harness writes a byte order mark so that Excel reads UTF-8.
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}

/** CSV rows as objects keyed by the header, with the header's spaces trimmed ("Question Number " becomes "Question Number"). */
export function toRecords(rows) {
  if (rows.length === 0) return []
  const header = rows[0].map((cell) => cell.trim())
  return rows.slice(1).map((cells) => Object.fromEntries(header.map((name, index) => [name, (cells[index] ?? '').trim()])))
}

/** The number in a cell, or null when it is empty or not a number. */
function toNumber(cell) {
  if (cell === undefined || cell.trim() === '') return null
  const value = Number(cell.trim())
  return Number.isFinite(value) ? value : null
}

export function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * The trials in an export, by Test #: subject, question, begin and end, and
 * the time from begin to first response from the supplementary file.
 */
export function readTrials(logRecords, supplementaryRecords) {
  const firstResponse = new Map(
    supplementaryRecords.map((record) => [toNumber(record['Test #']), toNumber(record['Time to First Response Milliseconds'])]),
  )
  const trials = new Map()
  for (const record of logRecords) {
    const testNumber = toNumber(record['Test #'])
    if (testNumber === null) continue
    trials.set(testNumber, {
      testNumber,
      subject: record['Test Subject'],
      question: toNumber(record['Question Number']),
      beginTs: record['Begin Timestamp'] || null,
      endTs: record['End Timestamp'] || null,
      firstResponseMs: firstResponse.get(testNumber) ?? null,
    })
  }
  return trials
}

/** What the Tester wrote down from the developer tools: Test # to milliseconds. */
export function readDevtools(records) {
  const durations = new Map()
  for (const record of records) {
    const testNumber = toNumber(record['Test #'])
    const ms = toNumber(record['DevTools ms'])
    if (testNumber !== null && ms !== null) durations.set(testNumber, ms)
  }
  return durations
}

/**
 * TC-NFR2-01. One row per trial in the DevTools file. A trial that is not in
 * the export, is not an Oracle trial, or has no first-response time cannot
 * be compared and is listed as a problem.
 */
export function compareTimings(trials, devtools) {
  const rows = []
  const problems = []
  for (const [testNumber, devtoolsMs] of devtools) {
    const trial = trials.get(testNumber)
    if (!trial) {
      problems.push(`Test #${testNumber} is not in the export.`)
    } else if (trial.subject !== 'DOE Oracle') {
      problems.push(`Test #${testNumber} is a ${trial.subject} trial, not a DOE Oracle trial.`)
    } else if (trial.firstResponseMs === null) {
      problems.push(`Test #${testNumber} has no time to first response. Did it fail?`)
    } else {
      rows.push({ ...trial, devtoolsMs, differenceMs: Math.abs(trial.firstResponseMs - devtoolsMs) })
    }
  }
  const medianMs = median(rows.map((row) => row.differenceMs))
  return { rows, problems, medianMs, pass: medianMs !== null && problems.length === 0 && medianMs <= OVERHEAD_LIMIT_MS }
}

/** The CPU log's samples: when each was taken (ms since 1970) and each group's share of the machine. */
export function readCpuSamples(records) {
  return records
    .map((record) => ({
      at: Date.parse(record.timestamp_utc),
      ...Object.fromEntries(CPU_GROUPS.map((group) => [group, toNumber(record[`${group}_pct`])])),
    }))
    .filter((sample) => Number.isFinite(sample.at))
}

/**
 * TC-NFR2-02. A sample covers the interval before its timestamp, so it is
 * counted when that interval overlaps a trial, from begin to end. Each group
 * is averaged over those samples.
 */
export function averageCpu(samples, trials, intervalMs = 1000) {
  const windows = trials
    .filter((trial) => trial.beginTs && trial.endTs)
    .map((trial) => [Date.parse(trial.beginTs), Date.parse(trial.endTs)])
  const during = samples.filter((sample) => windows.some(([begin, end]) => sample.at > begin && sample.at - intervalMs < end))
  const averages = Object.fromEntries(
    CPU_GROUPS.map((group) => {
      const values = during.map((sample) => sample[group]).filter((value) => value !== null)
      return [group, values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null]
    }),
  )
  return { samples: during.length, ...averages, pass: averages.harness !== null && averages.harness <= CPU_LIMIT_PCT }
}

function readCsvFile(path) {
  if (!existsSync(path)) throw new Error(`${path} does not exist.`)
  return toRecords(parseCsv(readFileSync(path, 'utf8')))
}

function round(value, digits = 1) {
  return value === null ? 'n/a' : value.toFixed(digits)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    if (!['--log', '--devtools', '--cpu'].includes(name) || argv[i + 1] === undefined) {
      throw new Error(`Unexpected argument ${name}. Usage: node scripts/nfr2-report.mjs --log TestLog.csv --devtools devtools.csv [--cpu cpu-log.csv]`)
    }
    args[name.slice(2)] = argv[i + 1]
  }
  if (!args.log || !args.devtools) throw new Error('--log and --devtools are required.')
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const supplementaryPath = args.log.replace(/\.csv$/i, '') + '-supplementary.csv'
  const trials = readTrials(readCsvFile(args.log), readCsvFile(supplementaryPath))
  const timing = compareTimings(trials, readDevtools(readCsvFile(args.devtools)))

  const out = []
  out.push('## TC-NFR2-01, timing overhead', '')
  out.push('| Test # | Question | Harness, begin to first response (ms) | DevTools, POST /api/search (ms) | Difference (ms) |')
  out.push('| --- | --- | --- | --- | --- |')
  for (const row of timing.rows) {
    out.push(`| ${row.testNumber} | ${row.question} | ${row.firstResponseMs} | ${row.devtoolsMs} | ${row.differenceMs} |`)
  }
  out.push('')
  out.push(`Median difference, without sign: ${round(timing.medianMs)} ms over ${timing.rows.length} trials (limit ${OVERHEAD_LIMIT_MS} ms): ${timing.pass ? 'PASS' : 'FAIL'}`)
  for (const problem of timing.problems) out.push(`- ${problem}`)

  let pass = timing.pass
  if (args.cpu) {
    const cpu = averageCpu(readCpuSamples(readCsvFile(args.cpu)), timing.rows)
    out.push('', '## TC-NFR2-02, CPU use during the trials', '')
    out.push('| Processes | Average share of the machine (%) | Counted |')
    out.push('| --- | --- | --- |')
    out.push(`| Harness | ${round(cpu.harness)} | yes |`)
    out.push(`| Subject's browser | ${round(cpu.browser)} | no |`)
    out.push(`| Ollama | ${round(cpu.ollama)} | no |`)
    out.push('')
    out.push(`Harness average over ${cpu.samples} one-second samples (limit ${CPU_LIMIT_PCT}%): ${cpu.pass ? 'PASS' : 'FAIL'}`)
    if (cpu.samples === 0) out.push('- No CPU sample falls inside a trial. Was the logger running during the trials, on the same machine?')
    pass = pass && cpu.pass
  }
  console.log(out.join('\n'))
  process.exitCode = pass ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`nfr2-report: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
