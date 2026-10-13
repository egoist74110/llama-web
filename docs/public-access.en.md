# Public access (Cloudflare tunnel)

[中文](public-access.md) · **English** · back to the [README](../README.en.md)


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

## 0. Prerequisite: the domain is on Cloudflare

A tunnel can only use a domain (zone) that has been **added to your Cloudflare account and is Active**. Cloudflare confirms you own the domain by its NS records pointing to Cloudflare, and only you can do this step:

1. On the Cloudflare dashboard home → Add a domain, enter the root domain (for example `example.com`), pick the Free plan;
2. Cloudflare gives you two name servers (`xxx.ns.cloudflare.com`); at your registrar, change the domain's NS to those two;
3. Wait until the domain shows Active in Cloudflare (a few minutes to 24 hours). Domains whose NS cannot be changed (some free subdomain services) cannot be added.

Cloudflare offers no free domains and cannot register one for you through the API; get a domain from a registrar (a free subdomain service, or buy one).

## Method A: one-click setup (recommended)

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

## Method B: create it by hand in the Cloudflare dashboard

1. The "Create a tunnel on the Cloudflare site" step has an illustrated walkthrough; the key points are:
   - Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel → type Cloudflared, give it a name;
   - on the next page, Install and run connectors, copy the token (it starts with `eyJ`; the whole `cloudflared.exe service install eyJ…` command works too) and **do not** run that command on this computer;
   - Public Hostname: fill in the subdomain and domain, set Service type to `HTTP` and URL to `127.0.0.1:8080` (the same as "Entry port").

   When done, enter the address you filled in (`subdomain.domain`) back into the guide.
2. In the "Paste the tunnel token" step: paste the token you copied, then go on to "Connect".

After you change the "Entry port" (under "Advanced"), the tunnel's ingress rule does not follow automatically: run one-click setup again for the same address through "Add another address", or change the Public Hostname in the dashboard.

## Method C: no domain, use a temporary address (Quick Tunnel)

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

