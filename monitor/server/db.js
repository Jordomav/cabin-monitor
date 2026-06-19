// CABIN Base Monitor — SQLite connection, schema, and one-time seed.
// The DB (data/cabin.db) is the single source of truth for farm definitions,
// replacing the static minecraft/farms.json (which is now only the seed +
// a git-tracked backup). See docs/SQLITE_MIGRATION_PLAN.md.

const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'cabin.db')
const SEED_PATH = path.join(__dirname, '../../minecraft/farms.json')

// priority_labels never changes — kept as a constant, not a table. assembleConfig
// (farmsRepo) emits this verbatim so the JSON shape matches farms.json exactly.
const PRIORITY_LABELS = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wings (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  color      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS farms (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  computer_id     INTEGER NOT NULL UNIQUE,
  priority        INTEGER NOT NULL,
  high_threshold  INTEGER NOT NULL DEFAULT 90,
  low_threshold   INTEGER NOT NULL DEFAULT 50,
  monitor_side    TEXT NOT NULL DEFAULT 'top',
  vault_side      TEXT NOT NULL DEFAULT 'left',
  modem_side      TEXT NOT NULL DEFAULT 'right',
  redstone_side   TEXT NOT NULL DEFAULT 'bottom',
  wing            TEXT NOT NULL REFERENCES wings(id),
  color           TEXT,
  report_interval INTEGER NOT NULL DEFAULT 5,
  sort_order      INTEGER NOT NULL DEFAULT 0
);
`

// Validate seed data BEFORE inserting anything. computer_id is the join key
// between a DB row and a physical CC:Tweaked computer, so collisions silently
// break a farm — fail loud here instead of debugging an always-OFFLINE farm later.
function assertSeedIntegrity(data) {
  const central = data.central_computer_id
  const seen = new Map()
  for (const f of data.farms || []) {
    if (seen.has(f.computer_id)) {
      throw new Error(
        `Seed aborted: duplicate computer_id ${f.computer_id} ` +
          `(farms "${seen.get(f.computer_id)}" and "${f.id}")`
      )
    }
    if (f.computer_id === central) {
      throw new Error(
        `Seed aborted: farm "${f.id}" shares computer_id ${central} with central_computer_id`
      )
    }
    seen.set(f.computer_id, f.id)
  }
}

function seedFromJson(db) {
  let data
  try {
    data = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'))
  } catch (err) {
    console.error('Seed skipped — could not read farms.json:', err.message)
    return
  }
  assertSeedIntegrity(data)

  const insertWing = db.prepare(
    'INSERT INTO wings (id, label, color, sort_order) VALUES (?, ?, ?, ?)'
  )
  const insertFarm = db.prepare(`
    INSERT INTO farms (
      id, label, computer_id, priority, high_threshold, low_threshold,
      monitor_side, vault_side, modem_side, redstone_side, wing, color,
      report_interval, sort_order
    ) VALUES (
      @id, @label, @computer_id, @priority, @high_threshold, @low_threshold,
      @monitor_side, @vault_side, @modem_side, @redstone_side, @wing, @color,
      @report_interval, @sort_order
    )
  `)

  const seed = db.transaction(() => {
    ;(data.wings || []).forEach((w, i) =>
      insertWing.run(w.id, w.label, w.color ?? null, i)
    )
    ;(data.farms || []).forEach((f, i) =>
      insertFarm.run({
        id: f.id,
        label: f.label,
        computer_id: f.computer_id,
        priority: f.priority,
        high_threshold: f.high_threshold ?? 90,
        low_threshold: f.low_threshold ?? 50,
        monitor_side: f.monitor_side ?? 'top',
        vault_side: f.vault_side ?? 'left',
        modem_side: f.modem_side ?? 'right',
        redstone_side: f.redstone_side ?? 'bottom',
        wing: f.wing,
        color: f.color ?? null,
        report_interval: f.report_interval ?? 5,
        sort_order: i
      })
    )
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'central_computer_id',
      String(data.central_computer_id ?? 0)
    )
  })
  seed()
  console.log(
    `Seeded cabin.db from farms.json: ${(data.farms || []).length} farms, ` +
      `${(data.wings || []).length} wings`
  )
}

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)

  // Seed only an empty DB — idempotent, never overwrites existing data.
  const farmCount = db.prepare('SELECT COUNT(*) AS n FROM farms').get().n
  if (farmCount === 0) seedFromJson(db)

  return db
}

const db = init()

module.exports = { db, PRIORITY_LABELS, DB_PATH }
