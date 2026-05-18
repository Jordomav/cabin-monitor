# Technical Requirements Document
## CABIN Base Monitor — Web Dashboard + Remote Control

### Overview
A real time web dashboard accessible from any device (phone, desktop, tablet) that displays the status of all farms, power systems and trains in the CABIN Minecraft base. Supports remote control of farms and push notifications for alerts — even when the dashboard tab is closed.

Data flows:
```
[Minecraft CC:Tweaked Computers]
        ↓ HTTP POST every 5 seconds
[Node.js Server on Digital Ocean]
        ↓ WebSocket (real time updates)
        ↓ Web Push API (background notifications)
[Browser Dashboard — Phone/Desktop]
        ↓ HTTP POST (remote commands)
[Node.js Server]
        ↓ command queue
[CC:Tweaked central computer polls]
        ↓ forwards commands to farm computers
[Farm computers execute commands]
```

---

## System Components

### 1. CC:Tweaked Reporter + Command Poller (Minecraft side)
### 2. Node.js Server (Digital Ocean)
### 3. Vue 3 Dashboard (Browser)

---

## Component 1 — CC:Tweaked Integration

### 1.1 Data Reporting

The existing central.lua script (which aggregates all farm status) adds an HTTP POST to the Node.js server every update cycle (every 2-5 seconds).

**JSON payload schema:**
```json
{
  "timestamp": 1234567890,
  "power": {
    "generation": 50000,
    "consumption": 35000,
    "ratio": 0.70,
    "state": "NORMAL"
  },
  "farms": {
    "wood": {
      "fill": 45,
      "running": true,
      "override": false,
      "online": true,
      "lastSeen": 1234567885
    },
    "iron": {
      "fill": 78,
      "running": true,
      "override": false,
      "online": true,
      "lastSeen": 1234567883
    }
  },
  "alerts": [
    {
      "message": "System startup",
      "level": "INFO",
      "time": 1234567800
    }
  ],
  "trains": {
    "oil_tanker": {
      "status": "in_transit",
      "lastSeen": 1234567880
    },
    "ore_train": {
      "status": "loading",
      "lastSeen": 1234567879
    },
    "supply_train": {
      "status": "unloading",
      "lastSeen": 1234567878
    }
  }
}
```

**Addition to central.lua:**
```lua
-- Configuration additions
local WEB_SERVER_URL = "http://your-droplet-ip:3000"
local WEB_API_KEY = "your-secret-key"

-- Post state to web server
local function postToWebServer()
  local payload = {
    timestamp = os.epoch("utc"),
    power = powerStatus,
    farms = farmStatus,
    alerts = alerts,
    trains = trainStatus
  }

  http.request({
    url = WEB_SERVER_URL .. "/update",
    method = "POST",
    headers = {
      ["Content-Type"] = "application/json",
      ["X-API-Key"] = WEB_API_KEY
    },
    body = textutils.serializeJSON(payload)
  })
end

-- Poll for commands from web server
local function checkForCommands()
  local response = http.get({
    url = WEB_SERVER_URL .. "/commands",
    headers = { ["X-API-Key"] = WEB_API_KEY }
  })

  if response then
    local data = textutils.unserialiseJSON(response.readAll())
    response.close()

    if data and #data > 0 then
      for _, cmd in ipairs(data) do
        if cmd.type == "farm_override_on" then
          sendCommand(cmd.farm, "override_on")
        elseif cmd.type == "farm_override_off" then
          sendCommand(cmd.farm, "override_off")
        elseif cmd.type == "farm_clear_override" then
          sendCommand(cmd.farm, "clear_override")
        elseif cmd.type == "shutdown_all" then
          for farm, _ in pairs(FARM_IDS) do
            sendCommand(farm, "override_off")
          end
        elseif cmd.type == "resume_all" then
          for farm, _ in pairs(FARM_IDS) do
            sendCommand(farm, "clear_override")
          end
        elseif cmd.type == "shutdown_priority" then
          for farm, priority in pairs(FARM_PRIORITIES) do
            if priority >= cmd.tier then
              sendCommand(farm, "override_off")
            end
          end
        end
      end
    end
  end
end
```

**Call both functions in the main loop every update cycle.**

### 1.2 CC:Tweaked Server Config Requirement

