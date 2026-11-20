# Google spike ([#36](https://github.com/kylegothman/doe-oracle-instrumentation/issues/36))

What was learned about driving Google Search from Playwright's Chromium before the Google adapter (E5) was built, and how it maps onto the harness settings and story requirements (Traces to UC-3, AD-3). The last section lists what the adapter relies on that has not been checked against the live site.

## Setup

Playwright 1.65 with Chrome for Testing 158, headed, on a throw-away profile folder (deleted afterwards), macOS/Windows, 2026-11-15. No stealth plugin, no user-agent or fingerprint spoofing, no cookie or token handling, and navigator.webdriver left at Playwright's default of true. Per Architecture Decision AD-3, the harness fills the exact question into the input, but the Tester presses Enter manually.

## Signed-out context and navigation

- **Separate context.** Google opens in its own browser context of the shared Chromium (`BrowserManager.getPage(Subject.GOOGLE)`), apart from the Oracle's and from Copilot's profile. It has no profile folder and nothing is ever signed in, so personal search history, account cookies, and personalised rankings do not reach the results.
- **Per launch, not per trial.** The context lasts until the harness quits. Cookies Google sets carry from one Google trial to the next within a launch; nothing is kept on disk, and a relaunch starts with none. The spike used a profile folder, but the harness does not: there is no `browser-profiles/google`.
- **Direct navigation.** Loading https://www.google.com directly succeeded cleanly in a fresh context.
- **Bot detection.** Submitting queries by automation triggered Google's checks (the "unusual traffic" page with a CAPTCHA). The harness applies no stealth plugin and no fingerprint spoofing, never submits a search itself, and never tries to pass the check. When the check shows, the Tester is told and solves it by hand or cancels (README, "Unusual traffic").

## Selectors

In `google` in `src/shared/harness-config.json`. All plain CSS.

| Setting | Value | What it is |
| --- | --- | --- |
| `selectors.input` | `textarea[name="q"], [role="combobox"][aria-label="Search"]` | the search box on the home page; the first match is used |
| `selectors.resultContainers` | `#rso`, then `#search` | the results list; the first one present is read |
| `selectors.resultTitle` | `a[href] h3` | a result's title; the link around it is the result's URL |
| `selectors.aiOverviewHeading` with `aiOverviewLabels` | `h1, h2, [role="heading"]` with the text "AI Overview" | the AI overview's heading; its block is cut before the results are read |
| `selectors.aiOverview` | empty | a known AI overview container, for when the heading is not enough |
| `resultsPath`, `queryParam` | `/search`, `q` | how a submitted search is recognised: a main-frame navigation to this path carrying the question |
| `challengePath` | `/sorry/` | the "unusual traffic" page |

The spike also noted `input[name="btnK"]` (the Google Search button), `div.g` (one result), and `[data-attrid="title"]` (the knowledge panel). The adapter uses none of them: it never clicks the button, and it finds results by their title links because Google's class names change.

## Submit signal and timing

All three marks come from the browser's events for the page's main frame, stamped in the main process as Playwright reports them.

- **Begin:** the navigation request to `/search?q=…` leaves the page. That is the Tester's Enter sending the search; typing the question and anything else before it is not timed. The harness waits for it for `submitWaitMs` (5 minutes) and then aborts the trial unsaved.
- **First response:** the response to that request arrives.
- **End, page load:** the results page fires its load event. Unlike Copilot's streamed answer, there is nothing to watch after that: Enter to the load event is the page-load time.

The results container appearing is not used as a signal. A load event that fires before the search's response belongs to the home page and does not count.

## Decisions

- The search URL, paths, selectors, and limits are configuration, keeping the adapter uniform with E4.
- One signed-out context per launch, shared by that launch's Google trials. A context per trial would start every search with no cookies, at the price of more consent screens and checks; it was not needed for the stories.
- Time to answer is measured in the harness: from begin to the Tester's Answer Found reaching the main process. The Tester has `answerFoundTimeoutMs` (120 seconds) from the results loading, after which the trial is saved as no answer found.
- Answer Found saves the passage the Tester highlighted and the link of the result it came from. The AI overview is never saved.
- A highlight inside a PDF cannot be read: Chromium's PDF viewer gives the page an empty selection (practice run of 2026-11-20, issue #76, where two trials on a NIST PDF were saved as `EMPTY_ANSWER`). Answer Found on such a page saves nothing and asks the Tester to copy the highlighted text and click Use Copied Text; the harness reads the clipboard, shows the text, and saves it once the Tester confirms, with the time to answer of the Answer Found click. See "When the highlight cannot be read" in the README.

## Not yet checked against the live site

The adapter's tests run against saved pages in `src/main/adapters/__fixtures__`, written from the structure above. No automated test contacts Google, and the harness never submits a search, so these need a person's trial to confirm:

- that `selectors.input` matches the live search box;
- that the live results list is `#rso`, and that results there carry their titles as `a[href] h3`;
- that the live AI overview sits under a heading reading "AI Overview", so the heading rule cuts it. If it does not, set `selectors.aiOverview` to its container;
- that the "unusual traffic" page is served under `/sorry/`.
