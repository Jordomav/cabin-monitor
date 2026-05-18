// CABIN Base Monitor — server skeleton (Milestone 1)
// Scope: state ingest (/update), command queue (/commands, /command stub),
// session auth, status snapshot, placeholder static page, authenticated WebSocket.
// Push notifications and alert detection arrive in Milestone 5.

require('dotenv').config()
const http = require('http')
const path = require('path')
const express = require('express')
const session = require('express-session')
const { WebSocketServer, WebSocket } = require('ws')

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

// --- CC:Tweaked ingest -----------------------------------------------------
app.post('/update', requireApiKey, (req, res) => {
  previousState = latestState
  latestState = req.body
  latestState.receivedAt = Date.now()

  const message = JSON.stringify(latestState)
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message)
  })

  // checkForAlerts(latestState, previousState) — implemented in Milestone 5
  res.json({ ok: true })
})

app.get('/commands', requireApiKey, (req, res) => {
  const commands = [...pendingCommands]
  pendingCommands.length = 0
  res.json(commands)
})

// Command queue endpoint — full validation lands in Milestone 4. Stubbed here
// so the queue round-trips end to end for the skeleton.
app.post('/command', requireAuth, (req, res) => {
  const { type, farm, tier } = req.body
  if (!type) return res.status(400).json({ error: 'Missing command type' })
  pendingCommands.push({
    id: Date.now(),
    type,
    farm: farm || null,
    tier: tier || null,
    timestamp: Date.now()
  })
  res.json({ ok: true })
})

// --- Dashboard API ---------------------------------------------------------
app.get('/api/status', requireAuth, (req, res) => {
  res.json(latestState || {})
})

// --- Static placeholder client --------------------------------------------
const clientDir = path.join(__dirname, 'public')
app.use(express.static(clientDir))
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'))
})

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