HTTP must be enabled in CABIN's server config at `serverconfig/computercraft-server.toml`:
```toml
[http]
  enabled = true
  rules = [
    {host = "your-droplet-ip", action = "allow"},
    {host = "*", action = "deny"}
  ]
```

---

## Component 2 — Node.js Server

### 2.1 Tech Stack
- **Runtime:** Node.js 20.x
- **Framework:** Express
- **WebSocket:** ws library
- **Push notifications:** web-push library
- **Process manager:** PM2
- **Environment:** Digital Ocean droplet (existing)

### 2.2 API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /update | API Key | Receives state from CC:Tweaked |
| GET | /commands | API Key | Returns pending commands, clears queue |
| POST | /command | Session | Dashboard sends command |
| POST | /push/subscribe | Session | Register push subscription |
| DELETE | /push/subscribe | Session | Unregister push subscription |
| POST | /auth/login | None | Dashboard login |
| POST | /auth/logout | Session | Dashboard logout |
| GET | /api/status | Session | Current state snapshot |
| GET | / | Session | Serve Vue dashboard |
| WS | /ws | Session | Real time WebSocket feed — same port as HTTP, session cookie validated during the upgrade handshake |

### 2.3 Server Code

```javascript
// server.js
require('dotenv').config()
const http = require('http')
const path = require('path')
const express = require('express')
const session = require('express-session')
const { WebSocketServer, WebSocket } = require('ws')
const webpush = require('web-push') // configured in Milestone 5

const app = express()
app.use(express.json({ limit: '256kb' }))

// Shared session middleware — reused for both HTTP routes and the WebSocket
// upgrade handshake so the WS feed is gated behind the same login.
const sessionParser = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
})
app.use(sessionParser)

// VAPID setup for push notifications
webpush.setVapidDetails(
  'mailto:' + process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
)

// State
let latestState = null
let previousState = null
const pendingCommands = []
const pushSubscriptions = []
const wsClients = new Set()

// Auth middleware
const requireApiKey = (req, res, next) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

const requireAuth = (req, res, next) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  next()
}

// Auth routes
app.post('/auth/login', (req, res) => {
  if (req.body.password === process.env.DASHBOARD_PASSWORD) {
    req.session.authenticated = true
    res.json({ ok: true })
  } else {
    res.status(401).json({ error: 'Invalid password' })
  }
})

app.post('/auth/logout', (req, res) => {
  req.session.destroy()
  res.json({ ok: true })
})

// Receive state from CC:Tweaked
app.post('/update', requireApiKey, (req, res) => {
  previousState = latestState
  latestState = req.body
  latestState.receivedAt = Date.now()

  // Broadcast to all WebSocket clients
  const message = JSON.stringify(latestState)
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })

  // Check for alert conditions
  checkForAlerts(latestState, previousState)

  res.json({ ok: true })
})

// Return pending commands to CC:Tweaked
app.get('/commands', requireApiKey, (req, res) => {
  const commands = [...pendingCommands]
  pendingCommands.length = 0
  res.json(commands)
})

// Receive command from dashboard
app.post('/command', requireAuth, (req, res) => {
  const { type, farm, tier } = req.body

  const validCommands = [
    'farm_override_on',
    'farm_override_off',
    'farm_clear_override',
    'shutdown_all',
    'resume_all',
    'shutdown_priority'
  ]

  if (!validCommands.includes(type)) {
    return res.status(400).json({ error: 'Invalid command' })
  }

  pendingCommands.push({
    id: Date.now(),
    type,
    farm: farm || null,
    tier: tier || null,
    timestamp: Date.now()
  })

  res.json({ ok: true })
})

// Push subscription management
app.post('/push/subscribe', requireAuth, (req, res) => {
  const subscription = req.body
  pushSubscriptions.push(subscription)
  res.json({ ok: true })
})

app.delete('/push/subscribe', requireAuth, (req, res) => {
  const endpoint = req.body.endpoint
  const index = pushSubscriptions.findIndex(s => s.endpoint === endpoint)
  if (index > -1) pushSubscriptions.splice(index, 1)
  res.json({ ok: true })
})

// Current state snapshot
app.get('/api/status', requireAuth, (req, res) => {
  res.json(latestState || {})
})

// Serve Vue dashboard — the Vite build outputs to monitor/server/public
const clientDir = path.join(__dirname, 'public')
app.use(express.static(clientDir))
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'))
})

// HTTP + WebSocket share a single port (no separate WS_PORT).
const server = http.createServer(app)

// noServer mode: run the session parser during the HTTP upgrade and only
// complete the WebSocket handshake for authenticated sessions.
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  sessionParser(req, {}, () => {
    if (!req.session || !req.session.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })
})

wss.on('connection', ws => {
  wsClients.add(ws)

  // Send current state immediately on connect
  if (latestState) {
    ws.send(JSON.stringify(latestState))
  }

  ws.on('close', () => wsClients.delete(ws))
  ws.on('error', () => wsClients.delete(ws))
})

// Push notification sender
async function sendPushNotification(title, body, data = {}, actions = []) {
  const payload = JSON.stringify({ title, body, icon: '/icon.png', badge: '/badge.png', data, actions })

  for (let i = pushSubscriptions.length - 1; i >= 0; i--) {
    try {
      await webpush.sendNotification(pushSubscriptions[i], payload)
    } catch (error) {
      if (error.statusCode === 410) {
        pushSubscriptions.splice(i, 1) // expired, remove
      }
    }
  }
}

// Alert detection
function checkForAlerts(newState, oldState) {
  if (!oldState || !newState) return

  // Power state changes
  if (newState.power?.state !== oldState.power?.state) {
    if (newState.power.state === 'CRITICAL') {
      sendPushNotification(
        '⚡ CRITICAL Power Alert',
        'Base power critically strained. Low priority farms shutting down.',
        { type: 'power', state: 'critical' },
        [
          { action: 'shutdown_low', title: 'Shutdown Low Priority' },
          { action: 'open_dashboard', title: 'Open Dashboard' }
        ]
      )
    } else if (newState.power.state === 'WARNING') {
      sendPushNotification(
        '⚠️ Power Warning',
        'Base power under strain. Monitoring situation.',
        { type: 'power', state: 'warning' },
        [
          { action: 'open_dashboard', title: 'View Dashboard' }
        ]
      )
    } else if (oldState.power?.state !== 'NORMAL') {
      sendPushNotification(
        '✅ Power Restored',
        'Base power back to normal. All farms resuming.',
        { type: 'power', state: 'normal' }
      )
    }
  }

  // Farm goes offline
  for (const [farm, status] of Object.entries(newState.farms || {})) {
    const oldFarm = oldState.farms?.[farm]
    if (oldFarm?.online && !status.online) {
      sendPushNotification(
        '🔴 Farm Offline',
        farm + ' farm has gone offline unexpectedly.',
        { type: 'farm_offline', farm },
        [
          { action: 'open_dashboard', title: 'View Dashboard' }
        ]
      )
    }
  }

  // Vault completely full (98%+)
  for (const [farm, status] of Object.entries(newState.farms || {})) {
    const oldFarm = oldState.farms?.[farm]
    if (status.fill >= 98 && (!oldFarm || oldFarm.fill < 98)) {
      sendPushNotification(
        '📦 Vault Full',
        farm + ' vault is completely full.',
        { type: 'vault_full', farm }
      )
    }
  }

  // Train missing for 5+ minutes
  for (const [train, status] of Object.entries(newState.trains || {})) {
    if (status.lastSeen && Date.now() - status.lastSeen > 300000) {
      const oldTrain = oldState.trains?.[train]
      if (!oldTrain || Date.now() - oldTrain.lastSeen < 300000) {
        sendPushNotification(
          '🚂 Train Missing',
          train + " hasn't been seen for 5 minutes.",
          { type: 'train_missing', train },
          [
            { action: 'open_dashboard', title: 'View Dashboard' }
          ]
        )
      }
    }
  }
}

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log('CABIN Monitor running on port ' + PORT))
```

