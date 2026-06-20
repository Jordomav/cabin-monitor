-- CABIN Base Monitor — Management Console (manage.lua)
-- In-game admin tool for the farm database. Talks to the web server's CRUD API
-- with the server API key. Typically run on the central computer:
--   manage
-- Full CRUD over farms + wings, plus "register THIS computer" which fills the
-- computer_id automatically from os.getComputerID() — the typo-proof way to add
-- a farm (no chance of the dashboard ID not matching the real computer).

-- Server URL + key are shared with the farm scripts via farm_env.lua. If it's
-- missing (e.g. on a central computer) manage.lua prompts once and writes it.
local ENV_FILE = "farm_env.lua"
local WEB_SERVER_URL, WEB_API_KEY

-- ----- helpers -------------------------------------------------------------
local function cprint(text, c)
  term.setTextColor(c or colors.white)
  print(text)
  term.setTextColor(colors.white)
end

local function ask(label, default)
  if default ~= nil and default ~= "" then
    write(label .. " [" .. tostring(default) .. "]: ")
  else
    write(label .. ": ")
  end
  local v = read()
  if v == "" and default ~= nil then return default end
  return v
end

local function jsonDecode(s)
  local fn = textutils.unserialiseJSON or textutils.unserializeJSON
  if not fn or not s then return nil end
  local ok, v = pcall(fn, s)
  if ok then return v end
  return nil
end

-- One request helper for every method. On HTTP error status, CC returns
-- (nil, message, errorResponseHandle) — we read the error handle to surface
-- the server's {error, errors} body. http.get/http.post honor `method` in the
-- request table, so PUT/DELETE work through the same path.
local function httpJson(method, path, bodyTbl)
  local headers = { ["X-API-Key"] = WEB_API_KEY }
  local req = { url = WEB_SERVER_URL .. path, method = method, headers = headers }
  if bodyTbl ~= nil then
    headers["Content-Type"] = "application/json"
    req.body = textutils.serializeJSON(bodyTbl)
  end
  local fn = (bodyTbl ~= nil) and http.post or http.get
  local ok, resp, err, errResp = pcall(fn, req)
  if not ok then return nil, nil, tostring(resp) end
  local handle = resp or errResp
  if not handle then return nil, nil, err or "no response" end
  local code = handle.getResponseCode()
  local data = jsonDecode(handle.readAll())
  handle.close()
  return code, data
end

local function showError(code, data)
  cprint("Error: " .. ((data and data.error) or ("HTTP " .. tostring(code))), colors.red)
  if data and data.errors then
    for _, e in ipairs(data.errors) do cprint("  - " .. e, colors.red) end
  end
end

local function showWarnings(data)
  if data and data.warnings then
    for _, w in ipairs(data.warnings) do cprint("  warning: " .. w, colors.orange) end
  end
end

local function getConfig()
  local code, data = httpJson("GET", "/config")
  if code == 200 and data then return data end
  cprint("Could not reach server (" .. tostring(code) .. ").", colors.red)
  return nil
end

-- ----- env bootstrap -------------------------------------------------------
local function loadEnv()
  if fs.exists(ENV_FILE) then
    local ok, env = pcall(dofile, ENV_FILE)
    if ok and type(env) == "table" then
      WEB_SERVER_URL = env.WEB_SERVER_URL
      WEB_API_KEY = env.WEB_API_KEY
    end
  end
end

local function saveEnv(url, key)
  local f = fs.open(ENV_FILE, "w")
  f.write("-- Written by manage.lua / installer.lua. Edit if your server moves.\n")
  f.write("return {\n")
  f.write('  WEB_SERVER_URL = "' .. url .. '",\n')
  f.write('  WEB_API_KEY = "' .. key .. '"\n')
  f.write("}\n")
  f.close()
end

local function ensureEnv()
  loadEnv()
  if not WEB_SERVER_URL or not WEB_API_KEY then
    cprint("First run — enter server details.", colors.yellow)
    local url = ask("Web server URL (http://ip:3000)")
    local key = ask("Server API key")
    saveEnv(url, key)
    WEB_SERVER_URL, WEB_API_KEY = url, key
  end
end

-- ----- farm field collection ----------------------------------------------
local SIDES = "top/bottom/left/right/front/back"

local function listWingIds(cfg)
  local ids = {}
  for _, w in ipairs(cfg.wings) do table.insert(ids, w.id) end
  return table.concat(ids, ", ")
end

-- fixedComputerId set → "register this computer" path (auto, no prompt).
local function collectFarm(cfg, fixedComputerId)
  local farm = {}
  farm.id = ask("Farm id (a-z0-9_)")
  farm.label = ask("Label", farm.id)
  if fixedComputerId then
    farm.computer_id = fixedComputerId
    cprint("Computer ID (this computer): " .. fixedComputerId, colors.lightGray)
  else
    farm.computer_id = tonumber(ask("Computer ID"))
  end
  cprint("Wings: " .. listWingIds(cfg), colors.lightGray)
  farm.wing = ask("Wing id")
  farm.priority = tonumber(ask("Priority 1-4", "4"))
  farm.vault_side = ask("Vault side (" .. SIDES .. ")", "left")
  farm.redstone_side = ask("Redstone side", "bottom")
  farm.monitor_side = ask("Monitor side", "top")
  farm.modem_side = ask("Modem side", "right")
  farm.high_threshold = tonumber(ask("Pause at % (high)", "90"))
  farm.low_threshold = tonumber(ask("Resume at % (low)", "50"))
  return farm
