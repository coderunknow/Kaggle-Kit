# The chat interface

The client is a React single page application. It never talks to the model
server directly: every request goes through the local proxy backend in
`server/`, which is served from the same origin. That removes the CORS
problem completely and keeps the API key out of the browser when the profile
uses the "local proxy secret store".

## Connection profiles

A profile describes one OpenAI-compatible endpoint.

| Field | Meaning |
| --- | --- |
| Display name | Shown in the profile list and in the header. |
| Base URL | The OpenAI-compatible base URL, e.g. `https://example.trycloudflare.com/v1`. Normalised before use: a missing scheme becomes `https://`, a missing `/v1` is added, trailing slashes are removed and a pasted `/chat/completions` endpoint is reduced to its base. |
| API key | The bearer token of the server. |
| Where the key is kept | `This tab only` (memory), `Local proxy secret store` (`0600` file) or `Browser storage` (plain text, opt-in). |
| Model ID | Filled from `/v1/models` with **Discover models** or typed manually. Empty means "the first model the server reports". |
| System prompt | Sent as the first message of every request. The field shows the character count and an estimated token share of the 8 192-token window, and **Insert the recommended Qwen prompt** fills it with the prompt described below. |
| Request timeout | Per request timeout in milliseconds (1 000 – 1 800 000). |

### The recommended system prompt

The editor can insert a ready-made prompt for the deployment this repository
describes (one system message, no tools, 8 192-token context). The text lives in
`shared/prompts/qwen.ts` and is mirrored in
[`research/qwen-system-prompt/SYSTEM_PROMPT.md`](../research/qwen-system-prompt/SYSTEM_PROMPT.md),
which also records what each block is for and what was deliberately left out.
The two copies are checked against each other by `shared/prompts/qwen.test.ts`.

The button only changes the form. Nothing is sent until the profile is saved,
and an empty field still means "no system message", which is the right default
for other OpenAI-compatible endpoints.

### Connection test

**Test connection** performs two real requests and reports them separately:

1. **models** – `GET {base}/models` with the API key. A warning is shown when
   the configured model is not part of the answer (some servers only report an
   alias).
2. **inference** – `POST {base}/chat/completions` with a tiny prompt
   (`max_tokens: 24`, `temperature: 0`).

The result distinguishes the failure modes that the evidence allows:

| Result | Meaning |
| --- | --- |
| Connection failed | The request never reached the server (network error, wrong host, tunnel down). |
| Blocked by CORS or proxy | The browser or a proxy refused the request. The interface never asks you to disable browser security. |
| Authentication failed | HTTP 401/403 – the key is wrong or was rotated. |
| Not found | HTTP 404 – wrong base URL or unknown model. |
| Request timed out | The server did not answer in time. |
| Server error | HTTP 5xx. |
| Invalid response | The body was not a valid OpenAI-compatible response. |
| Inference failed | The request was accepted but no completion came back. |

The key never appears in the result, in the log or in the URL.

## Inference settings

The **Inference** tab edits the request time parameters of the active profile.

| Control | Sent as | Notes |
| --- | --- | --- |
| Maximum output tokens | `max_tokens` | 1 – 32768. |
| Temperature | `temperature` | 0 – 2. |
| Top-p | `top_p` | 0 – 1. |
| Send a frequency penalty | `frequency_penalty` | Only sent when the switch is on, otherwise the parameter is left out entirely. |
| Send a presence penalty | `presence_penalty` | Same behaviour. |
| Effort sent with the request | `reasoning_effort` | Only sent when the connected server advertises the option. In `llama.cpp` reasoning effort is a **start-up** flag (`--reasoning-effort medium`), so the value is normally not sent per request. |
| Stream the answer | `stream` | Disabled until a streaming probe against this endpoint succeeded. |

**Start-up options are not request options.** Context size, the GPU layer
split and speculative decoding (MTP) are decided when `llama-server` starts.
The interface shows them in a separate card and never pretends that a browser
setting could change them. The notebook writes them to `runtime.json`.

**Reset to defaults** restores `max_tokens: 1024`, `temperature: 0.7`,
`top_p: 0.95`, no penalties, no reasoning effort and no streaming.

## Streaming

The streaming switch stays off until **Verify streaming support** has made a
real `text/event-stream` request against the configured endpoint. The backend
performs the probe, caches the result per base URL and refuses to proxy a
streaming request that was not verified (`HTTP 409`).

This matters for the Kaggle setup: a Cloudflare Quick Tunnel does not support
Server-Sent Events, so the probe fails and the interface keeps using ordinary
(non streaming) requests, which the tunnel handles correctly.

## Layout and navigation

The window is split into three parts: the conversation sidebar, the context
bar and the conversation itself.

* The sidebar groups the history into **Today**, **Yesterday**,
  **Previous 7 days** and **Older**. A conversation can be renamed inline and
  is only deleted after a second, explicit click. The active connection sits
  at the bottom of the sidebar instead of being hidden in a dialog.
