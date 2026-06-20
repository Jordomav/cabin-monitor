-- CABIN Base Monitor — Central Control Computer
-- Aggregates farm reports over rednet, POSTs state to the web server, and
-- polls for dashboard commands. Built fresh per CABIN_Lua_Reference.md.
-- Farm/priority tables are fetched dynamically from the web server's /config
-- endpoint (SQLite is the single source of truth) — nothing about farms is
-- hardcoded here, and the config is re-fetched periodically so edits go live.

-- ===== DEPLOY CONFIG — EDIT THESE ON THE CENTRAL COMPUTER ===================
-- TODO: point at the Digital Ocean droplet running the Node server.
local WEB_SERVER_URL  = "http://YOUR_DROPLET_IP:3000"
-- TODO: must exactly match API_KEY in monitor/server/.env on the droplet.
local WEB_API_KEY     = "REPLACE_WITH_SERVER_API_KEY"
local MONITOR_SIDE    = "top"      -- large monitor (optional — display is skipped if absent)
local MODEM_SIDE      = "right"    -- wireless modem (required for rednet)
local REPORT_INTERVAL = 3          -- seconds between web POST + command poll
local REPORT_TIMEOUT  = 15         -- seconds of silence before a farm is marked offline
-- ===========================================================================

-- ----- JSON helpers (spelling differs across CC:Tweaked versions) -----------
local function jsonDecode(s)
  local fn = textutils.unserialiseJSON or textutils.unserializeJSON
  if not fn then return nil end
  local ok, v = pcall(fn, s)
  if ok then return v end
  return nil
end
local function jsonEncode(t) return textutils.serializeJSON(t) end

-- ----- Farm config: fetched from the web server (/config), cache fallback --
-- SQLite on the server is the single source of truth; central no longer reads
-- GitHub. farms_cache.json only covers a server-unreachable boot.
local function fetchConfig()
  local ok, resp = pcall(http.get, WEB_SERVER_URL .. "/config", {
    ["X-API-Key"] = WEB_API_KEY
  })
  if ok and resp then
    local body = resp.readAll()
    resp.close()
    local data = jsonDecode(body)
    if data and data.farms then
      local f = fs.open("farms_cache.json", "w")
      if f then f.write(body) f.close() end
      return data
    end
  end
  return nil
end

local function loadFromCache()
  if not fs.exists("farms_cache.json") then return nil end
  local f = fs.open("farms_cache.json", "r")
  local data = jsonDecode(f.readAll())
  f.close()
  return data
end

local farmsData
local FARM_PRIORITIES, FARM_IDS, ID_TO_FARM = {}, {}, {}

local function rebuildLookups()
  FARM_PRIORITIES, FARM_IDS, ID_TO_FARM = {}, {}, {}
  for _, farm in ipairs(farmsData.farms) do
    FARM_PRIORITIES[farm.id]     = farm.priority
    FARM_IDS[farm.id]            = farm.computer_id
    ID_TO_FARM[farm.computer_id] = farm.id
  end
end

-- Periodic refresh so dashboard / manage.lua edits go live without a reboot.
local function refreshConfig()
  local data = fetchConfig()
  if data and data.farms then
    farmsData = data
    rebuildLookups()
  end
end

