# Kaggle-Kit

Deploy a large GGUF model on Kaggle (Tesla T4 x2) with the official CUDA build of
`llama.cpp`, expose it through an OpenAI-compatible API, and talk to it from a
polished browser chat interface.

The repository contains two halves that work together:

| Part | Location | What it does |
| --- | --- | --- |
| Kaggle deployment | [`notebooks/qwen3_8_27b_api.py`](notebooks/qwen3_8_27b_api.py) | Downloads the model and a CUDA `llama-server`, starts it with the verified configuration, smoke tests it with a real chat completion and (optionally) publishes it through a Cloudflare Quick Tunnel. |
| Chat interface | [`src/`](src) + [`server/`](server) | A React chat client and a small local proxy backend that talk to any OpenAI-compatible endpoint. |

```
browser  ──same origin──▶  local proxy backend  ──HTTP──▶  llama-server (Kaggle)
                            (server/)                              │
                            • serves the built client              └── optional
                            • injects the API key                    Cloudflare Quick Tunnel
                            • verifies streaming support
```

## Quick start

```bash
npm install
npm run dev            # proxy backend on :8787 + Vite dev server on :5173
```

Open <http://localhost:5173>, create a connection profile (base URL + API key),
run **Test connection**, start a conversation and send a message.

For a production-like run:

```bash
npm run build          # type check, build the client, bundle the backend
npm start              # serves the client and the API on http://127.0.0.1:8787
```

Without a GPU you can try the whole flow against the bundled mock server:

```bash
npm run mock:upstream  # OpenAI-compatible mock on http://127.0.0.1:8000/v1
npm start
```

Create a profile with base URL `http://127.0.0.1:8000` and the key `demo-key-123`
(the mock prints its own arguments).

## Deploying the model on Kaggle

See [docs/kaggle-deployment.md](docs/kaggle-deployment.md) for the complete
procedure. In short:

1. Create a Kaggle notebook, set the accelerator to **GPU T4 x2**, turn Internet on.
2. Paste the contents of `notebooks/qwen3_8_27b_api.py` into a cell and run it.
3. Copy the printed base URL and API key into the chat interface.
4. To avoid the 12 GB download in the next session, save the model as a Kaggle
   Dataset or as a Notebook Output (see the deployment guide).

The deployment script never depends on the GitHub release *list* API, which is
unreliable from Kaggle (`RemoteDisconnected`). It downloads the pinned
`llama.cpp` release assets directly and resumes interrupted downloads.

## Chat interface

* **Connections tab** – create, edit, select and delete API profiles: display
  name, base URL, API key, model ID, system prompt, request timeout and where
  the key is stored. A connection test performs a real model list request and a
  real inference request and reports every step.
* **Inference tab** – request time parameters: maximum output tokens,
  temperature, top-p, optional frequency and presence penalties, reasoning
  effort and the streaming switch. Start-up options of the server (context
  size, GPU split, MTP) are shown separately because the browser cannot change
  them.
* **Data & credentials tab** – shows exactly what is stored where and removes
  keys, conversations or all local data.

The interface supports Markdown with syntax highlighted code, copy, edit and
resend, retry, cancel, conversation rename/delete/clear, dark mode, keyboard
access and a mobile layout.

See [docs/chat-interface.md](docs/chat-interface.md) for the details.

## Security model

* The API key is **never** part of a URL, a log line, a committed file or an
  error message. It is sent in the `Authorization` header of the request to
  the configured endpoint.
* Three credential modes: **in memory for this tab** (default), **in the local
  proxy secret store** (a `0600` file next to the backend) and, as an explicit
  opt-in, **in browser storage** (plain text, with a warning).
* The browser never talks to the model server directly. It calls the local
  proxy, which removes the CORS problem and keeps the key out of the browser
  whenever the server mode is used.
* `src/security.test.ts` fails the build when a tunnel URL or a credential
  appears in the source.

See [docs/security.md](docs/security.md).

## Development

```bash
npm run typecheck      # tsc for the client and the backend
npm run lint           # eslint
npm test               # vitest (unit, integration and component tests)
npm run check          # all three
python3 -m unittest discover -s notebooks -p "test_*.py"   # deployment script tests
```

## Project layout

```
notebooks/    the Kaggle deployment script and its tests
shared/       code used by the browser client and by the backend
server/       the local proxy backend (node:http, no runtime dependencies)
src/          the React chat client
tools/        a mock OpenAI-compatible server for local development
docs/         deployment, interface, security and troubleshooting guides
```

## Documentation

* [docs/kaggle-deployment.md](docs/kaggle-deployment.md)
* [docs/chat-interface.md](docs/chat-interface.md)
* [docs/security.md](docs/security.md)
* [docs/troubleshooting.md](docs/troubleshooting.md)
* [DESIGN_LOG.md](DESIGN_LOG.md) – decisions and validation results
* [AGENTS.md](AGENTS.md) – conventions for contributors and agents