### 2.4 Environment Variables

```bash
# .env
API_KEY=your-minecraft-api-key-here
DASHBOARD_PASSWORD=your-dashboard-password-here
SESSION_SECRET=your-session-secret-here
PORT=3000

# Milestone 5 (push notifications) — not required by the skeleton
VAPID_EMAIL=your@email.com
VAPID_PUBLIC_KEY=generate-with-webpush
VAPID_PRIVATE_KEY=generate-with-webpush
```

> HTTP and WebSocket share `PORT` — there is no separate `WS_PORT`.

**Generate VAPID keys once:**
```bash
node -e "const wp = require('web-push'); const keys = wp.generateVAPIDKeys(); console.log(keys)"
```

### 2.5 Package.json Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "ws": "^8.14.0",
    "web-push": "^3.6.0",
    "express-session": "^1.17.0",
    "dotenv": "^16.0.0"
  }
}
```

### 2.6 PM2 Deployment

```bash
# Install dependencies
npm install

# Start server
pm2 start server.js --name cabin-monitor

# Auto restart on droplet reboot
pm2 startup
pm2 save
```

### 2.7 Nginx Reverse Proxy (Recommended)

```nginx
server {
  listen 80;
  server_name your-droplet-ip;

  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
  }

  # WebSocket shares the HTTP port — proxy /ws to the same upstream (3000).
  location /ws {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie; # session cookie needed for WS auth
  }
}
```

### 2.8 Firewall

```bash
sudo ufw allow 80
sudo ufw allow 3000
```

---

## Component 3 — Vue 3 Dashboard

### 3.1 Tech Stack
- **Framework:** Vue 3 (Composition API)
- **Styling:** Tailwind CSS
- **Real time:** WebSocket (native browser API)
- **Push:** Service Worker + Web Push API
- **Build:** Vite
- **State management:** Pinia

### 3.2 Mobile First Layout

```
┌─────────────────────────┐
│   CABIN BASE MONITOR    │
│   🟢 Live  2s ago       │
├─────────────────────────┤
│  ⚡ POWER    NORMAL 🟢  │
│  Load:  ████░░░░  70%   │
│  Gen:   50,000 SU       │
│  Using: 35,000 SU       │
│  [Shutdown Low] [All ▼] │
├─────────────────────────┤
│  🏭 FARMS          [▼]  │
│  🟢 wood      45% ████░ │
│     [Pause]  [Resume]   │
│  🟢 iron      78% ██████│
│     [Pause]  [Resume]   │
│  🔴 cobble    95% FULL  │
│     [Pause]  [Resume]   │
│  ⚪ granite   OFFLINE   │
│  🟠 sand      OVERRIDE  │
│     [Clear Override]    │
├─────────────────────────┤
│  🚂 TRAINS              │
│  oil_tanker  IN TRANSIT │
│  ore_train   LOADING    │
│  supply      UNLOADING  │
├─────────────────────────┤
│  🔔 ALERTS              │
│  ⚠ cobble vault full    │
│  ℹ System startup       │
├─────────────────────────┤
│  ⚙ SETTINGS  🔔 NOTIFS │
└─────────────────────────┘
```

### 3.3 Component Structure

```
client/
├── src/
│   ├── App.vue                    # Root, WebSocket connection, auth gate
│   ├── main.js                    # App entry point, Pinia setup
│   ├── stores/
│   │   ├── baseStore.js           # Farm status, power, trains, alerts state
│   │   └── authStore.js           # Authentication state
│   ├── components/
│   │   ├── LoginPage.vue          # Password entry
│   │   ├── Header.vue             # Title, connection status, last update time
│   │   ├── PowerCard.vue          # Power status, load bar, global controls
│   │   ├── FarmGrid.vue           # All farms list
│   │   ├── FarmCard.vue           # Individual farm with controls
│   │   ├── TrainStatus.vue        # Train list with status badges
│   │   ├── AlertFeed.vue          # Scrolling alert log
│   │   ├── SettingsPanel.vue      # Notification preferences
│   │   └── ConfirmModal.vue       # Safety confirmation for destructive actions
│   ├── composables/
│   │   ├── useWebSocket.js        # WebSocket connection management
│   │   └── usePushNotifications.js # Push registration and settings
│   └── utils/
│       └── api.js                 # HTTP request helpers
├── public/
│   ├── sw.js
│   ├── icon.png
│   └── badge.png
└── package.json
```

### 3.4 Key Component Specs

**App.vue**
- Uses `onMounted` to establish WebSocket connection to `/ws` on the same host/port as the dashboard (e.g. `ws://your-droplet-ip:3000/ws`)
- Auto reconnects on disconnect with exponential backoff
- Shows connection status indicator — green live, red disconnected
- Stores last received state in Pinia baseStore, updates every message
- Auth gate — shows LoginPage if not authenticated via authStore

