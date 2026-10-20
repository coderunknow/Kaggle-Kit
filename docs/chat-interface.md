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
describes (one system message, 8 192-token context). The base text describes
ordinary chat without tools; a **tool-use variant** derived from it replaces
the no-tools claim with guidance for the verified native protocol (schema
arguments, untrusted tool output, real-source citations, approvals and
bounded loops). Use the variant only for profiles whose endpoint passed the
tool probe. The base text lives in `shared/prompts/qwen.ts` and is mirrored in
[`research/qwen-system-prompt/SYSTEM_PROMPT.md`](../research/qwen-system-prompt/SYSTEM_PROMPT.md),
which also records what each block is for and what was deliberately left out.
The two copies are checked against each other by `shared/prompts/qwen.test.ts`.
If a verified tool profile still carries the base prompt, the proxy replaces
the known no-tools sentence before sending so the model never receives a tool
list together with "you have no tools".

The button only changes the form. Nothing is sent until the profile is saved,
and an empty field still means "no system message", which is the right default
for other OpenAI-compatible endpoints.

### Connection test

**Test connection** runs one real request sequence against the configured
endpoint and reports every stage separately:

1. **Reachability** – the request reached a server that answered with an HTTP
   status (any status, including 401 or 404).
2. **Authentication** – the endpoint accepted the API key (or the request
   without one, when the profile has no key).
3. **Model list** – `GET {base}/models` returned a readable model list.
4. **Usable model** – the configured model is advertised, or the endpoint
   reports no models and a model has to be entered by hand. A model that is
   not advertised stays a warning until step 5 decides it.
5. **Inference** – `POST {base}/chat/completions` with a tiny prompt
   (`max_tokens: 24`, `temperature: 0`) returned a non-empty assistant message
   or reasoning text.
6. **Streaming** – a separate check. It is **not** part of the badge: the
   connection can be `Connected` while streaming is unverified, and streaming is
   only marked verified after **Verify streaming support** observed a real
   `text/event-stream` response with content and a finish reason (or `[DONE]`)
   for this endpoint and credential.

Each stage has its own state: `not run`, `running`, `ok`, `warning`, `failed`
or `not applicable`. `Connected` is shown only when the inference stage
succeeded; an intermediate success (reachability, auth or the model list) can
never produce it. The result names the tested endpoint and the time, and lists
a concrete next step for the verified cause.

The failure modes stay distinguishable:

| Result | Meaning |
| --- | --- |
| Not reachable | No HTTP status at all: network error, wrong host, tunnel down, timeout. |
| Authentication failed | HTTP 401/403 – the key is wrong or was rotated. |
| Not found | HTTP 404 – wrong base URL or unknown model. |
| Bad request | HTTP 400/422 – the server rejected the request shape or the model ID. |
| Server error | HTTP 5xx – the endpoint itself failed. |
| Inference failed | The model list worked but no completion came back. |
| Invalid response | The body was not a valid OpenAI-compatible response. |
| Streaming not verified | The inference worked, but no usable event stream was observed. |

### One active connection

Every surface uses the same active profile and the same effective base URL:
the connection test, the chat request, the settings cards, the context bar and
the sidebar footer. A value typed without `/v1` is normalized once
(`https://host` → `https://host/v1`), an existing `/v1` is never duplicated and
a legitimate path prefix is kept. The editor shows the value that was typed and
the address that is really used; the chat sends exactly the latter.

The status is tied to that configuration. Editing the base URL, the model, the
timeout or the credential mode drops the stored result (and the discovered
model list when the endpoint changed); writing a new key does the same. The
settings drawer, the context bar and the sidebar show `Not tested` or
`Test needed` until the new configuration is tested again. A test of unsaved
values is shown only inside the editor and never changes the saved profile's
status.

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

## Tool-using chat (v0.1.0-dev4)

