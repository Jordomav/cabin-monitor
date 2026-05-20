# CABIN Base Monitor — Deployment Guide

End-to-end setup for running the monitor in production. This document assumes
the **Node server and the Minecraft server run on the same Digital Ocean droplet**
(your chosen topology). The CC:Tweaked computers talk to the Node server over
loopback (`http://127.0.0.1:3000`); external users hit the dashboard over HTTPS
at your domain.

---

## 0. Prerequisites

- A Digital Ocean droplet (or any Linux VM) with **root/sudo** and **Ubuntu 22.04+**.
- The Minecraft server (with CC:Tweaked + Create + Create: Crafts and Additions)
  is already installed and runnable on the droplet.
- A **domain name** with an `A` record pointing at the droplet's public IP.
  Required for HTTPS / push notifications. (If you skip the domain, mobile push
  will not work — browsers gate Service Workers + Push behind HTTPS for any
  non-`localhost` origin.)
- Local git access to push `farms.json` updates to `Jordomav/cabin-monitor`.

---

## 1. Install Node.js 20+ and PM2

```bash
# Node 20.x via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

# PM2 globally
sudo npm install -g pm2
```

Verify: `node --version` (≥ v20), `pm2 --version`.

---

## 2. Clone the repo and install dependencies

```bash
cd /opt   # or wherever you want it
sudo git clone https://github.com/Jordomav/cabin-monitor.git
sudo chown -R $USER:$USER cabin-monitor
cd cabin-monitor

# Server deps
cd monitor/server && npm install

# Client deps + production build (Vite outputs into ../server/public)
cd ../client && npm install && npm run build
```

---

## 3. Production `.env`

`monitor/server/.env` is gitignored. Create it on the droplet:

```bash
cd /opt/cabin-monitor/monitor/server
cp .env.example .env
```

Fill `.env` with **fresh production values** — do not reuse dev keys:

```bash
# Used by central.lua's HTTP POST/poll. Must match WEB_API_KEY in startup.lua.
API_KEY=$(openssl rand -hex 24)

# Dashboard login password — pick something memorable but strong.
DASHBOARD_PASSWORD=<your-real-password>

# Express session cookie signing key.
SESSION_SECRET=$(openssl rand -hex 32)

PORT=3000

# VAPID keys for Web Push — generate once on the droplet.
VAPID_EMAIL=<your-email>
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

Generate the VAPID keypair:

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Paste the two values into `.env`. **Don't commit them anywhere.**

> The `API_KEY` value goes into the CC central computer's `startup.lua` later
> (step 8). Note it down somewhere safe.

---

## 4. Start the server with PM2

```bash
cd /opt/cabin-monitor/monitor/server
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # follow the printed sudo command to enable auto-start on boot
```

Smoke test (localhost):

```bash
curl -s http://127.0.0.1:3000/
# -> serves the Vue index.html
curl -s -X POST http://127.0.0.1:3000/update \
  -H "X-API-Key: <your API_KEY>" -H "Content-Type: application/json" \
  -d '{"power":{"state":"NORMAL","ratio":0},"farms":{},"alerts":[]}'
# -> {"ok":true}
```

Logs: `pm2 logs cabin-monitor`. Any `[update] auth failed` or `[push] send failed`
lines come from `server.js`'s deliberate error logging.

---

## 5. Firewall

The Node server **must not** be exposed directly — Nginx fronts it. Only
allow 22 (SSH), 80, and 443:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
sudo ufw status
```

Do NOT `ufw allow 3000` — that port is for loopback only.

---

## 6. Nginx reverse proxy

```bash
sudo apt-get install -y nginx
sudo cp /opt/cabin-monitor/monitor/server/nginx/cabin-monitor.conf \
        /etc/nginx/sites-available/cabin-monitor
```

Edit `/etc/nginx/sites-available/cabin-monitor` — replace **every** occurrence
of `<YOUR_DOMAIN>` with your real domain (e.g. `cabin.example.com`).

Add the WebSocket `map` block to `/etc/nginx/nginx.conf` inside the existing
`http { ... }` block (only needs to be defined once globally — newer Nginx
versions accept it at the server level, but http-level is portable):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

(The bundled config file has this map at the bottom; if Nginx complains, move
it into `nginx.conf` and delete it from the site file.)

Enable + reload:

```bash
sudo ln -s /etc/nginx/sites-available/cabin-monitor /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

At this point `http://<YOUR_DOMAIN>/` should serve the dashboard (which
immediately redirects to https — see next step).

---

## 7. HTTPS with Let's Encrypt (certbot)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <YOUR_DOMAIN>
```

Certbot rewrites the Nginx config in place to add real `ssl_certificate` paths.
Renewals are automatic via the `certbot.timer` systemd unit; verify with
`sudo systemctl list-timers | grep certbot`.

Confirm: `https://<YOUR_DOMAIN>/` loads, login works (`DASHBOARD_PASSWORD`),
WebSocket connects (Header shows 🟢 Live).