do
  local data = fetchConfig()
  if not data then
    print("Server unreachable — trying cached farm config")
    data = loadFromCache()
  end
  if not data or not data.farms then
    error("Cannot load farm config (no server, no cache). Aborting.")
  end
  farmsData = data
  rebuildLookups()
  print("Loaded " .. #farmsData.farms .. " farms from /config")
end

-- ----- State ---------------------------------------------------------------
-- farmStatus[id] = { fill, running, override, online, lastReport(os.clock) }
local farmStatus = {}
local powerStatus = { generation = 0, consumption = 0, ratio = 0, state = "NORMAL" }
local alerts = {}

local function addAlert(message, level)
  table.insert(alerts, 1, { message = message, level = level, time = os.clock() })
  while #alerts > 10 do table.remove(alerts) end
end

-- ----- Peripherals (all optional/defensive) --------------------------------
local modem = peripheral.wrap(MODEM_SIDE)
if not modem then error("No wireless modem on " .. MODEM_SIDE .. " — rednet required") end
rednet.open(MODEM_SIDE)

local monitor = peripheral.wrap(MONITOR_SIDE) -- may be nil; display is skipped

-- Find a Create power peripheral (stressometer/speedometer). Mod + version
-- determine the type name and method names, so probe instead of assuming.
local powerPeripheral, powerMethods = nil, {}
for _, name in ipairs(peripheral.getNames()) do
  local methods = peripheral.getMethods and peripheral.getMethods(name) or {}
  local set = {}
  for _, m in ipairs(methods) do set[m] = true end
  if set.getStress or set.getStressCapacity or set.getKineticStress then
    powerPeripheral = peripheral.wrap(name)
    powerMethods = set
    print("Power peripheral: " .. name .. " (" .. peripheral.getType(name) .. ")")
    break
  end
end
if not powerPeripheral then
  print("No Create stress peripheral found — power will report 0 / NORMAL")
end

-- Try a list of likely method names, return first that works.
local function tryRead(names)
  if not powerPeripheral then return nil end
  for _, n in ipairs(names) do
    if powerMethods[n] then
      local ok, v = pcall(function() return powerPeripheral[n]() end)
      if ok and type(v) == "number" then return v end
    end
  end
  return nil
end

local function updatePowerStatus()
  local stress   = tryRead({ "getStress", "getKineticStress", "getSUUsage" })
  local capacity = tryRead({ "getStressCapacity", "getKineticCapacity", "getSUCapacity" })
  if stress and capacity then
    powerStatus.consumption = math.floor(stress)
    powerStatus.generation  = math.floor(capacity)
  end
  if powerStatus.generation > 0 then
    powerStatus.ratio = powerStatus.consumption / powerStatus.generation
  else
    powerStatus.ratio = 0
  end
  if powerStatus.ratio >= 0.90 then
    powerStatus.state = "CRITICAL"
  elseif powerStatus.ratio >= 0.75 then
    powerStatus.state = "WARNING"
  else
    powerStatus.state = "NORMAL"
  end
end

-- ----- Command dispatch (over rednet to farm computers) --------------------
local function sendCommand(farmName, command)
  local id = FARM_IDS[farmName]
  if id then rednet.send(id, { command = command }) end
end

-- ----- Web bridge ----------------------------------------------------------
-- Build the EXACT contract the server/dashboard expect: farms keyed by id,
-- status-only fields, no lastSeen, no trains.
local function farmsForPayload()
  local out = {}
  for id, s in pairs(farmStatus) do
    out[id] = {
      fill     = s.fill or 0,
      running  = s.running == true,
      override = s.override == true,
      online   = s.online == true
    }
  end
  return out
end

local function postToWebServer()
  local payload = jsonEncode({
    timestamp = os.epoch("utc"),
    power     = powerStatus,
    farms     = farmsForPayload(),
    alerts    = alerts
  })
  local ok, resp = pcall(http.post, WEB_SERVER_URL .. "/update", payload, {
    ["Content-Type"] = "application/json",
    ["X-API-Key"]    = WEB_API_KEY
  })
  if ok and resp then
    resp.close()
  else
    addAlert("Web server unreachable", "WARN")
  end
end

local function checkForWebCommands()
  local ok, resp = pcall(http.get, WEB_SERVER_URL .. "/commands", {
    ["X-API-Key"] = WEB_API_KEY
  })
  if not (ok and resp) then return end
  local data = jsonDecode(resp.readAll())
  resp.close()
  if type(data) ~= "table" then return end

  for _, cmd in ipairs(data) do
    if cmd.type == "farm_override_on" and cmd.farm then
      sendCommand(cmd.farm, "override_on")
      addAlert(cmd.farm .. " force-started by dashboard", "INFO")
    elseif cmd.type == "farm_override_off" and cmd.farm then
      sendCommand(cmd.farm, "override_off")
      addAlert(cmd.farm .. " force-stopped by dashboard", "INFO")
    elseif cmd.type == "farm_clear_override" and cmd.farm then
      sendCommand(cmd.farm, "clear_override")
      addAlert(cmd.farm .. " override cleared by dashboard", "INFO")
    elseif cmd.type == "shutdown_all" then
      for farm in pairs(FARM_IDS) do sendCommand(farm, "override_off") end
      addAlert("ALL farms shut down by dashboard", "WARN")
    elseif cmd.type == "resume_all" then
      for farm in pairs(FARM_IDS) do sendCommand(farm, "clear_override") end
      addAlert("All farms resumed by dashboard", "INFO")
    elseif cmd.type == "shutdown_priority" and cmd.tier then
      for farm, priority in pairs(FARM_PRIORITIES) do
        if priority >= cmd.tier then sendCommand(farm, "override_off") end
      end
      addAlert("Priority " .. cmd.tier .. "+ farms shut down", "WARN")
    end
  end
end

-- ----- Offline detection (the server trusts this `online` flag) ------------
local function checkTimeouts()
  local now = os.clock()
  for farm, s in pairs(farmStatus) do
    if s.lastReport and (now - s.lastReport) > REPORT_TIMEOUT and s.online then
      s.online = false
      addAlert(farm .. " farm offline!", "CRIT")
    end
  end
end

-- ----- Monitor display (optional) ------------------------------------------
local function updateDisplay()
  if not monitor then return end
  local ok = pcall(function()
    monitor.setTextScale(0.5)
    monitor.clear()
    monitor.setCursorPos(1, 1)
    monitor.setTextColor(colors.yellow)
    monitor.write("=== CABIN CENTRAL ===")
    monitor.setCursorPos(1, 2)
    monitor.setTextColor(colors.white)
    monitor.write("POWER: " .. powerStatus.state ..
      " (" .. math.floor(powerStatus.ratio * 100) .. "%)")
    local y = 4
    local names = {}
    for id in pairs(FARM_IDS) do table.insert(names, id) end
    table.sort(names, function(a, b)
      local pa, pb = FARM_PRIORITIES[a] or 99, FARM_PRIORITIES[b] or 99
      if pa == pb then return a < b end
      return pa < pb
    end)
    for _, id in ipairs(names) do
      local s = farmStatus[id]
      monitor.setCursorPos(1, y)
      if not s or not s.online then
        monitor.setTextColor(colors.gray)
        monitor.write(id .. " OFFLINE")
      elseif s.override then
        monitor.setTextColor(colors.orange)
        monitor.write(id .. " OVERRIDE")
      elseif s.running then
        monitor.setTextColor(colors.green)
        monitor.write(id .. " " .. (s.fill or 0) .. "%")
      else
        monitor.setTextColor(colors.red)
        monitor.write(id .. " PAUSED")
      end
      y = y + 1
    end
  end)
  if not ok then monitor = nil end -- display failed; stop trying, keep running
end

-- ----- rednet listener (parallel task) -------------------------------------
local function listenForFarmReports()
  while true do
    local id, message = rednet.receive()
    local farmName = ID_TO_FARM[id]
    if farmName and type(message) == "table" then
      if message.type == "farm_report" then
        farmStatus[farmName] = {
          fill       = message.fill,
          running    = message.running,
          override   = message.override,
          online     = true,
          lastReport = os.clock()
        }
      elseif message.type == "pong" then
        if farmStatus[farmName] then
          farmStatus[farmName].online = true
          farmStatus[farmName].lastReport = os.clock()
        end
      end
    end
  end
end

-- ----- main loop -----------------------------------------------------------
-- Re-fetch farm config roughly every 30s so DB edits propagate without reboot.
local CONFIG_REFRESH_CYCLES = math.max(1, math.floor(30 / REPORT_INTERVAL))

local function mainLoop()
  addAlert("Central control started", "INFO")
  for _, id in pairs(FARM_IDS) do rednet.send(id, { command = "ping" }) end
  local cycle = 0
  while true do
    cycle = cycle + 1
    if cycle % CONFIG_REFRESH_CYCLES == 0 then refreshConfig() end
    checkTimeouts()
    updatePowerStatus()
    postToWebServer()
    checkForWebCommands()
    updateDisplay()
    sleep(REPORT_INTERVAL)
  end
end

parallel.waitForAll(mainLoop, listenForFarmReports)