Tool use is an explicit profile-level opt-in and is disabled for older profiles.
It does not change ordinary chat. Before the tool loop can run, open **Tools &
permissions** and verify the exact endpoint, credential and model. The isolated
probe makes two non-streaming requests: it requires one correctly named native
function call with `finish_reason: "tool_calls"`, then sends that call back with
a synthetic no-op result and requires a final `finish_reason: "stop"` response.
The probe never executes a function. It is not inferred from a URL, model family,
ordinary inference or `--jinja`. Each explicit **Verify native tool calling**
action performs a fresh probe, even within the cache lifetime; the proxy caches
the resulting capability for up to ten minutes to gate subsequent tool chats
for the same endpoint, credential and model. Unsupported, failed, stale or
unverified capabilities leave tools disabled. After the non-streaming round
trip succeeds, the probe additionally verifies streamed tool-call fragments
(argument JSON assembled per index and only accepted with
`finish_reason: "tool_calls"`) and reports that as `streamingSupported`;
streaming failure never downgrades the proven non-streaming result. Tool
loops themselves use non-streaming rounds so approvals can pause between
rounds.

The seven categories are:

1. **Calculator and unit conversion** – deterministic local arithmetic; no
   `eval` or model-generated code execution.
2. **Uploaded conversation files** – list, read and analyze bounded excerpts
   from files the user uploads to this conversation. Supported types are TXT,
   Markdown, CSV, JSON, text-based PDF and DOCX. The proxy extracts at most 100k
   characters into an in-memory vault, caps each upload at 4 MiB, and removes
   the vault on conversation deletion/clear or expiry. It does not browse the
   host filesystem; uploaded content is untrusted input.
3. **Public web** – optional Brave Search plus safe page retrieval. The Brave
   key is stored in the proxy SecretStore; provider terms, account eligibility
   and charges are separate. Search results are untrusted and citations are
   only emitted from actual retrievals.
4. **Endpoint diagnostics** – read-only reachability, model list, harmless
   inference and capability checks for the active profile.
5. **Python sandbox** – optional Docker-only runner for a digest-pinned Python
   image. It is disabled by default; the tool is offered only after explicit
   configuration, and every run still requires per-call approval. If Docker or
   the image is unavailable at runtime, the call fails closed without running
   host Python. The container has no network and has CPU, memory, process,
   time and output limits. Docker availability is not inferred from model
   support or checked by the native tool probe.
6. **Configured HTTP tools** – add a fixed public endpoint with a bounded query
   schema (the current settings form creates GET tools). Requests are limited
   to public destinations/standard ports, DNS-pinned, redirect-refusing and
   size/time bounded. Only a small set of non-sensitive literal headers is
   stored in the profile; credentials use SecretStore references. If a stored
   tool uses a non-GET method, it always requires per-call approval.
7. **Remote MCP tools** – Streamable HTTP over public HTTPS only. Local `stdio`
   connections/processes are disabled. Discovery is non-executing; inspect the
   tool names, descriptions, schemas and permissions, select tools, then grant
   the server explicitly. A new selected tool or changes to the endpoint,
   headers, timeout, selected tool schema or permission invalidate the grant;
   removing selected tools only narrows the grant. A tool whose effective
   permission is `write` or `unknown` requires a separate approval for every
   call.

Known read-only tools can run automatically. The server, not the prompt,
validates function names, JSON arguments, permissions, budgets and approvals.
An exact operation denied by the user is refused without another approval
prompt in the same turn. Tool results and error text are passed back as
untrusted data; a tool cannot invoke another handler by returning prose. The catalog and conversation settings intersect: a conversation can narrow a
profile's tools and execution budgets, never expand them. Per-turn catalogs are
additionally filtered to runtime-usable tools (omitting `files_read` and
`files_analyze` when a conversation has no uploaded files) and capped at 12,000
UTF-8 bytes / 16 active tools so tool schemas fit comfortably inside the
8,192-token target context window. Default limits are three model rounds, eight
calls, 8 KiB input per call, bounded output, and a 120-second loop; profile and
conversation settings are clamped server-side. When a model emits an invalid
tool name, invalid JSON/schema arguments, or raw `<tool_call>` markup in prose,
the server allows at most **one** bounded corrective retry per episode grounded
in the exact validation failure and schema summary. Every turn records
structured `toolDiagnostics` (outcome, active/omitted tools, serialized byte
and token-estimate budget, rounds/calls used, and corrective retry outcome) in
the tool activity timeline.

