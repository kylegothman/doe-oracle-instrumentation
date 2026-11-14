# Copilot spike (#32)

What was learned about driving Microsoft Copilot from Playwright's Chromium before the Copilot adapter (E4) was built, and how it maps onto the harness settings. The full findings, with the timeline tables, are in the comment on issue #32.

## Setup

Playwright 1.65 with Chrome for Testing 158, headed, `chromium.launchPersistentContext` on a throw-away profile folder (deleted afterwards), macOS, 2026-11-13. No stealth plugin, no user-agent or fingerprint spoofing, no cookie or token handling, and `navigator.webdriver` left at Playwright's default of `true`. The Tester signed in and pressed Enter for every message; the harness only typed the question (Architecture decision AD-3).

Two Copilot products were tried, because "Copilot" on the web is two things behind one sign-in page:

1. **Microsoft 365 Copilot Chat**, what a work or school account gets, at `https://copilot.cloud.microsoft/chat`. Works. Every timing, selector, and citation finding below comes from it.
2. **Consumer Copilot**, what a personal Microsoft account gets, at `https://copilot.com/chat`. Same app shell and selectors as far as could be seen, but every send is gated by a Cloudflare Turnstile check that the Playwright browser fails, so no question was ever submitted.

Which product the harness drives is the `copilot.product` setting in `src/shared/harness-config.json` (`m365` or `consumer`, overridable for a run with `HARNESS_COPILOT_PRODUCT`). Each product carries its own `chatUrl`, sign-in hosts, and selectors, so switching needs no code change. The default is `m365`, the only product Playwright's browser can drive as shipped.

## Side by side

| | Microsoft 365 Copilot Chat (work account) | Consumer Copilot (personal account) |
| --- | --- | --- |
| Signed-out landing | `copilot.microsoft.com` redirects to `copilot.com`, a sign-in-only page ("Microsoft Copilot \| Sign in") | same page, same redirect |
| Sign-in | `login.microsoftonline.com` (Microsoft Entra ID plus Duo); persists in the profile folder | `login.live.com`; persists in the profile folder |
| Chat URL after sign-in | `https://copilot.cloud.microsoft/chat`; the first message navigates to `/chat/conversation/<uuid>` | `https://copilot.com/chat`; a "First Run Experience Dialog" (Close button) covers the chat on the first visit; the account button reads "Personal account"; extra "Temporary chat" and model-selector buttons |
| Input | `getByRole('textbox', { name: 'Message Copilot' })`, a contenteditable `span#m365-chat-editor-target-element`; `locator.fill()` works; readback carries zero-width characters | identical, including the element id and the zero-width characters |
| Send / Stop | `button[aria-label="Send"]`, replaced by `button[aria-label="Stop generating"]` while streaming | Send identical; Stop never seen because nothing was ever sent |
| Conversation, message, reply, toolbar, citation selectors | see below | unobserved: no message was ever sent; the settings carry the Microsoft 365 selectors until a send works |
| Submit signal, stream end, citations | measured below | unobserved |
| Bot challenge | none, at sign-in or on three submissions | Cloudflare Turnstile on every send, failing with error 600010 (below) |

## Consumer Copilot: what happened on Enter (two attempts, same result)

