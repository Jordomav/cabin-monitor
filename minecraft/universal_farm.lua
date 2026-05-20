-- CABIN Base Monitor — Universal Farm Computer
-- Every farm computer runs THIS one script. It fetches farms.json, finds its
-- own entry by os.getComputerID(), and runs the vault/redstone/rednet loop.
-- No per-computer config.lua. Built per CABIN_Lua_Reference.md.

local GITHUB_RAW = "https://raw.githubusercontent.com/Jordomav/cabin-monitor/main/minecraft/"

-- ----- JSON helpers (spelling differs across CC:Tweaked versions) -----------
local function jsonDecode(s)
  local fn = textutils.unserialiseJSON or textutils.unserializeJSON
  if not fn then return nil end
  local ok, v = pcall(fn, s)
  if ok then return v end
  return nil
end

-- ----- Load farms.json (GitHub first, local cache fallback) ----------------
local function loadFarmsConfig()
  local data, body
  local ok, resp = pcall(http.get, GITHUB_RAW .. "farms.json")
  if ok and resp then
    body = resp.readAll()
    resp.close()
    data = jsonDecode(body)
  end
  if data and body then
    local f = fs.open("farms_cache.json", "w")
    if f then f.write(body) f.close() end
  end
  if not data and fs.exists("farms_cache.json") then
    print("GitHub unreachable — using cached farms.json")
    local f = fs.open("farms_cache.json", "r")
    data = jsonDecode(f.readAll())
    f.close()
  end
  if not data or not data.farms then
    error("Cannot load farms.json (no network and no cache).")
  end
  return data
end

local farmsData = loadFarmsConfig()
local myId = os.getComputerID()

local config
for _, f in ipairs(farmsData.farms) do
  if f.computer_id == myId then config = f break end
end
if not config then
  print("This computer (ID " .. myId .. ") is not in farms.json.")
  print("Add an entry with \"computer_id\": " .. myId .. ", push, then reboot.")
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

-- ----- main loop -----------------------------------------------------------
local function mainLoop()
  while true do
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
    sleep(config.report_interval or 5)
  end
end

parallel.waitForAll(mainLoop, listenForCommands)
