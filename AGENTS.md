# AGENTS.md

Instructions for humans and agents that work on this repository.

## What this repository is

Two deliverables that belong together:

1. `notebooks/qwen3_8_27b_api.py` – the Kaggle deployment script for a GGUF
   model on Tesla T4 x2 with the CUDA build of `llama.cpp`.
2. `src/` + `server/` – a browser chat client and the local proxy backend that
   talks to any OpenAI-compatible endpoint.

## Ground rules

* **Never commit credentials, keys or tunnel URLs.** The API key is generated
  at runtime. `src/security.test.ts` fails the build if a tunnel URL or a
  credential appears in the source.
* **Never commit model weights or archives.** `*.gguf`, `*.tar.gz`, `.data/`
  and `*.log` are ignored.
* **`DESIGN_LOG.md` and `AGENTS_LOG.md` are append-only.** Add a new entry,
  never rewrite or delete an existing one.
* **Keep the changes focused.** Do not replace features that are unrelated to
  the task, and do not add a second framework, a second API client or a second
  configuration store next to an existing one.
* **Only claim what was verified.** Report the commands that were run and their
  real output. If something could not be executed (for example a real Kaggle
  run), say so explicitly.

## Layout

```
notebooks/   the Kaggle deployment script and its unit tests
shared/       the API client, the URL handling, the validation and the domain
              model; used by the browser client *and* by the backend
server/      the local proxy backend (node:http, no runtime dependencies)
src/         the React client (components, state, storage)
tools/       a mock OpenAI-compatible server for local development
docs/        the user facing documentation
```

## Conventions

* TypeScript everywhere in the browser and the backend, `strict` mode.
* One API client: `shared/api/client.ts`. The connection test and the chat use
  the same class, the same error classification and the same credential rules.
* Errors are `ApiError` with a `kind`
  (`network`, `cors_or_proxy`, `timeout`, `aborted`, `auth`, `not_found`,
  `bad_request`, `server`, `invalid_response`, `inference`, `unknown`) and a
  hint that the UI renders next to the message.
* Parameters that the connected server does not support are **omitted**, never
  sent with a guessed value. `shared/api/requests.ts` builds the request body
  and reports what it left out.
* React state lives in one reducer (`src/state/appState.ts`); the provider
  (`src/state/AppProvider.tsx`) owns the persistence; `src/state/useChat.ts`
  owns the request lifecycle.
* Credentials are separated from the ordinary settings. `session` (memory),
  `server` (the `0600` file of the proxy) and `browser` (opt-in plain text).
* Styling is plain CSS with design tokens in `src/styles/global.css`. No CSS
  framework, no component library, no icon package.
* Comments explain *why*, not *what*.

## Checks

Run all of them before opening a pull request:

```bash
npm run typecheck    # tsc for the client and for the backend
npm run lint         # eslint
npm test             # vitest
npm run build        # typecheck + vite build + esbuild bundle of the backend
npm run check:integration   # the built application against the mock upstream
python3 -m unittest discover -s notebooks -p "test_*.py"
```

`npm run check` runs the first three. The notebook tests need the
`requests` package. The same checks run in
`.github/workflows/ci.yml` on every push and pull request; they need no
secret, no GPU, no weights and no tunnel.

## Writing tests

* `shared/` and `server/`: plain unit tests, no DOM.
* `server/app.test.ts`: a real backend on an ephemeral port against a mock
  OpenAI-compatible upstream – no mocks of the module under test.
* `src/components/App.test.tsx`: jsdom, the whole application, with `fetch`
  replaced by a router that mimics the backend.
* `server/app.security.test.ts`, `server/app.streaming.test.ts`: the real
  backend against a real HTTP upstream, for the request policy and for the
  lifecycle of a stream.
* `tools/integration-check.mjs`: the *built* application against the mock
  upstream; it is the check that proves the bundle works, not the sources.
* A test that asserts a *negative* ("the key is not in the log", "the parameter
  is not sent") is worth more than a happy path test.
* Never put a real credential into a fixture.

## Deploying to Kaggle

The deployment script is the only place that knows about GPUs, model files and
tunnels. Keep it self contained, keep the download resumable, keep the GitHub
release *list* API out of it and let the smoke test be a real inference
request.