Approval is for one exact prepared operation, not a standing permission. It
expires, cannot be replayed, and is invalidated if tool settings change, the
job is cancelled, or a credential the call would use is rotated while the
approval is pending (the credential fingerprint captured at proposal time is
re-checked at approval). Sandbox runs use named containers; timeout,
cancellation, output overflow and Docker errors force-remove the container so
a stopped program cannot keep running invisibly. The activity timeline shows the bounded/redacted arguments,
target, approval state and outcome; pending approval IDs and live job IDs are
never restored as active after reload. **Clear** and **Delete** abort in-flight
requests, cancel paused jobs and remove that conversation's in-memory files.

Tool traces/citations are not saved by default. They can be saved only when the
conversation opts in; old histories without an explicit persistence setting
are loaded without traces/citations. If Brave results were used and either
retention rights were not confirmed or tool-history persistence was off, the
tool-derived assistant answer and later assistant replies are visible in the
current session but replaced by an honest placeholder in local history and
Markdown exports. The UI announces this retention behavior. Uploaded file bytes and extracted text are never written to
browser or server profile storage.

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
  No key, request parameter or hidden state is included. Search-derived
  assistant text is replaced with a retention placeholder unless both Brave
  storage rights are confirmed and tool-history persistence is opted in. The
  button reports when the browser blocks the download.
* *Data & credentials* shows the number of profiles, conversations and drafts,
  the stored keys of the local proxy and every browser credential, and can
  remove each of them.

## Storage

| Data | Where | Notes |
| --- | --- | --- |
| Profiles, conversations, UI preferences | `localStorage` in this browser | Profiles contain server-side secret references, never direct HTTP header credentials. Uploaded file contents and the transient-result marker are not saved as raw provider data. |
| Composer drafts | `localStorage` (`kaggle-kit.drafts.v1`) | At most 50 drafts of 20 000 characters; removed on send or when the conversation is deleted. |
| API key (session mode) | Memory only | Gone after a reload. |
| API key (browser mode) | `localStorage`, plain text | Explicit opt-in, warned about in the UI, removable under *Data & credentials*. |
| Server-side API keys/credentials | `0600` file in `.data/secrets.json` | Secret values are separate from profiles and never sent to the browser. |
| Tool profile settings | `toolProfiles` record in `.data/secrets.json` | Stores allowlists, budgets and secret references, not direct credentials. Clearing server keys preserves profile settings and may leave references to re-enter. |

*Data & credentials* lists browser-held keys and proxy secret references. It
can clear session/browser keys and delete conversations; proxy secret values
and tool profiles are stored separately. Remove proxy secret references
individually, delete a connection profile to remove its server-side profile,
or erase browser-local data. Erasing browser data does not clear the proxy
SecretStore. Kaggle-Kit does not send data to analytics. When tools are
enabled, the selected model endpoint receives conversation context, configured
HTTP/MCP endpoints receive their requested arguments, and Brave receives the
user's search query. Review configured endpoints and provider terms before
enabling those integrations.

## Accessibility

* Every control has a label, the message list is a labelled region and state
  changes (generating, complete, cancelled, failed, pending approval and
  retention notices) use status/live semantics. The message log itself is not
  live, because that would read every streamed token aloud.
* The execution timeline is a labelled disclosure with status text, bounded
  argument details, and separately labelled **Approve once** and **Deny**
  buttons; approval state is never conveyed by color alone.
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
