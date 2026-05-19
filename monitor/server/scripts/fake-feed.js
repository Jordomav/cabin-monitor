// Dev-only: feed the dashboard with believable fake data.
//
//   node scripts/fake-feed.js          # loop, new payload every 3s
//   node scripts/fake-feed.js once     # single payload then exit
//
// Posts to the running server's /update (same contract as central.lua).
// Deterministically exercises every visual + notification state:
//   - power cycles NORMAL/WARNING/CRITICAL
//   - `granite` is permanently offline
//   - `copper` cycles online -> OFFLINE every ~12 ticks (fires farm_offline)
//   - `iron` fill jumps 55% -> 99% every ~12 ticks (fires vault_full)
//   - `sand` overridden, `gravel` paused

require('dotenv').config()
const fs = require('fs')
const path = require('path')

const URL = `http://localhost:${process.env.PORT || 3000}/update`
const API_KEY = process.env.API_KEY || 'dev-cabin-api-key'
const ONCE = process.argv[2] === 'once'

const cfg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../minecraft/farms.json'), 'utf8')
)

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
  const phase = tick % 12 // 12-tick (~36s) demo cycle

  const farms = {}
  for (const f of cfg.farms) {
    if (f.id === 'granite') {
      farms[f.id] = { fill: 0, running: false, override: false, online: false }
    } else if (f.id === 'copper') {
      // online ticks 0..7, offline 8..11 -> online->offline transition each cycle
      const online = phase < 8
      farms[f.id] = online
        ? { fill: 40 + phase * 4, running: true, override: false, online: true }
        : { fill: 0, running: false, override: false, online: false }
    } else if (f.id === 'iron') {
      // 55% for half the cycle, then 99% -> crosses the 98% vault threshold
      farms[f.id] = {
        fill: phase < 6 ? 55 : 99,
        running: phase < 6,
        override: false,
        online: true
      }
    } else {
      // generic drift, capped under 98 so only `iron` triggers vault_full
      const base = (f.id.length * 13 + tick * 7) % 96
      farms[f.id] = {
        fill: f.id === 'cobble' ? 95 : Math.max(2, base),
        running: !paused.has(f.id),
        override: overridden.has(f.id),
        online: true
      }
    }
  }

  const alerts = [
    { message: 'iron vault filling', level: 'WARN', time: tick },
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
    const c = payload.farms.copper.online ? 'copper:on' : 'copper:OFF'
    console.log(
      `tick ${tick}: ${res.status} — power ${payload.power.state}, ${c}, iron ${payload.farms.iron.fill}%`
    )
  } catch (err) {
    console.error('post failed:', err.message, '(is the server running?)')
  }
}

;(async () => {
  await send()
  if (!ONCE) setInterval(send, 3000)
})()