**PowerCard.vue**
- Color coded by power state — green NORMAL, orange WARNING, red CRITICAL
- Animated progress bar showing load percentage
- Shows generation and consumption SU numbers
- Global control buttons:
  - "Shutdown Low Priority" — confirms then POSTs `shutdown_priority` with tier 4
  - "Shutdown Medium+" — confirms then POSTs `shutdown_priority` with tier 3
  - "Shutdown All" — requires confirmation with typed "CONFIRM"
  - "Resume All" — confirms then POSTs `resume_all`

**FarmCard.vue**
- Shows farm name, fill percentage, visual progress bar
- Status badge — RUNNING (green), PAUSED (red), OVERRIDE (orange), OFFLINE (gray)
- Control buttons:
  - "Pause" — confirms then POSTs `farm_override_off`
  - "Resume" — POSTs `farm_override_on`
  - "Clear Override" — POSTs `farm_clear_override` (only shown when overridden)
- Sorted by priority tier then alphabetically via computed property
- Collapsible by priority tier using Vue transition

**ConfirmModal.vue**
- Emits confirm/cancel events to parent
- Simple "Are you sure?" for single farm actions
- "Shutdown All" requires typing "CONFIRM" in a text field
- Prevents accidental taps on phone

**SettingsPanel.vue**
- Toggle push notifications on/off per alert type using v-model
- Settings stored in localStorage via composable
- "Enable Notifications" button triggers browser permission request

