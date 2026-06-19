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

// Writable farm columns (everything except the id primary key), in insert order.
const FARM_WRITE_COLS = [
  'label', 'computer_id', 'priority', 'high_threshold', 'low_threshold',
  'monitor_side', 'vault_side', 'modem_side', 'redstone_side', 'wing',
  'color', 'report_interval'
]

const stmt = {
  wings: db.prepare('SELECT id, label, color FROM wings ORDER BY sort_order, id'),
  wing: db.prepare('SELECT id, label, color FROM wings WHERE id = ?'),
  farms: db.prepare(`SELECT ${FARM_COLS} FROM farms ORDER BY sort_order, id`),
  farm: db.prepare(`SELECT ${FARM_COLS} FROM farms WHERE id = ?`),
  farmByComputerId: db.prepare(`SELECT ${FARM_COLS} FROM farms WHERE computer_id = ?`),
  nextFarmSort: db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM farms'),
  insertFarm: db.prepare(`
    INSERT INTO farms (id, ${FARM_WRITE_COLS.join(', ')}, sort_order)
    VALUES (@id, ${FARM_WRITE_COLS.map((c) => '@' + c).join(', ')}, @sort_order)
  `),
  updateFarm: db.prepare(`
    UPDATE farms SET ${FARM_WRITE_COLS.map((c) => `${c} = @${c}`).join(', ')}
    WHERE id = @id
  `),
  deleteFarm: db.prepare('DELETE FROM farms WHERE id = ?'),
  farmsInWing: db.prepare('SELECT COUNT(*) AS n FROM farms WHERE wing = ?'),
  nextWingSort: db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM wings'),
  insertWing: db.prepare(
    'INSERT INTO wings (id, label, color, sort_order) VALUES (@id, @label, @color, @sort_order)'
  ),
  updateWing: db.prepare('UPDATE wings SET label = @label, color = @color WHERE id = @id'),
  deleteWing: db.prepare('DELETE FROM wings WHERE id = ?'),
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

function getFarmByComputerId(computerId) {
  return stmt.farmByComputerId.get(computerId) || null
}

function getWing(id) {
  return stmt.wing.get(id) || null
}

function farmCountInWing(id) {
  return stmt.farmsInWing.get(id).n
}

// --- Writes (all invalidate the assembleConfig cache) ----------------------

function createFarm(value) {
  stmt.insertFarm.run({ ...value, sort_order: stmt.nextFarmSort.get().n })
  invalidate()
  return getFarm(value.id)
}

function updateFarm(id, value) {
  stmt.updateFarm.run({ ...value, id })
  invalidate()
  return getFarm(id)
}

function deleteFarm(id) {
  const changes = stmt.deleteFarm.run(id).changes
  invalidate()
  return changes > 0
}

function createWing(value) {
  stmt.insertWing.run({
    id: value.id,
    label: value.label,
    color: value.color ?? null,
    sort_order: stmt.nextWingSort.get().n
  })
  invalidate()
  return getWing(value.id)
}

function updateWing(id, value) {
  stmt.updateWing.run({ id, label: value.label, color: value.color ?? null })
  invalidate()
  return getWing(id)
}

function deleteWing(id) {
  const changes = stmt.deleteWing.run(id).changes
  invalidate()
  return changes > 0
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
  getFarmByComputerId,
  getWing,
  farmCountInWing,
  createFarm,
  updateFarm,
  deleteFarm,
  createWing,
  updateWing,
  deleteWing,
  getSetting,
  setSetting,
  centralComputerId,
  assembleConfig,
  invalidate
}
