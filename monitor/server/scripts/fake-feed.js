// Dev-only: feed the dashboard with believable fake data.
//
//   node scripts/fake-feed.js          # loop, new payload every 3s
//   node scripts/fake-feed.js once     # single payload then exit
//
// Posts to the running server's /update (same contract as central.lua).
// Exercises every visual state: NORMAL/WARNING/CRITICAL power, and farms that
// are running / paused / override / offline / vault-full.

require('dotenv').config()
const fs = require('fs')
const path = require('path')

const URL = `http://localhost:${process.env.PORT || 3000}/update`
const API_KEY = process.env.API_KEY || 'dev-cabin-api-key'
const ONCE = process.argv[2] === 'once'

const cfg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../minecraft/farms.json'), 'utf8')
)

// Deterministic-ish per-farm "personality" so it looks coherent across ticks.
const offline = new Set(['granite'])
const overridden = new Set(['sand'])
const paused = new Set(['gravel'])

let tick = 0
const POWER_CYCLE = ['NORMAL', 'NORMAL', 'WARNING', 'CRITICAL', 'WARNING']

function buildPayload() {
  tick++
  const state = POWER_CYCLE[tick % POWER_CYCLE.length]
  const ratio =
    state === 'CRITICAL' ? 0.94 : state === 'WARNING' ? 0.81 : 0.55 + Math.random() * 0.15
  const generation = 50000
  const consumption = Math.round(generation * ratio)

  const farms = {}
  for (const f of cfg.farms) {
    if (offline.has(f.id)) {
      farms[f.id] = { fill: 0, running: false, override: false, online: false }
      continue
    }
    // fill drifts up and down a little each tick
    const base = (f.id.length * 13 + tick * 7) % 100
    const fill = f.id === 'cobble' ? 97 : Math.max(2, Math.min(99, base))
    farms[f.id] = {
      fill,
      running: !paused.has(f.id),
      override: overridden.has(f.id),
      online: true
    }
  }

  const alerts = [
    { message: 'cobble vault nearly full', level: 'WARN', time: tick },
    { message: 'System startup', level: 'INFO', time: 0 }
  ]
  if (state === 'CRITICAL') {
    alerts.unshift({ message: 'Power CRITICAL — load 94%', level: 'CRIT', time: tick })
  }

  return { timestamp: Date.now(), power: { generation, consumption, ratio, state }, farms, alerts }
}

async function send() {
  const payload = buildPayload()
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify(payload)
    })
    console.log(
      `tick ${tick}: ${res.status} — power ${payload.power.state} ${Math.round(
        payload.power.ratio * 100
      )}%`
    )
  } catch (err) {
    console.error('post failed:', err.message, '(is the server running?)')
  }
}

;(async () => {
  await send()
  if (!ONCE) setInterval(send, 3000)
})()