### 3.5 Service Worker (Push Notifications)

```javascript
// public/sw.js

self.addEventListener('push', event => {
  const data = event.data.json()

  const options = {
    body: data.body,
    icon: '/icon.png',
    badge: '/badge.png',
    data: data.data,
    actions: data.actions || [],
    requireInteraction: data.data?.type === 'power' && data.data?.state === 'critical'
    // Critical power alerts stay on screen until dismissed
  }

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()

  if (event.action === 'shutdown_low') {
    event.waitUntil(
      fetch('/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ type: 'shutdown_priority', tier: 4 })
      })
    )
  } else {
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then(clientList => {
        if (clientList.length > 0) {
          clientList[0].focus()
        } else {
          clients.openWindow('/')
        }
      })
    )
  }
})
```

### 3.6 Push Notification Types

| Alert | Title | Trigger | Actions |
|-------|-------|---------|---------|
| Power Critical | ⚡ CRITICAL Power Alert | power.state changes to CRITICAL | Shutdown Low Priority, Open Dashboard |
| Power Warning | ⚠️ Power Warning | power.state changes to WARNING | Open Dashboard |
| Power Restored | ✅ Power Restored | power.state returns to NORMAL | — |
| Farm Offline | 🔴 Farm Offline | farm.online changes to false | Open Dashboard |
| Vault Full | 📦 Vault Full | farm.fill >= 98% | — |
| Train Missing | 🚂 Train Missing | train.lastSeen > 5 minutes ago | Open Dashboard |

**Critical power notifications use `requireInteraction: true`** — they stay on screen until the user dismisses or acts on them. All other notifications auto-dismiss.

---

## Repository Structure

Monorepo — everything related to the CABIN base in one repository.

```
cabin-base/
├── README.md
├── .gitignore
├── monitor/
│   ├── server/
│   │   ├── server.js
│   │   ├── package.json
│   │   └── .env.example
│   └── client/
│       ├── src/
│       │   ├── App.vue
│       │   ├── main.js
│       │   ├── stores/
│       │   │   ├── baseStore.js
│       │   │   └── authStore.js
│       │   ├── components/
│       │   │   ├── LoginPage.vue
│       │   │   ├── Header.vue
│       │   │   ├── PowerCard.vue
│       │   │   ├── FarmGrid.vue
│       │   │   ├── FarmCard.vue
│       │   │   ├── TrainStatus.vue
│       │   │   ├── AlertFeed.vue
│       │   │   ├── SettingsPanel.vue
│       │   │   └── ConfirmModal.vue
│       │   ├── composables/
│       │   │   ├── useWebSocket.js
│       │   │   └── usePushNotifications.js
│       │   └── utils/
│       │       └── api.js
│       ├── public/
│       │   ├── sw.js
│       │   ├── icon.png
│       │   └── badge.png
│       └── package.json
└── minecraft/
    ├── central.lua
    ├── installer.lua
    └── farms/
        ├── wood.lua
        ├── iron.lua
        ├── andesite.lua
        ├── cobble.lua
        ├── gravel.lua
        ├── sand.lua
        ├── gold.lua
        ├── copper.lua
        ├── zinc.lua
        ├── granite.lua
        ├── concrete.lua
        ├── brass.lua
        ├── mechanism.lua
        ├── chapter_1.lua
        ├── chapter_2.lua
        ├── chapter_3.lua
        ├── chapter_4.lua
        └── chapter_5.lua
```

