// CABIN Base Monitor — farm data-access layer. All SQL lives here so routes
// and alert code never touch the DB directly. assembleConfig() rebuilds the
// exact farms.json shape every consumer already expects (dashboard via
// /api/farms-config, CC computers via /config). See SQLITE_MIGRATION_PLAN.md.

const { db, PRIORITY_LABELS } = require('./db')

// Column list emitted in the config payload — deliberately excludes sort_order
// so the output matches the original farms.json field set.
const FARM_COLS =
  'id, label, computer_id, priority, high_threshold, low_threshold, ' +
  'monitor_side, vault_side, modem_side, redstone_side, wing, color, report_interval'

const stmt = {
  wings: db.prepare('SELECT id, label, color FROM wings ORDER BY sort_order, id'),
  farms: db.prepare(`SELECT ${FARM_COLS} FROM farms ORDER BY sort_order, id`),
  farm: db.prepare(`SELECT ${FARM_COLS} FROM farms WHERE id = ?`),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
}

function listWings() {
  return stmt.wings.all()
}

function listFarms() {
  return stmt.farms.all()
}

function getFarm(id) {
  return stmt.farm.get(id) || null
}

function getSetting(key) {
  const row = stmt.getSetting.get(key)
  return row ? row.value : null
}

function setSetting(key, value) {
  stmt.setSetting.run(key, String(value))
  invalidate()
}

function centralComputerId() {
  return Number(getSetting('central_computer_id') ?? 0)
}

// Assembled config is cached and rebuilt lazily; any write calls invalidate()
// so the next read reflects it. Reads are hot (dashboard + every CC poll).
let cache = null

function assembleConfig() {
  if (cache) return cache
  cache = {
    central_computer_id: centralComputerId(),
    priority_labels: PRIORITY_LABELS,
    wings: listWings(),
    farms: listFarms()
  }
  return cache
}

function invalidate() {
  cache = null
}

module.exports = {
  listWings,
  listFarms,
  getFarm,
  getSetting,
  setSetting,
  centralComputerId,
  assembleConfig,
  invalidate
}
