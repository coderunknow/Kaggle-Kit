# Starting Kaggle-Kit on Windows

One command starts everything:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
```

Node.js **20.19 or newer** and npm are the only prerequisites. The script
never asks for administrator rights, never opens an elevated prompt and never
reads, writes or prints an API key. The Kaggle key is entered in the browser
and handled by the local proxy.

## What the launcher checks

| Step | Behaviour |
| --- | --- |
| Node.js | A missing `node` prints the download address and stops with exit code 1. `node --version` must be at least 20.19 (the value in `package.json` → `engines.node`). |
| npm | A missing `npm` explains that it ships with Node.js and stops. |
| Project | A missing `package.json` or `tools/launcher.mjs` stops with the path that was expected. |
| Dependencies | When `node_modules` is missing, `npm ci` (or `npm install` without a lockfile) runs and says that the npm registry is required. `-NoInstall` turns that into a clear error instead. |
| Build | When `dist/server/index.js` or `dist/client/index.html` is missing, `npm run build` runs. A build failure stops with the compiler message. |
| Port | The preferred port is 8787 (`KAGGLE_KIT_PORT`, or `-Port`). A busy default port is reported and the next free port is used. A busy **explicit** port stops with a conflict message instead of moving silently. |
| Readiness | The launcher polls `http://127.0.0.1:<port>/api/health` for up to 45 seconds. If the backend exits during start-up, the exit code and the log are shown. |
| Browser | After readiness, the local URL is printed and the default browser opens. `-NoBrowser` skips it. |
| Shutdown | Ctrl+C stops the backend, waits up to five seconds and force-stops it if necessary. No orphan process is left behind. |

## Options

```powershell
# use a specific port; a conflict is an error
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1 -Port 9000

# do not open a browser
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1 -NoBrowser

# fail instead of downloading missing dependencies
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1 -NoInstall
```

The same launcher can be started without PowerShell, for example from a CI job:

```bash
node tools/launcher.mjs --no-browser
```

## Where the key lives

The launcher does not touch credentials. The default credential mode keeps the
key in the memory of the browser tab; the optional server mode stores it in a
`0600` file created by the proxy. Neither mode writes a key into the launcher
output, the shell history or the repository.

## If something fails

* **"Node.js was not found in PATH"** – install Node.js 20.19+ from
  <https://nodejs.org/>, then close and reopen the terminal.
* **"Node.js ... is too old"** – install the current LTS release; the old
  installation can stay.
* **"Port ... is already in use"** – stop the other process (for example a
  previous proxy) or pass `-Port`.
* **"The backend did not start"** – run `npm run build` in the project folder
  and read the first error. The launcher repeats the last readiness reason
  (`/api/health` did not answer, the process exited, and so on).
* **"Installing the dependencies failed"** – check the network and run
  `npm ci` manually; a proxy or firewall may block the npm registry.

## Checking the real endpoint

The launcher starts the proxy; it does not test the Kaggle API. For a real
check from this machine, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\check-kaggle-connection.ps1
```

It asks for the base URL and the API key with hidden input, then performs a
model list request, a real non-streaming inference request and a real streaming
request. It prints a sanitized JSON report with the URL masked and the key
never included. If streaming is not supported (as with many Quick Tunnel
connections), the report says `failed` for that step while the non-streaming
inference can still be `ok`; Kaggle-Kit keeps streaming off in that case.