* The search field appears as soon as three conversations exist and matches
  both the title and the text of the messages.
* The context bar shows the title, the number of messages, the active profile
  and model, the result of the last connection test, the export button and the
  theme switch.
* On narrow screens the sidebar becomes a drawer and the context bar keeps one
  menu button; the settings drawer takes the full width. The layout reflows
  down to 360 px.
* The theme can follow the operating system or be fixed to light or dark.
  The choice is stored locally and applies immediately.

## The conversation

* **New conversation** in the sidebar, plus a title that is taken from the
  first message. On the landing view the composer starts the first
  conversation directly; nothing is created until the first send.
* **Enter** sends a message, **Shift+Enter** inserts a newline. The setting
  can be changed to "Ctrl+Enter to send" in the preferences. An input method
  editor is never interrupted: while a composition is active, Enter belongs to
  the IME.
* Four **prompt starters** fill the composer of an empty conversation with an
  editable prompt. They never send automatically.
* The answer is rendered as Markdown with GFM tables. Code blocks are
  highlighted once the answer is complete (not for every streamed token, which
  would cost more than the streaming itself), have a language label and a copy
  button that reports a refused copy instead of claiming success.
* The answer follows new tokens only while the reader is at the bottom. A
  **Jump to latest** button appears when the reader scrolled up, so reading is
  never interrupted by the stream.
* **Edit** a user message and resend it – the conversation is truncated at
  that point and continues from there. **Resend** repeats a user message,
  **Regenerate** repeats the last answer. **Retry** appears on a failed or
  cancelled answer.
* **Stop** cancels a running request. The answer is kept and marked as
  cancelled, the conversation stays intact. If a stream fails, the part that
  arrived is kept and the message is marked as failed, never as complete.
* Answers that a server ended with `finish_reason: "length"` or
  `"content_filter"` say so instead of looking complete.
* **Copy** is available on every message and reports the real outcome.
* Token counts are only shown when the server returned a `usage` object, with
  `in` and `out` taken from that object. No number is estimated.
* The header shows the active profile, the model and the state of the last
  connection test.

## Drafts, export and data

* The composer keeps one draft per conversation. The draft is written to
  local storage while typing and restored after a reload or when switching
  back to the conversation. It is removed when the message is sent or the
  conversation is deleted.
* **Export as Markdown** downloads the active conversation with its title,
  timestamps, both roles, the original Markdown of the answers, markers for
  cancelled or failed answers and the token usage that the server reported.
  No key, request parameter or hidden state is included. The button says so
  when the browser blocks the download.
* *Data & credentials* shows the number of profiles, conversations and drafts,
  the stored keys of the local proxy and every browser credential, and can
  remove each of them.

## Storage

| Data | Where | Notes |
| --- | --- | --- |
| Profiles, conversations, UI preferences | `localStorage` in this browser | No credentials. |
| Composer drafts | `localStorage` (`kaggle-kit.drafts.v1`) | At most 50 drafts of 20 000 characters; removed on send or when the conversation is deleted. |
| API key (session mode) | Memory only | Gone after a reload. |
| API key (browser mode) | `localStorage`, plain text | Explicit opt-in, warned about in the UI, removable under *Data & credentials*. |
| API key (server mode) | `0600` file in `.data/secrets.json` | Managed by the local proxy, never sent to the browser. |

*Data & credentials* lists all of it and can remove every key, every
conversation or all local data. Conversations and credentials are never sent
to analytics or to any third party.

## Accessibility

* Every control has a label, the message list is a labelled region and state
  changes (generating, complete, cancelled, failed) are announced through a
  visually hidden `role="status"` region. The message log itself is not live,
  because that would read every streamed token aloud.
* The configuration is a proper tab list: arrow keys, Home and End move
  between the tabs and the selected tab is the only one in the tab order.
* The focus ring is visible on every control, icon buttons have accessible
  names and the skip link jumps directly to the conversation.
* The settings drawer is a modal dialog: it takes focus, closes with `Escape`
  and returns the focus to the button that opened it.
* The whole interface is operable with the keyboard:
  **Alt+Shift+N** starts a new conversation, **Ctrl/Cmd+/** focuses the
  composer, **Escape** closes the sidebar on narrow screens and the settings
  drawer. The shortcuts are listed in the preferences tab.
* Conversation rows are real buttons; the action buttons of a row appear on
  hover but are always reachable with Tab, and stay visible on touch screens.
* Colours are defined as tokens with a light and a dark variant, and the
  layout reflows for small screens.
* `prefers-reduced-motion` disables the animations.

## Known limitations

* The proxy has to be running. The client shows a banner when
  `GET /api/health` fails; the state is checked every 30 seconds and when the
  tab becomes visible again.
* The proxy can reach any host by default. Set `KAGGLE_KIT_ALLOWED_HOSTS` to a
  comma separated list to restrict it.
* Token counts are only shown when the server returns a `usage` object. No
  count, timing or performance number is ever estimated.