end

-- ----- actions -------------------------------------------------------------
local function listFarms()
  local cfg = getConfig()
  if not cfg then return end
  cprint("Central computer ID: " .. tostring(cfg.central_computer_id), colors.lightGray)
  cprint("Farms:", colors.yellow)
  for _, f in ipairs(cfg.farms) do
    cprint(string.format("  %-12s id#%-3d P%d  %s", f.id, f.computer_id, f.priority, f.wing))
  end
  cprint("Wings:", colors.yellow)
  for _, w in ipairs(cfg.wings) do cprint("  " .. w.id .. " (" .. w.label .. ")") end
end

local function addFarm(fixedComputerId)
  local cfg = getConfig()
  if not cfg then return end
  local farm = collectFarm(cfg, fixedComputerId)
  local code, data = httpJson("POST", "/api/farms", farm)
  if code == 201 then
    cprint("Created farm '" .. tostring(farm.id) .. "'.", colors.green)
    showWarnings(data)
  else
    showError(code, data)
  end
end

local function registerSelf()
  cprint("Registering THIS computer (ID " .. os.getComputerID() .. ") as a farm.", colors.yellow)
  addFarm(os.getComputerID())
end

local function editFarm()
  local cfg = getConfig()
  if not cfg then return end
  local id = ask("Farm id to edit")
  local existing
  for _, f in ipairs(cfg.farms) do if f.id == id then existing = f break end end
  if not existing then cprint("No farm with id '" .. id .. "'.", colors.red) return end

  cprint("Blank = keep current value.", colors.lightGray)
  local body = {}
  local function setIf(key, label, conv)
    local v = ask(label .. " (" .. tostring(existing[key]) .. ")", "")
    if v ~= "" then body[key] = conv and conv(v) or v end
  end
  setIf("label", "Label")
  setIf("computer_id", "Computer ID", tonumber)
  setIf("wing", "Wing")
  setIf("priority", "Priority", tonumber)
  setIf("high_threshold", "Pause at %", tonumber)
  setIf("low_threshold", "Resume at %", tonumber)
  setIf("vault_side", "Vault side")
  setIf("redstone_side", "Redstone side")
  setIf("monitor_side", "Monitor side")
  setIf("modem_side", "Modem side")

  local code, data = httpJson("PUT", "/api/farms/" .. id, body)
  if code == 200 then
    cprint("Updated '" .. id .. "'.", colors.green)
    showWarnings(data)
  else
    showError(code, data)
  end
end

local function deleteFarm()
  local id = ask("Farm id to delete")
  write("Delete '" .. id .. "'? type yes: ")
  if read() ~= "yes" then cprint("Cancelled.", colors.gray) return end
  local code, data = httpJson("DELETE", "/api/farms/" .. id)
  if code == 200 then cprint("Deleted '" .. id .. "'.", colors.green) else showError(code, data) end
end

local function manageWings()
  local cfg = getConfig()
  if not cfg then return end
  for _, w in ipairs(cfg.wings) do cprint("  " .. w.id .. " (" .. w.label .. ")") end
  cprint("a = add   d = delete   Enter = back", colors.lightGray)
  local c = ask("Choice", "")
  if c == "a" then
    local body = { id = ask("Wing id"), label = ask("Label") }
    local color = ask("Color (optional)", "")
    if color ~= "" then body.color = color end
    local code, data = httpJson("POST", "/api/wings", body)
    if code == 201 then cprint("Wing added.", colors.green) else showError(code, data) end
  elseif c == "d" then
    local id = ask("Wing id to delete")
    local code, data = httpJson("DELETE", "/api/wings/" .. id)
    if code == 200 then cprint("Deleted.", colors.green) else showError(code, data) end
  end
end

local function setCentral()
  local v = tonumber(ask("Central computer ID", tostring(os.getComputerID())))
  local code, data = httpJson("PUT", "/api/settings", { central_computer_id = v })
  if code == 200 then cprint("Saved central computer ID = " .. tostring(v) .. ".", colors.green)
  else showError(code, data) end
end

-- ----- menu ----------------------------------------------------------------
local function main()
  if not http then cprint("HTTP API disabled in the server config.", colors.red) return end
  ensureEnv()
  while true do
    term.clear()
    term.setCursorPos(1, 1)
    cprint("=== CABIN Farm Manager ===\n", colors.yellow)
    cprint("This computer ID: " .. os.getComputerID(), colors.lightGray)
    cprint("Server: " .. WEB_SERVER_URL .. "\n", colors.lightGray)
    cprint("1. List farms & wings", colors.cyan)
    cprint("2. Register THIS computer as a farm", colors.cyan)
    cprint("3. Add a farm (enter ID manually)", colors.cyan)
    cprint("4. Edit a farm", colors.cyan)
    cprint("5. Delete a farm", colors.cyan)
    cprint("6. Manage wings", colors.cyan)
    cprint("7. Set central computer ID", colors.cyan)
    cprint("8. Exit", colors.gray)
    write("\nChoice: ")
    local choice = read()
    print("")
    if choice == "1" then listFarms()
    elseif choice == "2" then registerSelf()
    elseif choice == "3" then addFarm(nil)
    elseif choice == "4" then editFarm()
    elseif choice == "5" then deleteFarm()
    elseif choice == "6" then manageWings()
    elseif choice == "7" then setCentral()
    elseif choice == "8" then term.clear() term.setCursorPos(1, 1) return
    end
    cprint("\nPress Enter to continue...", colors.gray)
    read()
  end
end

main()
