import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadSettings } from '../config/settings'
import { readAnswer } from './copilot-adapter'

const FIXTURE_HTML = readFileSync(fileURLToPath(new URL('./__fixtures__/copilot-math-replies.html', import.meta.url)), 'utf8')
const { selectors } = loadSettings({}).copilot
const BROWSER_TEST_TIMEOUT_MS = 30_000

/** The replies in the fixture, by position; see the comment at its top. */
const REAL_QUESTION_9 = 0
const NO_MATH = 1
const MATH_BY_CITATIONS = 2
const NO_TEX_SOURCE = 3

/**
 * How the adapter reads an answer's text when Copilot has rendered math in
 * it (issue #76). The fixture is a real question 9 reply, with the few KaTeX
 * style rules that make the page's own text come out garbled.
 */
describe('readAnswer on Copilot replies with math', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch()
    page = await browser.newPage()
    await page.setContent(FIXTURE_HTML)
  }, BROWSER_TEST_TIMEOUT_MS)

  afterAll(async () => {
    await browser?.close()
  })

  function read(reply: number): Promise<{ text: string; citationTitles: string[] }> {
    return page.evaluate(readAnswer, {
      reply: selectors.reply,
      botMessage: selectors.botMessage,
      citation: selectors.citation,
      repliesBefore: reply,
      botMessagesBefore: reply,
    })
  }

  /** The reply's text as the adapter read it before math was handled: the same clone, citations out, innerText. */
  function readAsBefore(reply: number): Promise<string> {
    return page.evaluate(
      ({ selector, citation, index }) => {
        const node = document.querySelectorAll(selector)[index] as HTMLElement
        const clone = node.cloneNode(true) as HTMLElement
        clone.querySelectorAll(citation).forEach((button) => button.remove())
        clone.style.position = 'absolute'
        clone.style.left = '-99999px'
        clone.style.width = `${Math.max(node.clientWidth, 320)}px`
        document.body.append(clone)
        try {
          return clone.innerText.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim()
        } finally {
          clone.remove()
        }
      },
      { selector: selectors.reply, citation: selectors.citation, index: reply },
    )
  }

  it(
    'reproduces the practice run: read as before, the expression is stacked one symbol per line and repeated',
    async () => {
      const before = await readAsBefore(REAL_QUESTION_9)

      // What test #49 saved where the page showed 3^4 = 81.
      expect(before).toContain('3\n4\n=\n81\n3\n4\n=81')
      expect(before).not.toContain('3^4 = 81')
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'puts display math on one line of its own, once, as its TeX source',
    async () => {
      const { text } = await read(REAL_QUESTION_9)

      expect(text).toContain('Number of exhaustive test cases:\n\n3^4 = 81\n\nSo, exhaustive testing requires 81 tests.')
      expect(text).toContain('Reduction\n\\frac{81 - 9}{81} \\times 100 \\approx 88.9\\%\n\nSo pairwise testing reduces')
      expect(text.match(/3\^4 = 81/g)).toHaveLength(1)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'keeps inline math in its sentence, once, as its TeX source',
    async () => {
      const { text } = await read(REAL_QUESTION_9)

      expect(text).toContain(
        [
          'There are \\binom{4}{2} = 6 parameter pairs.',
          'Each parameter pair has 3 \\times 3 = 9 value combinations.',
          'Pairwise testing combines many of these pairs into the same test cases, so you do not need 6 \\times 9 = 54 tests.',
        ].join('\n'),
      )
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reads the whole question 9 reply with nothing stacked or repeated, and the text around the math as before',
    async () => {
      const { text } = await read(REAL_QUESTION_9)

      expect(text).toBe(
        [
          'For exhaustive testing, you test every possible combination of parameter values.',
          '',
          '4 parameters',
          '3 values per parameter',
          '',
          'Number of exhaustive test cases:',
          '',
          '3^4 = 81',
          '',
          'So, exhaustive testing requires 81 tests.',
          '',
          'For pairwise testing, the goal is to cover every possible pair of values between every pair of parameters at least once.',
          '',
          'There are \\binom{4}{2} = 6 parameter pairs.',
          'Each parameter pair has 3 \\times 3 = 9 value combinations.',
          'Pairwise testing combines many of these pairs into the same test cases, so you do not need 6 \\times 9 = 54 tests.',
          '',
          'For a system with 4 parameters and 3 values each, a pairwise test set can be covered in 9 tests.',
          '',
          'Comparison',
          'Method\tNumber of Tests',
          'Exhaustive Testing\t81',
          'Pairwise Testing\t9',
          'Reduction',
          '\\frac{81 - 9}{81} \\times 100 \\approx 88.9\\%',
          '',
          'So pairwise testing reduces the test suite from 81 tests to about 9 tests, an 89% reduction, while still covering all possible pairs of parameter values. This illustrates why combinatorial testing is often much more cost-effective than exhaustive testing.',
        ].join('\n'),
      )
      // No line holds a lone symbol, and no zero-width character from KaTeX's layout is left.
      expect(text).not.toMatch(/\n[\d=×−≈%()]\n/)
      expect(text).not.toMatch(/[\u200B-\u200D\uFEFF]/)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reads a reply with no math exactly as before',
    async () => {
      const { text, citationTitles } = await read(NO_MATH)

      expect(text).toBe(await readAsBefore(NO_MATH))
      // Text that only looks like math is text: it is not rewritten.
      expect(text).toContain('It needs far fewer tests than 3^4 = 81 exhaustive ones.')
      expect(text).toContain('Prices such as $5 and $10 are not math, and neither is a_b or x^2 written out.')
      expect(text).toContain('Method\tNumber of Tests\nExhaustive Testing\t81')
      expect(citationTitles).toEqual([])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'reads math next to a citation button without the button, and still lists the citation',
    async () => {
      const { text, citationTitles } = await read(MATH_BY_CITATIONS)

      expect(text).toBe(
        [
          'Each parameter pair has 3 \\times 3 = 9 value combinations.',
          '',
          'The exhaustive count is:',
          '',
          '3^4 = 81',
          '',
          'That is the figure most sources give.',
        ].join('\n'),
      )
      expect(citationTitles).toEqual(['Combinatorial Testing | NIST', 'All-pairs testing'])
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'keeps one readable copy, on one line, when the markup carries no TeX source',
    async () => {
      const { text } = await read(NO_TEX_SOURCE)

      expect(text).toBe('Six pairs of nine give 6×9=54 combinations, and 81−9=72 tests are saved.')
    },
    BROWSER_TEST_TIMEOUT_MS,
  )

  it(
    'leaves the page itself as it was: only the copy that is read is changed',
    async () => {
      const mathBefore = await page.locator('.katex').count()
      await read(REAL_QUESTION_9)

      expect(await page.locator('.katex').count()).toBe(mathBefore)
      expect(mathBefore).toBeGreaterThan(0)
    },
    BROWSER_TEST_TIMEOUT_MS,
  )
})
