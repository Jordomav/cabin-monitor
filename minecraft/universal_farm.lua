-- CABIN Base Monitor — Universal Farm Computer
-- Every farm computer runs THIS one script. It fetches the farm config from the
-- web server (/config), finds its own entry by os.getComputerID(), and runs the
-- vault/redstone/rednet loop. SQLite on the server is the single source of truth.

-- Server URL + API key come from farm_env.lua (written by installer.lua) so
-- re-downloading this script never clobbers them. Placeholders are a fallback.
local WEB_SERVER_URL = "http://YOUR_DROPLET_IP:3000"
local WEB_API_KEY    = "REPLACE_WITH_SERVER_API_KEY"
if fs.exists("farm_env.lua") then
  local ok, env = pcall(dofile, "farm_env.lua")
  if ok and type(env) == "table" then
    WEB_SERVER_URL = env.WEB_SERVER_URL or WEB_SERVER_URL
    WEB_API_KEY    = env.WEB_API_KEY or WEB_API_KEY
  end
end

-- ----- JSON helpers (spelling differs across CC:Tweaked versions) -----------
local function jsonDecode(s)
  local fn = textutils.unserialiseJSON or textutils.unserializeJSON
  if not fn then return nil end
  local ok, v = pcall(fn, s)
  if ok then return v end
  return nil
end

-- ----- Farm config: web server (/config) first, local cache fallback -------
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

local function loadFarmsConfig()
  local data = fetchConfig()
  if data then return data end
  print("Server unreachable — using cached farm config")
  data = loadFromCache()
  if data and data.farms then return data end
  error("Cannot load farm config (no server, no cache).")
end

local myId = os.getComputerID()
local function findMyConfig(data)
  for _, f in ipairs(data.farms) do
    if f.computer_id == myId then return f end
  end
  return nil
end

local farmsData = loadFarmsConfig()
local config = findMyConfig(farmsData)
if not config then
  print("This computer (ID " .. myId .. ") is not in the farm config.")
  print("Add an entry with computer_id " .. myId .. " (dashboard 🛠 or manage.lua), then reboot.")
  return
end

local CENTRAL_ID = farmsData.central_computer_id or 1
print("Running as: " .. config.label .. " (priority " .. config.priority .. ")")

-- ----- Peripherals (defensive) ---------------------------------------------
local monitor = peripheral.wrap(config.monitor_side) -- optional
local vault   = peripheral.wrap(config.vault_side)
local modem   = peripheral.wrap(config.modem_side)
if not vault then error("No vault/chest on " .. tostring(config.vault_side)) end
if not modem then error("No modem on " .. tostring(config.modem_side)) end
rednet.open(config.modem_side)

-- ----- Vault fill % (Create vault or plain inventory; never crash) ---------
local lastFill = 0
local function getVaultFill()
  local ok, pct = pcall(function()
    local used = 0
    for _, item in pairs(vault.list()) do used = used + item.count end
    local capacity
    local vtype = peripheral.getType(config.vault_side) or ""
    if vtype:find("vault") and vault.getCapacity then
      capacity = vault.getCapacity()
    elseif vault.size then
      capacity = vault.size() * 64
    end
    if not capacity or capacity == 0 then return lastFill end
    return math.floor((used / capacity) * 100)
  end)
  if ok and type(pct) == "number" then
    lastFill = math.max(0, math.min(100, pct))
  end
  return lastFill
end

-- ----- Redstone control (HIGH = farm OFF, kills power to the shaft) --------
local function setFarmRunning(state)
  redstone.setOutput(config.redstone_side, not state)
end
local function isFarmRunning()
  return not redstone.getOutput(config.redstone_side)
end

-- ----- Monitor (optional) --------------------------------------------------
local function updateMonitor(fill, running, override)
  if not monitor then return end
  pcall(function()
    monitor.setTextScale(0.5)
    monitor.clear()
    monitor.setCursorPos(1, 1)
    monitor.setTextColor(colors.yellow)
    monitor.write(string.upper(config.label))
    monitor.setCursorPos(1, 2)
    monitor.setTextColor(colors.gray)
    monitor.write("ID " .. myId .. " | " .. (config.wing or "?"))
    monitor.setCursorPos(1, 4)
    monitor.setTextColor(colors.white)
    monitor.write("Vault: " .. fill .. "%")
    monitor.setCursorPos(1, 6)
    if override then
      monitor.setTextColor(colors.orange) monitor.write("OVERRIDE")
    elseif running then
      monitor.setTextColor(colors.green) monitor.write("RUNNING")
    else
      monitor.setTextColor(colors.red) monitor.write("PAUSED")
    end
  end)
end

-- ----- rednet: report to central + receive commands ------------------------
local override = false

local function sendReport(fill, running)
  rednet.send(CENTRAL_ID, {
    type     = "farm_report",
    farm     = config.id,
    fill     = fill,
    running  = running,
    override = override
  })
end

local function listenForCommands()
  while true do
    local id, message = rednet.receive()
    if id == CENTRAL_ID and type(message) == "table" then
      if message.command == "override_on" then
        override = true
        setFarmRunning(true)
      elseif message.command == "override_off" then
        override = true
        setFarmRunning(false)
      elseif message.command == "clear_override" then
        override = false
      elseif message.command == "ping" then
        rednet.send(CENTRAL_ID, { type = "pong", farm = config.id })
      end
    end
  end
end

-- ----- config hot-reload ---------------------------------------------------
-- Re-fetch every ~30s so threshold/priority/label/interval edits apply without
-- a reboot. Peripheral SIDE changes still need a reboot — sides are wrapped
-- once at startup above.
local function refreshConfig()
  local data = fetchConfig()
  if not data then return end
  local mine = findMyConfig(data)
  if mine then
    farmsData = data
    config = mine
    CENTRAL_ID = data.central_computer_id or CENTRAL_ID
  end
end

-- ----- main loop -----------------------------------------------------------
local function mainLoop()
  local cycle = 0
  while true do
    local interval = config.report_interval or 5
    cycle = cycle + 1
    if cycle % math.max(1, math.floor(30 / interval)) == 0 then refreshConfig() end

    local fill = getVaultFill()
    local running = isFarmRunning()

    -- Local automatic control only when not overridden by the dashboard.
    if not override then
      if fill >= config.high_threshold and running then
        setFarmRunning(false) running = false
      elseif fill <= config.low_threshold and not running then
        setFarmRunning(true) running = true
      end
    end

    updateMonitor(fill, running, override)
    sendReport(fill, running)
    sleep(interval)
  end
end

parallel.waitForAll(mainLoop, listenForCommands)
