// CABIN Base Monitor — request validation for farm / wing / settings writes.
// The server is authoritative; the dashboard and manage.lua surface these
// errors rather than duplicating logic. See SQLITE_MIGRATION_PLAN.md §4.1.

const farmsRepo = require('./farmsRepo')

const SIDES = ['top', 'bottom', 'left', 'right', 'front', 'back']
const ID_RE = /^[a-z0-9_]+$/

const FARM_DEFAULTS = {
  high_threshold: 90,
  low_threshold: 50,
  monitor_side: 'top',
  vault_side: 'left',
  modem_side: 'right',
  redstone_side: 'bottom',
  color: null,
  report_interval: 5
}

const isInt = (v) => Number.isInteger(v)

// Validate a farm create/update. On update, provided fields are merged over the
// existing row, so partial bodies are allowed. Returns
// { ok, errors[], warnings[], value } — value is the full row ready to persist.
function validateFarm(input, { isUpdate = false, currentId = null } = {}) {
  const errors = []
  const warnings = []
  input = input || {}

  const existing = isUpdate && currentId ? farmsRepo.getFarm(currentId) : null
  if (isUpdate && !existing) {
    return { ok: false, errors: ['Farm not found'], warnings, value: null, notFound: true }
  }

  // id comes from the URL on update and is immutable; on create it's required.
  const id = isUpdate ? currentId : input.id
  if (!isUpdate) {
    if (typeof id !== 'string' || !id.trim()) errors.push('id is required')
    else if (!ID_RE.test(id)) errors.push('id must match [a-z0-9_]+')
    else if (farmsRepo.getFarm(id)) errors.push(`id "${id}" already exists`)
  } else if (input.id !== undefined && input.id !== currentId) {
    errors.push('id cannot be changed (delete and recreate to rename)')
  }

  // Merge: defaults (create) or existing row (update), then provided fields.
  const base = isUpdate ? existing : FARM_DEFAULTS
  const v = {
    id,
    label: pick(input.label, base.label),
    computer_id: pick(input.computer_id, base.computer_id),
    priority: pick(input.priority, base.priority),
    high_threshold: pick(input.high_threshold, base.high_threshold),
    low_threshold: pick(input.low_threshold, base.low_threshold),
    monitor_side: pick(input.monitor_side, base.monitor_side),
    vault_side: pick(input.vault_side, base.vault_side),
    modem_side: pick(input.modem_side, base.modem_side),
    redstone_side: pick(input.redstone_side, base.redstone_side),
    wing: pick(input.wing, base.wing),
    color: pick(input.color, base.color),
    report_interval: pick(input.report_interval, base.report_interval)
  }

  if (typeof v.label !== 'string' || !v.label.trim()) errors.push('label is required')

  if (!isInt(v.computer_id) || v.computer_id < 0) {
    errors.push('computer_id must be an integer ≥ 0')
  } else {
    const owner = farmsRepo.getFarmByComputerId(v.computer_id)
    if (owner && owner.id !== id) {
      errors.push(`computer_id ${v.computer_id} is already used by "${owner.id}"`)
    }
    if (v.computer_id === farmsRepo.centralComputerId()) {
      errors.push(`computer_id ${v.computer_id} is the central computer's id`)
    }
    // Re-pointing an existing entry at a different physical computer is allowed
    // but flagged — only correct if the hardware was actually swapped.
    if (isUpdate && v.computer_id !== existing.computer_id) {
      warnings.push(
        `computer_id changed ${existing.computer_id} → ${v.computer_id}: this ` +
          're-points the entry at a different physical computer. Reboot that computer.'
      )
    }
  }

  if (!isInt(v.priority) || v.priority < 1 || v.priority > 4) {
    errors.push('priority must be an integer 1–4')
  }

  for (const k of ['high_threshold', 'low_threshold']) {
    if (!isInt(v[k]) || v[k] < 0 || v[k] > 100) errors.push(`${k} must be 0–100`)
  }
  if (isInt(v.low_threshold) && isInt(v.high_threshold) && v.low_threshold >= v.high_threshold) {
    errors.push('low_threshold must be less than high_threshold')
  }

  for (const k of ['monitor_side', 'vault_side', 'modem_side', 'redstone_side']) {
    if (!SIDES.includes(v[k])) errors.push(`${k} must be one of ${SIDES.join('/')}`)
  }

  if (!isInt(v.report_interval) || v.report_interval < 1) {
    errors.push('report_interval must be an integer ≥ 1')
  }

  if (typeof v.wing !== 'string' || !v.wing) errors.push('wing is required')
  else if (!farmsRepo.getWing(v.wing)) errors.push(`wing "${v.wing}" does not exist`)

  if (v.color != null && typeof v.color !== 'string') errors.push('color must be a string')

  return { ok: errors.length === 0, errors, warnings, value: v }
}

function validateWing(input, { isUpdate = false, currentId = null } = {}) {
  const errors = []
  input = input || {}
  const id = isUpdate ? currentId : input.id

  if (isUpdate) {
    if (!farmsRepo.getWing(currentId)) {
      return { ok: false, errors: ['Wing not found'], value: null, notFound: true }
    }
    if (input.id !== undefined && input.id !== currentId) errors.push('wing id cannot be changed')
  } else {
    if (typeof id !== 'string' || !id.trim()) errors.push('id is required')
    else if (!ID_RE.test(id)) errors.push('id must match [a-z0-9_]+')
    else if (farmsRepo.getWing(id)) errors.push(`wing "${id}" already exists`)
  }

  const label = pick(input.label, isUpdate ? farmsRepo.getWing(currentId)?.label : undefined)
  if (typeof label !== 'string' || !label.trim()) errors.push('label is required')
  const color = pick(input.color, isUpdate ? farmsRepo.getWing(currentId)?.color : null)
  if (color != null && typeof color !== 'string') errors.push('color must be a string')

  return { ok: errors.length === 0, errors, value: { id, label, color } }
}

// central_computer_id must not collide with any farm's computer_id.
function validateCentralId(value) {
  const errors = []
  if (!isInt(value) || value < 0) {
    errors.push('central_computer_id must be an integer ≥ 0')
  } else if (farmsRepo.getFarmByComputerId(value)) {
    errors.push(`central_computer_id ${value} is already used by a farm`)
  }
  return { ok: errors.length === 0, errors, value }
}

// Treat undefined as "not provided"; null is a real value (clears color).
function pick(provided, fallback) {
  return provided === undefined ? fallback : provided
}

module.exports = { validateFarm, validateWing, validateCentralId }
