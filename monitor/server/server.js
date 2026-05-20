// CABIN Base Monitor — server
// state ingest (/update), command queue, session auth, WebSocket, farms config,
// and Web Push notifications + alert detection (Milestone 5).

require('dotenv').config()
const http = require('http')
const path = require('path')
const fs = require('fs')
const express = require('express')
const session = require('express-session')
const { WebSocketServer, WebSocket } = require('ws')
const webpush = require('web-push')
const rateLimit = require('express-rate-limit')

// VAPID is optional — without keys the server still runs, push is just disabled.
const PUSH_ENABLED = Boolean(
  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
)
if (PUSH_ENABLED) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL || 'admin@example.com'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  )
} else {
  console.warn('VAPID keys not set — push notifications disabled')
}

const app = express()
app.use(express.json({ limit: '256kb' }))

// Shared session middleware — reused for both HTTP routes and the WS upgrade
// handshake so the WebSocket can be gated behind the same login.
const sessionParser = session({
  secret: process.env.SESSION_SECRET || 'dev-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
})
app.use(sessionParser)

// --- In-memory state -------------------------------------------------------
let latestState = null
let previousState = null
const pendingCommands = []
const wsClients = new Set()
// Each entry: { subscription, prefs } — prefs maps alert type -> boolean.
const pushSubscriptions = []

// --- Auth middleware -------------------------------------------------------
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

// --- Auth routes -----------------------------------------------------------
app.post('/auth/login', (req, res) => {
  if (req.body.password && req.body.password === process.env.DASHBOARD_PASSWORD) {
    req.session.authenticated = true
    return res.json({ ok: true })
  }
  res.status(401).json({ error: 'Invalid password' })
})

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }))
})

// Log only auth failures on /update — useful when central.lua can't reach the
// server (wrong API key, mis-set on the CC side).
app.post('/update', (req, res, next) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    console.warn(`[update] auth failed from ${req.ip}`)
  }
  next()
})

// Rate-limit /update — central.lua posts every ~3s (= 20/min). 60/min/IP gives
// 3× headroom and still rejects an obvious flood.
const updateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
})

// --- CC:Tweaked ingest -----------------------------------------------------
app.post('/update', updateLimiter, requireApiKey, (req, res) => {
  previousState = latestState
  latestState = req.body
  latestState.receivedAt = Date.now()

  const message = JSON.stringify(latestState)
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message)
  })

  checkForAlerts(latestState, previousState)
  res.json({ ok: true })
})

app.get('/commands', requireApiKey, (req, res) => {
  const commands = [...pendingCommands]
  pendingCommands.length = 0
  res.json(commands)
})

// Command queue endpoint — dashboard → queue → CC:Tweaked polls /commands.
const FARM_COMMANDS = ['farm_override_on', 'farm_override_off', 'farm_clear_override']
const VALID_COMMANDS = [...FARM_COMMANDS, 'shutdown_all', 'resume_all', 'shutdown_priority']

app.post('/command', requireAuth, (req, res) => {
  const { type, farm, tier } = req.body

  if (!VALID_COMMANDS.includes(type)) {
    return res.status(400).json({ error: 'Invalid command type' })
  }
  if (FARM_COMMANDS.includes(type) && !farm) {
    return res.status(400).json({ error: 'farm is required for this command' })
  }
  if (type === 'shutdown_priority' && !(Number.isInteger(tier) && tier >= 1 && tier <= 4)) {
    return res.status(400).json({ error: 'tier must be an integer 1–4' })
  }

  pendingCommands.push({
    id: Date.now(),
    type,
    farm: FARM_COMMANDS.includes(type) ? farm : null,
    tier: type === 'shutdown_priority' ? tier : null,
    timestamp: Date.now()
  })
  res.json({ ok: true })
})

// --- Dashboard API ---------------------------------------------------------
app.get('/api/status', requireAuth, (req, res) => {
  res.json(latestState || {})
})

// Farm config — single source of truth, read from the repo (minecraft/farms.json).
// Loaded once at startup; `pm2 restart` after a git pull picks up edits.
let farmsConfig = null
function loadFarmsConfig() {
  try {
    const p = path.join(__dirname, '../../minecraft/farms.json')
    farmsConfig = JSON.parse(fs.readFileSync(p, 'utf8'))
    console.log('Loaded farms config:', farmsConfig.farms.length, 'farms')
  } catch (err) {
    console.error('Could not load farms.json:', err.message)
  }
}
loadFarmsConfig()

app.get('/api/farms-config', requireAuth, (req, res) => {
  if (!farmsConfig) return res.status(500).json({ error: 'farms.json not loaded' })
  res.json(farmsConfig)
})

// --- Web Push --------------------------------------------------------------
// Client needs the public key to build a subscription.
app.get('/push/public-key', requireAuth, (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null, enabled: PUSH_ENABLED })
})