**CC:Tweaked wget from monorepo:**
```
wget https://raw.githubusercontent.com/yourusername/cabin-base/main/minecraft/farms/wood.lua startup.lua
wget https://raw.githubusercontent.com/yourusername/cabin-base/main/minecraft/installer.lua installer.lua
```

**.gitignore:**
```
monitor/server/.env
monitor/server/node_modules/
monitor/client/node_modules/
monitor/client/build/
monitor/server/public/assets/
.DS_Store
*.log
.idea/
```

---

## Deployment Checklist

### First Time Setup
```bash
# On Digital Ocean droplet

# 1. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Clone repo
git clone https://github.com/yourusername/cabin-base
cd cabin-base

# 3. Install server dependencies
cd monitor/server && npm install

# 4. Generate VAPID keys
node -e "const wp = require('web-push'); const keys = wp.generateVAPIDKeys(); console.log(JSON.stringify(keys, null, 2))"

# 5. Create .env from example
cp .env.example .env
# Edit .env with your values

# 6. Build React client
cd ../client && npm install && npm run build

# 7. Start with PM2
cd ../server
pm2 start server.js --name cabin-monitor
pm2 startup
pm2 save

# 8. Configure Nginx
sudo nano /etc/nginx/sites-available/cabin-monitor
# paste nginx config
sudo ln -s /etc/nginx/sites-available/cabin-monitor /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx

# 9. Open firewall
sudo ufw allow 80
sudo ufw allow 3000
```

### Updating
```bash
git pull
cd monitor/client && npm run build
pm2 restart cabin-monitor
```

---

## V1 Scope (Build This First)

- Real time farm status dashboard
- Power monitoring and status
- Train status display
- Alert feed
- Remote farm control (pause/resume/override)
- Global controls (shutdown all, shutdown by priority, resume all)
- Push notifications for all alert types
- Action buttons on push notifications
- Mobile responsive design
- Password authentication
- Per-device notification preferences

---

## V2 Ideas (Future)

- **Historical graphs** — SQLite to store state history, production graphs over 24 hours
- **Train map** — visual route map showing train positions
- **Production rate tracking** — track items per minute per farm over time
- **Scheduled commands** — set a farm to shut down at a specific time
- **HTTPS** — Let's Encrypt free SSL cert
- **Multiple user accounts** — different access levels for friends on the server

---

## Questions for Claude Code Before Starting

1. Verify `textutils.serializeJSON` and `textutils.unserialiseJSON` are available in the CC:Tweaked version bundled with CABIN
2. Confirm CC:Tweaked HTTP API supports custom headers for API key auth
3. Check if CORS needs to be configured for WebSocket connection from browser to Digital Ocean
4. Confirm PM2 or suggest alternative process manager given existing server setup
5. Verify web-push library is compatible with Node.js 20

---

## Notes for Claude Code

- **Client is Vue 3 with Composition API and Pinia — not React.** Use `.vue` single file components throughout. Composables replace React hooks.
- The CC:Tweaked central.lua already exists and aggregates all farm data — only additions are needed, not a rewrite
- Farm priority tiers are defined in central.lua as `FARM_PRIORITIES` table — server and dashboard should use the same tier numbering (1=critical, 2=high, 3=medium, 4=low)
- The dashboard is primarily used on a phone so mobile UX is the priority — desktop is secondary
- Destructive actions (shutdown all, shutdown farm) must have confirmation dialogs to prevent accidental taps
- Critical power notifications should use `requireInteraction: true` so they stay on screen
- The server runs on the same Digital Ocean droplet as the Minecraft server so internal localhost communication is fine between processes
- The developer maintaining this after initial build is comfortable with Vue 3 Composition API — write idiomatic Vue, not React patterns translated to Vue

---

## Development Milestones