- Within about 2 s of the Tester's Enter the page loaded a Cloudflare Turnstile widget (`challenges.cloudflare.com/cdn-cgi/challenge-platform/.../turnstile/...`, `auto` appearance). No request carrying the question ever left the browser: the ChatHub socket showed only its handshake and keepalives, and no HTTP call went to a chat endpoint.
- About 4 s later the console warned `[Cloudflare Turnstile] Error: 600010` (Cloudflare's "challenge could not be completed" family). The widget reloaded and failed the same way, and the page showed a `role="alert"` reading "Your request couldn't be completed. Refresh to try again." with a Refresh button.
- The page then reloaded to a fresh `/chat` with the conversation gone. The sidebar still read "No chats yet", so no conversation was created on the account. On the second attempt the typed question survived the reload as a draft, and Turnstile ran again right after the reload, unprompted, with the same error.
- Timeline, seconds after the Tester's Enter. Attempt 1: widget 4, error 11, second widget 14, second error 22, reload 37. Attempt 2: widget 2, error and alert 6, second widget 9, second error 12, reload 15, third widget 19, third error 23.
- Nothing was done to pass or avoid the challenge, per the epic's rules. The missing control is the Tester's own everyday browser: if a send works there with the same account, the gate is specifically on automated browsers, which is what Turnstile is for.

## Microsoft 365 Copilot Chat: details

Three questions, each submitted by the Tester pressing Enter: Q1 "What is combinatorial testing?", Q12 "What is the global broadband speed test?" (web-grounded), and Q11 with the browser offline.

### URL and sign-in

- `https://copilot.microsoft.com/` redirects to `https://copilot.com/`, which is only a sign-in landing page. A signed-out visit cannot chat.
- After sign-in the chat is `https://copilot.cloud.microsoft/chat` (shown as "Copilot Chat (Basic)" with "Commercial data protection" on the work account). The first message of a conversation navigates to `/chat/conversation/<uuid>`.
- Signed-out detection: the page lands on host `copilot.com` or a sign-in host, or shows the "Sign into Copilot" heading instead of the input.
- No bot challenge, CAPTCHA, or "unsupported browser" page appeared at sign-in or on any submission.

### Selectors

Roles, labels, and data-testids only; no generated class names except the two Fluent ones that have no alternative. These are the `selectors` of the `m365` product in the config.

| Setting | Selector | What it is |
| --- | --- | --- |
| `input` | `[role="textbox"][aria-label="Message Copilot"]` | the contenteditable editor (`span#m365-chat-editor-target-element`); `locator.fill()` works; reading it back includes zero-width characters (U+200B, U+200C) the editor appends, so the typed-text check strips `[​-‍﻿]` first |
| `sendButton` | `button[aria-label="Send"]` | present while the question is typed and not yet sent |
| `stopButton` | `button[aria-label="Stop generating"]` | replaces Send while the answer streams; its disappearance is a definite finished marker |
| `conversation` | `[role="feed"][aria-label="Chat conversation"]` | the message list |
| `message` | `[role="article"]` | one per message, headed "You said:" or "Copilot said:" |
| `botMessage` | `[data-testid="chat-response-message"]` | a Copilot message; the newest also carries `[data-testid="lastChatMessage"]` |
| `reply` | `[data-testid="markdown-reply"]` | the answer body, which grows while streaming |
| `loading` | `[data-testid="loading-message"]` | shown in the new message before the first token |
| `messageActions` | `.fai-CopilotMessage__actions` | the Copy Response / feedback / Try Again toolbar; appears when the message is complete |
| `citation` | `button.fai-BebopCitation` | inline citation button; its aria-label is `Citation: <provider> — <title>` (and " plus N more" when grouped); `[data-testid="sources-button-testid"]` opens a Sources panel |
| `answerError` | `[role="alert"]` | an error shown in place of an answer |
| `offline` | `img[alt="No network connection"]` | the full-page "No internet connection" state that replaces the app |
| `signInPrompt` | `h1:has-text("Sign into Copilot")` | the signed-out landing page |

### Submit signal

Key events are not observable: keydown, keypress, keyup, and beforeinput listeners on `document` and on `window` in the capture phase never fired for the Tester's Enter. Observable signals for Q12, all on the same machine clock, against the page's own telemetry stamp (Copilot sends a frame with `Timestamps.RequestSent` after each answer):

| Signal | vs RequestSent |
| --- | --- |
| Input cleared (MutationObserver on the editor, page clock) | −14 ms |
| "Stop generating" appears and the new "Copilot said:" article is added (page clock) | +87 ms |
| WebSocket frame carrying the question (Playwright `framesent`, main process) | +91 ms |

The question never travels as an HTTP request: it goes over a SignalR WebSocket to `substrate.office.com/m365Copilot/Chathub/…` (the request frame is `arguments[0]` with `source: "officeweb"`, then `type:1 target:"update"` frames). The socket is opened on page load and closed after each answer; the next message opens a new one.

Most reliable begin: the input clearing, confirmed within about 2 seconds by the Stop button or the request frame. An input that clears with neither following is the Tester deleting the text, not a submit.

### Streaming and the end of the stream

- About 0.3 s after submit: an "EarlyProgress" frame ("Putting it together…") and the loading state in the new article.
- First token: a `type:1 update` whose message text starts the answer; then `writeAtCursor` chunks every 70 to 110 ms, and the `markdown-reply` text grows every ~72 ms. First token came 0.97 s after submit for Q1 and 2.9 s for Q12.
- Last visible change: Q1 at submit + 8.95 s (Copilot's own LastTokenReceived agreed within 0.1 s); Q12 0.76 s before LastTokenReceived, because the last frames carried citation metadata with nothing visible.
- Explicit "finished" markers, in order: the Stop button reverts to Send, the message actions toolbar and feedback buttons appear, the socket receives `{"type":2, item: {messages: [...]}}` (the full final message with `references`) then `{"type":3}` (completion), the page sends its telemetry frame, and, for the first message of a conversation, the page navigates to `/chat/conversation/<id>` and re-renders the same text about 1.2 s later.
- So quiet-period detection on the `markdown-reply` text works, the Stop button disappearing is a definite finished marker, and the post-completion re-render must not count as a change: end = last change before the finished marker.

### Citations

- Inline citation buttons with a provider label ("speedtest", "+1" when grouped) and the title in the aria-label; no `<a href>` in the answer. The Sources panel lists title and domain. The WebSocket `references` map gives `targetLink` (full URL) and `Title` per citation key.
- Answers without web grounding (Q1) have no citations at all (`references: {}`), so an empty list is normal.

### Errors

- Network failure (browser taken offline before Enter): the whole app is replaced by the "No internet connection" screen; the ChatHub socket opens and closes immediately in a retry loop; the page recovers when the network returns. Maps to UNREACHABLE.
- Rate limit / "something went wrong": not reproducible in three messages on the free tier. The final frame reports `throttling: { maxNumUserMessagesInConversation: 600, numUserMessagesInConversation: n }`, so the per-conversation limit is far away. The adapter treats an error shown in place of an answer as ERROR_RESPONSE and a socket that closes mid-stream without completion as UNREACHABLE; both are covered by the fixture only until seen live.
- HTTP status: since the question goes over a WebSocket, "HTTP 4xx/5xx on the request that carries the question" can only be the WebSocket handshake failing; the fixture stands in for it.

## Decisions

- Product is a setting (`copilot.product`), each product with its own `chatUrl`, `signInHosts`, and `selectors`. Default `m365`.
- Each trial starts a new chat so questions do not share context.
- begin = the input clearing (page clock), confirmed by the Stop button or the request frame; first response = the first text in the new `markdown-reply`; end = the last change to that text before the finished marker; citations = title from the citation buttons plus URL from the `references` map, as `title · url`.
- The Copilot profile lives under Electron's userData (`browser-profiles/copilot`) and is never read by the harness. The adapter never logs or stores raw ChatHub frames: it reads them only for the citation URLs and the submit cross-check. Both spike profiles were deleted.
