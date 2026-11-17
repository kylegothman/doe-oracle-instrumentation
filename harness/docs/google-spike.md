# Google spike ([#36](https://github.com/kylegothman/doe-oracle-instrumentation/issues/36))

What was learned about driving Google Search from Playwright's Chromium before the Google adapter (E5) was built, and how it maps onto the harness settings and story requirements (Traces to UC-3, AD-3).

## Setup

Playwright 1.65 with Chrome for Testing 158, headed, chromium.launchPersistentContext on a throw-away profile folder (deleted afterwards), macOS/Windows, 2026-11-15. No stealth plugin, no user-agent or fingerprint spoofing, no cookie or token handling, and navigator.webdriver left at Playwright's default of true. Per Architecture Decision AD-3, the harness fills the exact question into the input, but the Tester presses Enter manually.

## Signed-Out Context & Navigation

    -   Isolated Profile: Google opens in a separate, dedicated signed-out browser context under Electron's userData (browser-profiles/google) for each run. This ensures that personal search history, account cookies, and personalized rankings do not affect or contaminate the search results.
    -   Direct Navigation: Loading [https://www.google.com](https://www.google.com) directly succeeds cleanly in a fresh persistent context.
    -   Automated Query Behavior & Bot Detection: Submitting programmatic queries via automation triggers heuristic checks (such as CAPTCHA/bot-detection walls). Per epic rules, no stealth plugins or fingerprint spoofing are applied; bot challenges are documented as-is.

## Selectors 

| Setting| Selector| What it is|
| input| [role="combobox"][aria-label="Search"] or textarea[name="q"]|the primary search input box|
| submitButton| input[name="btnK"]| the Google Search submit button (or manual Enter keypress by Tester)|
| searchResults| #search or div.g| the main container for organic search results|
| knowledgePanel| [data-attrid="title"]|sidebar knowledge graph or featured snippet box|
| Offline| standard browser network error page| full-page offline state|

## Submit Signal & Timing

Begin: Input population by the harness, followed by the Tester pressing Enter.

Page-Load Metric: Unlike Copilot's WebSocket streaming ticks, page-load time for standard Google Search comes directly from the browser's native load event when navigating to the /search?q=... results page.

Completion: Marked by the stabilization of the DOM and the appearance of the #search results container.

## Decisions

    - Product / target is a configuration setting, keeping the adapter architecture uniform with E4.

    - Each trial starts a fresh signed-out context so search queries never share history or session state.

    - The Google profile lives under Electron's userData (browser-profiles/google) and is never read directly by the harness logic.