Each milestone is a self-contained unit of work for a single Claude Code session. Each produces working committable code. Complete in order — each builds on the previous.

---

### Milestone 1 — Repo Setup and Server Skeleton
**Goal:** Working monorepo structure with a Node.js server that accepts data and serves a placeholder page.

**Scope:**
- Create monorepo folder structure
- Initialize `package.json` in `monitor/server`
- Install dependencies: express, ws, web-push, express-session, dotenv
- Implement `/update` endpoint (API key auth, stores latest state in memory)
- Implement `/commands` endpoint (API key auth, returns and clears pending commands)
- Implement `/auth/login` and `/auth/logout` endpoints
- Implement `/api/status` endpoint (session auth, returns latest state)
- Implement `/command` endpoint as a stub (session auth, queues without type validation — full validation in Milestone 4)
- Serve a placeholder `index.html` from `monitor/server/public`
- WebSocket on the **same port** as HTTP, session cookie validated during the upgrade handshake — unauthenticated upgrades rejected; broadcasts state to connected clients
- PM2 config file (`ecosystem.config.js`)
- `.env.example` with all required variables
- `.gitignore`

**Done when:** Server starts, `/update` accepts a POST with a JSON payload and returns 200, `/api/status` returns the same payload, an authenticated WebSocket client receives broadcasts and an unauthenticated upgrade is rejected with 401.

**Commit:** `feat: server skeleton with state management and WebSocket`

---

### Milestone 2 — Vue Client Scaffold and Auth
**Goal:** Vue 3 app with Vite, Tailwind, Pinia, and a working login page.

**Scope:**
- Initialize Vue 3 + Vite project in `monitor/client`
- Install and configure Tailwind CSS
- Install and configure Pinia
- Create `authStore.js` — tracks authenticated state, login/logout actions
- Create `LoginPage.vue` — password field, submit button, error message on failure
- Create `App.vue` — shows LoginPage if not authenticated, placeholder dashboard if authenticated
- Create `useWebSocket.js` composable — connects to WS, auto reconnects with backoff, updates Pinia store on message
- Create `api.js` utility — wraps fetch with session credentials and base URL
- Vite proxy config to forward `/api` and `/ws` to server in development
- Build script outputs to `monitor/server/public`

**Done when:** `npm run dev` shows login page, correct password shows placeholder dashboard, wrong password shows error.

**Commit:** `feat: Vue client scaffold with auth and WebSocket connection`

---

### Milestone 3 — Dashboard Core Display
**Goal:** Real time farm status, power status and alerts visible. Read only, no controls yet.

**Scope:**
- Create `baseStore.js` — stores farms, power, trains, alerts from WebSocket messages
- Create `Header.vue` — title, connection status indicator, time since last update
- Create `PowerCard.vue` — power state badge, load percentage bar, generation and consumption numbers, color coded. No buttons yet.
- Create `FarmGrid.vue` — renders FarmCard list sorted by priority then name
- Create `FarmCard.vue` — farm name, fill percentage, visual progress bar, status badge. No buttons yet.
- Create `TrainStatus.vue` — list of trains with status badge and last seen time
- Create `AlertFeed.vue` — scrolling list of last 5 alerts, color coded by severity
- Wire everything into `App.vue`

**Done when:** Dashboard shows live updating farm statuses, power state and alerts when the server receives POST updates. Looks good on a phone screen.

**Commit:** `feat: dashboard core display with real time farm and power status`

---

### Milestone 4 — Remote Farm Controls
**Goal:** Pause, resume and override controls working from the dashboard.

**Scope:**
- Create `ConfirmModal.vue` — reusable confirmation dialog, emits confirm/cancel. Shutdown All variant requires typing CONFIRM.
- Add control buttons to `FarmCard.vue` — Pause, Resume, Clear Override shown contextually
- Add global control buttons to `PowerCard.vue` — Shutdown Low Priority, Shutdown Medium+, Shutdown All, Resume All
- Implement POST to `/command` from button handlers via `api.js`
- Server: implement `/command` endpoint — validates command type, adds to pending queue
- Optimistic UI update — immediately reflect command in store before server confirms

**Done when:** Tapping Pause on a farm card sends the command and immediately shows OVERRIDE state. Command appears in `/commands` response on next poll.

**Commit:** `feat: remote farm controls with confirmation dialogs`

---

