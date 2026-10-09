# llama-web

[中文](README.md) · **English**

A private local LLM console: one Nuxt + Bun process that starts, stops and switches `llama-server` by itself, serves an OpenAI-compatible API (`/v1/*`) and a management UI (Chinese / English, switched from the sidebar), and can optionally be exposed through a Cloudflare tunnel (API key required).

- Loads or switches models automatically from the `model` in each request; one model online at a time by default (switches are queued), and the setting can be changed to load several at once, with a memory estimate and check before each load
- Request preprocessing: image compression
- Scans model directories and reads GGUF metadata; each model can have several parameter profiles (call them as `name:profile`)
- External services: connect any OpenAI-compatible service (another inference backend, a remote service) as a forwarding target, routed by prefix; when it is offline you can save a start command and start and stop it from the page
- UI: Overview / Models / Connections / Chat / Logs / Settings; live speed, load progress, VRAM and failure diagnosis; the interface language is switched in the left sidebar and applies immediately, no restart
- Updates the official llama.cpp automatically, keeps old versions, one-click rollback in the UI
- Platforms: Windows 11 (NVIDIA GPU or CPU); the macOS source version is described below and is **not yet fully verified on a real Mac**. The development plan and decisions are in [`docs/plan.html`](docs/plan.html) (written in Chinese)

## Install

### Windows desktop app (recommended)