// Register or replace a subscription (keyed by endpoint). `prefs` is an
// optional map of alertType -> boolean for per-device filtering.
app.post('/push/subscribe', requireAuth, (req, res) => {
  const { subscription, prefs } = req.body || {}
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'subscription with endpoint required' })
  }
  const idx = pushSubscriptions.findIndex(
    (s) => s.subscription.endpoint === subscription.endpoint
  )
  const entry = { subscription, prefs: prefs || {} }
  if (idx > -1) pushSubscriptions[idx] = entry
  else pushSubscriptions.push(entry)
  res.json({ ok: true })
})

app.delete('/push/subscribe', requireAuth, (req, res) => {
  const endpoint = req.body && req.body.endpoint
  const idx = pushSubscriptions.findIndex(
    (s) => s.subscription.endpoint === endpoint
  )
  if (idx > -1) pushSubscriptions.splice(idx, 1)
  res.json({ ok: true })
})

// Send to every subscription that hasn't disabled this alert type.
// Prunes subscriptions the push service reports as gone (404/410).
async function sendPushNotification(type, title, body, data = {}, actions = []) {
  if (!PUSH_ENABLED) return
  const payload = JSON.stringify({
    title,
    body,
    icon: '/icon-192.png',
    badge: '/icon-badge.png',
    data: { ...data, type },
    actions
  })
  for (let i = pushSubscriptions.length - 1; i >= 0; i--) {
    const { subscription, prefs } = pushSubscriptions[i]
    if (prefs && prefs[type] === false) continue
    try {
      await webpush.sendNotification(subscription, payload)
    } catch (err) {
      console.error(`[push] send failed (${err.statusCode || '?'}): ${err.body || err.message}`)
      if (err.statusCode === 404 || err.statusCode === 410) {
        pushSubscriptions.splice(i, 1)
      }
    }
  }
}

// Friendly label from farms.json, falling back to the raw id.
function farmLabel(id) {
  const f = farmsConfig && farmsConfig.farms.find((x) => x.id === id)
  return (f && f.label) || id
}

// Compare new vs previous state. No timestamp math — offline is driven by
// central.lua's own `online` boolean. No train alerts (deferred to V2).
function checkForAlerts(newState, oldState) {
  if (!newState || !oldState) return

  // Power state transitions
  const ns = newState.power && newState.power.state
  const os = oldState.power && oldState.power.state
  if (ns && ns !== os) {
    if (ns === 'CRITICAL') {
      sendPushNotification(
        'power',
        '⚡ CRITICAL Power Alert',
        'Base power critically strained.',
        { state: 'critical' },
        [
          { action: 'shutdown_low', title: 'Shutdown Low Priority' },
          { action: 'open_dashboard', title: 'Open Dashboard' }
        ]
      )
    } else if (ns === 'WARNING') {
      sendPushNotification(
        'power',
        '⚠️ Power Warning',
        'Base power under strain.',
        { state: 'warning' },
        [{ action: 'open_dashboard', title: 'View Dashboard' }]
      )
    } else if (ns === 'NORMAL' && os) {
      sendPushNotification('power', '✅ Power Restored', 'Base power back to normal.', {
        state: 'normal'
      })
    }
  }

  const newFarms = newState.farms || {}
  const oldFarms = oldState.farms || {}

  // Farm went offline (online true -> false)
  for (const [id, s] of Object.entries(newFarms)) {
    const o = oldFarms[id]
    if (o && o.online === true && s.online === false) {
      sendPushNotification(
        'farm_offline',
        '🔴 Farm Offline',
        farmLabel(id) + ' has gone offline unexpectedly.',
        { farm: id },
        [{ action: 'open_dashboard', title: 'View Dashboard' }]
      )
    }
  }

  // Vault crossed 98% full
  for (const [id, s] of Object.entries(newFarms)) {
    const o = oldFarms[id]
    if (typeof s.fill === 'number' && s.fill >= 98 && (!o || o.fill < 98)) {
      sendPushNotification('vault_full', '📦 Vault Full', farmLabel(id) + ' vault is full.', {
        farm: id
      })
    }
  }
}

// --- Static client (Vue build output) -------------------------------------
const clientDir = path.join(__dirname, 'public')
app.use(express.static(clientDir))
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'))
})

// Global error handler — keeps the server alive on bad payloads, malformed
// JSON, or thrown handlers. Logs the cause; never exposes stacks to clients.
// Must be last (4-arg signature is what marks it as an error handler).
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' })
  }
  console.error(`[server] ${req.method} ${req.path}:`, err.message)
  if (res.headersSent) return next(err)
  res.status(500).json({ error: 'Server error' })
})

// Last-resort crash guards — never let the process die from a stray async
// rejection or thrown error somewhere outside an Express handler.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err))
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err))

// --- HTTP + WebSocket on a single port ------------------------------------
const server = http.createServer(app)

// noServer mode: we run the session parser during the HTTP upgrade and only
// complete the WebSocket handshake for authenticated sessions.
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  sessionParser(req, {}, () => {
    if (!req.session || !req.session.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req)
    })
  })
})

wss.on('connection', ws => {
  wsClients.add(ws)
  if (latestState) ws.send(JSON.stringify(latestState))
  ws.on('close', () => wsClients.delete(ws))
  ws.on('error', () => wsClients.delete(ws))
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log('CABIN Monitor running on port ' + PORT))
