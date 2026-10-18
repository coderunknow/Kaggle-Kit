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
| System prompt | Sent as the first message of every request. |
| Request timeout | Per request timeout in milliseconds (1 000 – 1 800 000). |

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

## The conversation

* **New conversation** in the sidebar, plus a title that is taken from the
  first message.
* **Enter** sends a message, **Shift+Enter** inserts a newline. The setting
  can be changed to "Ctrl+Enter to send" in the preferences.
* The answer is rendered as Markdown with GFM tables and syntax highlighted
  code blocks; every code block has a copy button and every message can be
  copied as a whole.
* **Edit** a user message and resend it – the conversation is truncated at
  that point and continues from there.
* **Resend** repeats a user message, **Regenerate** repeats the last answer.
* **Retry** appears on a failed or cancelled answer.
* **Stop** cancels a running request. The answer is kept and marked as
  cancelled, the conversation stays intact.
* The four request states are visible: *generating*, *complete*, *cancelled*
  and *failed* (with the reason and the suggested action).
* The header shows the active profile, the model and the state of the last
  connection test.

## Storage

| Data | Where | Notes |
| --- | --- | --- |
| Profiles, conversations, UI preferences | `localStorage` in this browser | No credentials. |
| API key (session mode) | Memory only | Gone after a reload. |
| API key (browser mode) | `localStorage`, plain text | Explicit opt-in, warned about in the UI, removable under *Data & credentials*. |
| API key (server mode) | `0600` file in `.data/secrets.json` | Managed by the local proxy, never sent to the browser. |

*Data & credentials* lists all of it and can remove every key, every
conversation or all local data. Conversations and credentials are never sent
to analytics or to any third party.

## Accessibility

* Every control has a label, the message list is a labelled region and the
  status is announced with `role="alert"` / `aria-live`.
* The settings drawer is a modal dialog: it takes focus, closes with `Escape`
  and returns the focus to the button that opened it.
* The whole interface is operable with the keyboard, the conversation list
  items are focusable and react to `Enter` and `Space`.
* Colours are defined as tokens with a light and a dark variant, and the
  layout reflows for small screens.
* `prefers-reduced-motion` disables the animations.

## Known limitations

* The proxy has to be running. The client shows `proxy offline` in the header
  when `GET /api/health` fails.
* The proxy can reach any host by default. Set `KAGGLE_KIT_ALLOWED_HOSTS` to a
  comma separated list to restrict it.
* Token counts are only shown when the server returns a `usage` object. No
  count, timing or performance number is ever estimated.