Download `llama-web_<version>_x64-setup.exe` from [Releases](https://github.com/egoist74110/llama-web/releases) and install it (per-user install, no administrator rights needed); the `SHA256SUMS` file on the same page lets you verify it. The installer is not code-signed: when SmartScreen warns, choose "More info → Run anyway". Bun / Node are not needed; the first launch downloads llama.cpp. System requirements, verified / unverified environments and known issues are in each version's release notes; build steps and the data directory are in the [Windows desktop notes](docs/windows-desktop.md) (Chinese).

### From source

Requires [Bun](https://bun.sh) (`bun` on your PATH). You do not need to download llama.cpp yourself: the first launch downloads the CUDA build (with cudart) from the official release and checks its SHA-256.

```bash
bun install
```

### macOS from source (not verified on a real Mac)

Also requires [Bun](https://bun.sh). The first launch downloads the official macOS build of llama.cpp for your chip and checks its SHA-256; a Mac has only this one build, so the Settings page has no GPU, device or CPU / GPU switch. There is no installer, in-app update or desktop shell: to upgrade, run `git pull` and then `./start.command build`.

- All data lives in `data/` inside the repository; to uninstall, delete the repository directory (back up `data/` first to keep your configuration).
- When models sit on an external exFAT / network drive, macOS creates `._xxx.gguf` companion files; the scan skips them automatically.
- "Choose folder" uses the system `osascript` dialog; the first time, the system may ask whether Terminal may control other apps. You can also paste a path directly; `~/models` expands to your home directory.
- Archives downloaded from the web carry a quarantine flag; if the system refuses to run a manually added llama.cpp, run `xattr -dr com.apple.quarantine <directory>` in a terminal.
- CI has a macOS job (`bun test`, type check, and running `--version` on the real macOS llama.cpp download). It does not load a model, so Metal inference, the folder dialog and double-click launch from Finder still need confirming on a real Mac.

## Start

Double-click `start.bat` (Windows) or `start.command` (macOS, double-click in Finder; if it says there is no execute permission the first time, run `chmod +x start.command` first). Both just call the same `scripts/launch.ts`. Closing the window or pressing Ctrl+C stops the service and ends every llama-server.

By default this starts the **desktop app** (the same as the installed one: Tauri shell + bundled service): it builds the server when needed, copies it into the shell's resources, then compiles and runs the shell (needs [Rust](https://rustup.rs); the first compile takes a few minutes, later ones are incremental). The shell uses its own data directory, not the repository's `data/`; to change it, set the environment variable `LLAMA_WEB_DATA` (absolute path). If you only want the service and to open it in a browser, add `web`.

When a build exists it shows whether the source changed since the last build and gives a 3-second countdown: if the source changed the default is to rebuild, otherwise to run as is; press `b` to rebuild, `r` to run, `q` to quit, or Enter for the default. With no build it installs dependencies and builds automatically.

```bash
start.bat          # ask (default depends on whether the source changed); on macOS use ./start.command
start.bat build    # always rebuild, then run
start.bat run      # no question, run the last build
start.bat web      # start only the service (open it in a browser); can be combined with build / run
```

The same on both platforms from the command line: `bun run start`, `bun run start:build`, `bun run start:run`, `bun run start:web`.

The default address is `http://localhost:5001` (it listens on `0.0.0.0`, so it is reachable on the LAN with every feature and no key). The first visit opens the setup guide: add a model directory and enable a model.

## Configuration

Everything is in `data/` (never committed to Git; set `LLAMA_WEB_DATA` to change the directory):

| File | Contents |
| --- | --- |
| `settings.json` | Ports, model directories, default parameters, scheduling, image compression, log retention, llama.cpp versions, interface language, etc. |
| `models.json` | Enabled models and parameter profiles |
| `secrets.json` | API keys, tunnel token, Cloudflare API token (stored in plain text; masked in the UI by default, kept out of logs and request records) |
| `templates/` | Custom chat templates |
| `runtime/` | Downloaded llama.cpp version directories, and cloudflared for the tunnel (`runtime/cloudflared/`) |
| `logs/` | Model output, events, request records (request records contain no conversation content) |

Almost every setting can be changed on the Settings page. `autoUpdate`, `keepVersions` and `cudaRuntime` can currently only be edited by hand in `settings.json` (`cudaRuntime` empty = pick the CUDA runtime automatically from the GPU driver and compute capability, a version number = pick it manually). Config files are written atomically and a backup is kept (`data/backups/`).

### Connecting a client

OpenAI-compatible: set Base URL to `http://<this machine's address>:5001/v1` and `model` to the model name (or `name:profile`). The LAN does not check keys, so any value will do.

## Public access (Cloudflare tunnel)

The public entry is a separate `:8080`: it binds only `127.0.0.1`, opens only `/v1/*`, and requires `Authorization: Bearer <key>`; the management UI and `/api/*` always return 404 on this entry. The tunnel (`cloudflared`) is started and supervised by llama-web itself.

All public-access settings are on one card, "Settings → Public access". While it is off there is only an "Enable public access" button; clicking it opens a step-by-step guide where every step is pre-filled and you confirm with "Yes, next" or "Change it"; at any step you can "Save progress and continue later" (progress is stored in `data/settings.json`, and the guide resumes from that step).

| Step | Content | Default |
|---|---|---|
| Entry port | The local port the tunnel forwards to | 8080 |
| API key | An existing one is reused; otherwise one is generated (shown in plain text only here, viewable in the list afterwards) | name `server-1` |
| Method | ① One-click setup (give a Cloudflare API token) ② Build it yourself on the Cloudflare site and paste the tunnel token ③ No domain, use a temporary address (method C, skips the Cloudflare steps and goes straight to "Connect") | an API token already saved → ①; only a tunnel token saved → ② |
| … | See method A / method B below | |
| Connect | Turns on the public entry and the hosted tunnel, waits for "Connected", runs one check, and shows the client address and key | |

When it is done the card becomes an overview: connection status, client addresses (every hostname on the tunnel that points at this machine's entry), "Check", the API key list, "Add another address", "Run the guide again" and "Turn off public access"; the port, tunnel method (own domain / temporary address), tunnel protocol (HTTP/2 recommended, QUIC as a fallback), tunnel token, API token and so on are under "Advanced". In temporary-address mode the overview names the method and hides "Add another address" and the tunnel token.

"Check" makes llama-web request each address's `/v1/models` from this machine without a key: a 401 means the whole path works; 530 = the tunnel the address points to has no online connector (usually DNS still points at another tunnel), 502 = the tunnel cannot reach the entry port on this machine, unresolvable = the DNS record is not active yet or the current network blocks it (some company networks block domains; add another domain).

### 0. Prerequisite: the domain is on Cloudflare

A tunnel can only use a domain (zone) that has been **added to your Cloudflare account and is Active**. Cloudflare confirms you own the domain by its NS records pointing to Cloudflare, and only you can do this step:

1. On the Cloudflare dashboard home → Add a domain, enter the root domain (for example `example.com`), pick the Free plan;
2. Cloudflare gives you two name servers (`xxx.ns.cloudflare.com`); at your registrar, change the domain's NS to those two;
3. Wait until the domain shows Active in Cloudflare (a few minutes to 24 hours). Domains whose NS cannot be changed (some free subdomain services) cannot be added.

Cloudflare offers no free domains and cannot register one for you through the API; get a domain from a registrar (a free subdomain service, or buy one).

### Method A: one-click setup (recommended)

1. Create a Cloudflare API token: avatar at the top right → My Profile → API Tokens → Create Token → Create Custom Token. Four permission policies (the new UI lets each one use only one scope):
   - Entire Account: Cloudflare One Connector: cloudflared · Write
   - Entire Account: Cloudflare Tunnel · Write
   - All zones: DNS · Read and Write
   - All zones: Zone · Read

   To change an existing token, press Review token → Update token for it to take effect; after Roll, paste the new value again.
2. In the guide's "Cloudflare API token" step: paste it and press "Verify and continue" (it is checked with Cloudflare first and a missing permission is named). If one is already saved, just "Reuse" it.
3. In the "Address" step: pick the domain (only usable zones are listed) and enter a subdomain (default `llm`). If no domain shows up, the "Where do domains come from" note appears, and you can switch to method B.
4. In the "Preview and run" step: the preview lists what will happen: create / reuse the tunnel, the ingress rule `subdomain.domain → http://127.0.0.1:<entry port>`, create or change a DNS CNAME (`<tunnel ID>.cfargotunnel.com`, proxied), save the tunnel token, and turn on the public entry and the hosting switch.
   - By default it reuses the tunnel llama-web is already hosting; if a tunnel with the same name exists, or the address's CNAME already points at another tunnel, the current state is listed and you choose "Reuse" or "Create new + repoint";
   - if the address already has an A / AAAA or other record it will not continue (llama-web never deletes records for you): pick another subdomain or delete it in the dashboard yourself;
   - a reused tunnel with other online connectors or other hostnames is flagged.
5. Confirm to run. Before running, the account is read once more and it stops for a new preview if anything changed; if a step fails you can "Retry from the failed step" or "Give up and delete what this run created" (only the tunnel / DNS records created this time are deleted). When you are done you can delete the API token in the Cloudflare dashboard; tunnels already created are not affected.
6. **Add another address** (for example a network cannot open the current domain): click "Add another address" in the overview, pick another domain and run it again. It only adds one ingress rule and one DNS record to the current tunnel; the existing addresses keep working.

### Method B: create it by hand in the Cloudflare dashboard

1. The "Create a tunnel on the Cloudflare site" step has an illustrated walkthrough; the key points are:
   - Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel → type Cloudflared, give it a name;
   - on the next page, Install and run connectors, copy the token (it starts with `eyJ`; the whole `cloudflared.exe service install eyJ…` command works too) and **do not** run that command on this computer;
   - Public Hostname: fill in the subdomain and domain, set Service type to `HTTP` and URL to `127.0.0.1:8080` (the same as "Entry port").

   When done, enter the address you filled in (`subdomain.domain`) back into the guide.
2. In the "Paste the tunnel token" step: paste the token you copied, then go on to "Connect".

After you change the "Entry port" (under "Advanced"), the tunnel's ingress rule does not follow automatically: run one-click setup again for the same address through "Add another address", or change the Public Hostname in the dashboard.

### Method C: no domain, use a temporary address (Quick Tunnel)

Pick "No domain, use a temporary address" in the guide: no domain, no Cloudflare account and no stored token. Once connected you get an `https://<random words>.trycloudflare.com/v1` address, used with an API key. Limits (the guide says so too):

- The address changes every time the tunnel starts (llama-web restart, turned off and on, reconnect after a drop), so clients must switch to the new address;
- Streaming works: chat requests (POST) were measured to return chunk by chunk; but Cloudflare does not officially support SSE, so GET-style streaming endpoints are buffered;
- At most 200 requests in flight at once, more get 429; there is no SLA, so it is for trying things out only; use your own domain for long-term use.

The public entry rules do not change: bound to `127.0.0.1` only, `/v1/*` only, a key required. Under "Advanced" you can switch between "own domain" and "temporary address" at any time (switching back to an own domain needs a saved tunnel token).

Temporary-address mode leaves no token, certificate or account information: it only uses cloudflared under `data/runtime/cloudflared/` and an empty config `quick-tunnel.yml`, and the child process is recorded in `data/run/pids.json`. **To uninstall / clean up: delete the data directory (`data/`), which removes `data/runtime/cloudflared/` with it; turning public access off or quitting llama-web also ends the cloudflared process.**

Where cloudflared comes from: a copy already installed on this machine is preferred (PATH, common install locations) and is copied to `data/runtime/cloudflared/` and run from there; if there is none, it is downloaded from the official release and its SHA-256 is checked. The tunnel starts and exits with llama-web; an unexpected exit is retried automatically (an invalid token is not retried: fix it and press "Retry now"). The token is kept in `data/secrets.json` and handed to cloudflared through an environment variable, so it never appears in the command line, logs, events or the UI (the UI shows only the masked value).

Verify:

```bash
curl https://<domain>/v1/models                                   # 401
curl https://<domain>/v1/models -H "Authorization: Bearer <key>"  # 200
curl https://<domain>/api/state                                   # 404
```

A key revoked in the UI stops working at once (401).

## External services

The Connections page connects any OpenAI-compatible service (address ending in `/v1`) as a forwarding target: clients still talk only to llama-web and call it as `name-modelid`, and requests still go through image compression, public-access authentication and request records. If you add none, behaviour is exactly as before.

- "Test connection" reads its model list; llama-web probes periodically whether it is online.
- Tick "Exclusive use of this machine": as soon as this service is online, llama-web unloads the local models it is running to free VRAM / memory.
- While the service is offline you can save a start command (with an optional working directory). "Start" confirms the command that will run, then keeps checking and counts the start as done once the service lists models. The command is run as an argument array, not through a shell; the process runs detached and does not end when llama-web exits.
- After a successful start a "Stop" button appears, which ends the process just started from here (and the processes it started). Only a service started by this run of llama-web can be stopped from here: after llama-web restarts, or for a service you started yourself elsewhere, the button is not shown.

## llama.cpp updates and rollback

After startup it checks the latest official version in the background: when there is a new one it is downloaded, checked, unpacked into a new version directory and made current; a network failure only records an event and the old version keeps being used this time. The last 2 versions are kept by default (the version a running model uses is never deleted). "Settings → llama.cpp versions" lets you switch / roll back by hand (with a confirmation box); when a model fails to load on a new version the failure card suggests a rollback. Switching versions does not restart a running model: the new version is used the next time it is loaded after unloading.

## App updates

"Settings → About & updates" shows the current version, and auto-update is on by default: when due it checks about 15 seconds after opening, and while running checks GitHub Releases once a day. With auto-update off it still checks daily and only shows a note next to the version number; you can check, update or skip this version by hand. The check time is saved across restarts and a failed check counts toward the daily interval; a manual check can be made at any time. Release notes are never popped up and no banner is shown at the top.

- Desktop app: with auto-update on, the installer is downloaded automatically; with it off, you click "Update now" to download and confirm "Close and install". The download counts as complete only when the GitHub asset digest and `SHA256SUMS` both match; installing stops all models and services, the desktop shell verifies it again before launching the installer, and the app reopens by itself afterwards. Settings and data are kept.
- Source version: only shows a note and opens the release page; nothing is installed automatically.
- Users on a pre-release receive later pre-releases and stable releases; users on a stable release receive stable releases only.

The auto-update switch for llama.cpp is in "Settings → llama.cpp versions" and is off by default: it checks daily and shows a note next to the version number, and you can check and download by hand; when on, new versions are downloaded and used automatically. A running model keeps its original runtime and the next load uses the new version. The CPU channel joins the daily check and updates only after its first manual download; manually added runtimes are never updated automatically.

## Releasing (maintainers)

GitHub Actions → "Windows release (draft)" → run it with the same version number as `package.json`. On a Windows runner the workflow installs frozen dependencies, tests, type-checks and builds the NSIS package, checks the files inside the package against an allowlist with `desktop/check-package.ts` (rejecting data / secrets / .env / logs / local paths), generates SHA256SUMS and a build manifest, and creates a **draft** prerelease; the release notes come from `docs/release-notes/v<version>.md`. Download the installer from the draft to accept it, then publish by hand (the tag is only created on publishing).

## Development

```bash
bun run dev          # dev mode (Node dev server; no public entry)
bun test             # unit tests
bun run typecheck    # type check
bun run build        # build into .output/
```

Pre-commit check (refuses files under `data/` and suspected secrets: `sk-…`, long hex strings, Bearer tokens). Enable it once per clone:

```bash
git config core.hooksPath scripts
```

When a value is deliberately fake (a test fixture), mark the line with `pre-commit:allow`.

Development conventions and the directory layout are in [`AGENTS.md`](AGENTS.md) (Chinese).