### Milestone 5 — Push Notifications
**Goal:** Browser push notifications working for all alert types with action buttons.

**Scope:**
- Create `public/sw.js` service worker — handles push events, shows notifications with action buttons, handles notificationclick
- Register service worker in `main.js`
- Create `usePushNotifications.js` composable — requests permission, registers subscription with server
- Create `SettingsPanel.vue` — toggles per notification type stored in localStorage
- Add settings button to `Header.vue`
- Server: configure web-push with VAPID keys
- Server: implement `/push/subscribe` POST and DELETE endpoints
- Server: implement `sendPushNotification` function
- Server: implement `checkForAlerts` comparing new vs previous state — triggers on power state changes, farm going offline, vault 98%+ full, train missing 5+ minutes
- Wire `checkForAlerts` into `/update` handler

**Done when:** Accepting notifications in browser, changing power state in a test POST triggers a push notification on device. Critical power notification stays on screen until dismissed. Tapping Shutdown Low Priority on notification sends command without opening dashboard.

**Commit:** `feat: push notifications with action buttons for all alert types`

---

### Milestone 6 — CC:Tweaked Integration
**Goal:** Lua scripts that report to the server and poll for commands. Installer for easy deployment.

**Scope:**
- Update `minecraft/central.lua` — add `postToWebServer()`, add `checkForCommands()`, call both in main loop
- Update all farm `.lua` files to load config from `config.lua` so installer-generated config works
- Create `minecraft/installer.lua` — interactive menu, downloads correct script from GitHub raw URL, saves config.lua, names script startup.lua
- Document CC:Tweaked server config requirement

**Done when:** Farm computer runs installer, selects farm type, enters config values, reboots — farm status appears live on dashboard within 5 seconds. Sending pause command from dashboard reaches CC:Tweaked within one poll cycle.

**Commit:** `feat: CC:Tweaked Lua scripts with web reporting and command polling`

---

### Milestone 7 — Polish and Deployment
**Goal:** Production ready on Digital Ocean with Nginx, PM2 and proper error handling.

**Scope:**
- Add error boundaries and loading states — handle WebSocket disconnect gracefully, show stale data indicator
- Add mobile viewport meta tags and PWA manifest so dashboard is installable on phone home screen
- Add app icons for push notifications
- Write Nginx config for reverse proxy
- Write deployment README with step by step setup instructions
- Add error handling to server — catch and log errors, never crash on bad payloads
- Add rate limiting to `/update` endpoint
- End to end test: full flow from CC:Tweaked POST → WebSocket update → push notification → command → CC:Tweaked poll

**Done when:** Dashboard accessible from phone browser on Digital Ocean IP, installable as PWA, push notifications arrive, farm controls work end to end with Minecraft running.

**Commit:** `feat: production deployment with Nginx, PWA manifest and error handling`

---

## Milestone Status Tracker

| Milestone | Status | Branch | Notes |
|-----------|--------|--------|-------|
| 1 — Server Skeleton | 🟡 Built — awaiting review/commit | `feat/m1-server-skeleton` | Session-gated WS on single port; `/command` stubbed |
| 2 — Vue Client Scaffold | ⬜ Todo | `feat/m2-vue-scaffold` | |
| 3 — Dashboard Display | ⬜ Todo | `feat/m3-dashboard-display` | |
| 4 — Farm Controls | ⬜ Todo | `feat/m4-farm-controls` | |
| 5 — Push Notifications | ⬜ Todo | `feat/m5-push-notifications` | |
| 6 — CC:Tweaked Integration | ⬜ Todo | `feat/m6-cctweaked` | |
| 7 — Polish and Deployment | ⬜ Todo | `feat/m7-deployment` | |

---

## Claude Code Session Starter Prompt

Paste this at the start of each new session, replacing N with the milestone number:

```
I'm building the CABIN Base Monitor — a web dashboard for monitoring a Minecraft base.
The full TRD is in CABIN_Base_Monitor_TRD.md in the repo root. Please read it first.

Implement Milestone N only. Do not implement anything outside that milestone's scope.

Key constraints:
- Vue 3 Composition API with Pinia — not React
- Node.js + Express + ws for the server
- Monorepo: cabin-base/monitor/server and cabin-base/monitor/client
- Mobile first design with Tailwind CSS

Repo: [your local repo path]
```