---

## 8. CC:Tweaked side — the Minecraft world

### 8a. Allow the loopback Node server in `computercraft-server.toml`

This file lives in **the world save**, not the modpack defaults:

```
<MC server>/world/serverconfig/computercraft-server.toml
```

The default `$private` deny blocks loopback. Add an allow rule **above** it:

```toml
    [[http.rules]]
        host = "127.0.0.1"
        port = 3000
        action = "allow"

    [[http.rules]]
        host = "$private"
        action = "deny"

    [[http.rules]]
        host = "*"
        action = "allow"
        ...
```

Save and **restart the MC server** (serverconfig is loaded once at world load).

### 8b. Place and configure the central computer

Build per `docs/CABIN_Base_Monitor_TRD.md` / the "central setup" instructions —
Advanced Computer, wireless modem (right), optional Advanced Monitor (top),
Wired Modem + Networking Cable → Stressometer for power readings.

```
> wget https://raw.githubusercontent.com/Jordomav/cabin-monitor/main/minecraft/installer.lua installer.lua
> installer
# Option 1 — Central
> edit startup.lua
```

In `startup.lua`, set:

```lua
local WEB_SERVER_URL = "http://127.0.0.1:3000"
local WEB_API_KEY    = "<the API_KEY you put in monitor/server/.env>"
```

Save (Ctrl+S → Ctrl+E), then `reboot`.

Watch boot output for `Loaded 18 farms from farms.json` and a `Power peripheral:`
line. The dashboard's PowerCard should populate within 3 seconds.

### 8c. Place each farm computer

For every farm:

1. Advanced Computer + Wireless/Ender Modem (right) + Vault (left) + Redstone-out (bottom). (Or whatever sides you want — adjust `farms.json` accordingly.)
2. `wget …/installer.lua installer.lua` → `installer` → **Option 2** (Farm)
3. It prints `This computer's ID: N`. Note `N`.
4. Locally on your dev machine, edit `minecraft/farms.json`: set that farm's
   `computer_id` to `N`. Verify `monitor_side` / `vault_side` / `modem_side` /
   `redstone_side` match the physical setup.
5. Commit + push to `Jordomav/cabin-monitor`:
   ```bash
   git add minecraft/farms.json && git commit -m "set wood farm computer_id=N" && git push
   ```
6. On the in-world farm computer: `reboot`. It re-fetches `farms.json` from
   GitHub, finds its own ID, and starts reporting.
7. Within ~5 seconds the farm appears in the right wing on the dashboard.

### 8d. Sanity-check the full loop

- Farm card shows live `fill %` and badge (`RUNNING`/`PAUSED`/`OVERRIDE`).
- Hit **Pause** in the dashboard → next central poll (~3s) → farm's redstone
  flips → badge becomes `OVERRIDE`. Clear Override reverts.
- Open ⚙️ → Enable Notifications → push permission prompt → grant. Drop a
  vault past 98% (or wait for a power state transition) to confirm a real
  push arrives on your device.

---

## 9. Updates

```bash
# On the droplet:
cd /opt/cabin-monitor
git pull
cd monitor/client && npm install && npm run build
cd ../server && npm install
pm2 restart cabin-monitor          # picks up farms.json edits too (server loads it at startup)
```

If you only changed `farms.json`, push it and on each affected CC computer run
`reboot` — they re-fetch from GitHub.

---

## 10. Troubleshooting (the gotchas I actually hit during dev)

| Symptom | Cause | Fix |
|---|---|---|
| Central runs but dashboard never updates | `computercraft-server.toml` not allowing the host (esp. `$private` blocking loopback) | Add allow rule **above** `$private`, restart the MC world |
| `Domain not permitted` from `http.get` in CC | Same as above | Same |
| Edited toml but no change | You edited the modpack **default**, not the world's `serverconfig/` copy | Edit `<world>/serverconfig/computercraft-server.toml` |
| Dashboard 401 on login | `DASHBOARD_PASSWORD` mismatch | Re-check `.env`; `pm2 restart cabin-monitor` |
| `[update] auth failed` lines in PM2 logs | `WEB_API_KEY` in central's `startup.lua` doesn't match `API_KEY` in `.env` | Edit `startup.lua` on central; reboot |
| Push enabled but no notifications arrive | macOS / browser OS-level notification permission off | System Settings → Notifications → Chrome → Allow |
| Push works once then stops | Service Worker `tag` collapse without `renotify` (already fixed) | n/a |
| Farm reports never reach central | Farm's `os.getComputerID()` doesn't match its `computer_id` in `farms.json`, OR modem not in rednet range | `print(os.getComputerID())` on the farm, update `farms.json`, push, reboot |
| Power reads 50% / 1 SU | Stale state from an old test POST (server hasn't received a real one since) | Verify central is running (`startup` on it); check PM2 logs for posts arriving |
