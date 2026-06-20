-- CABIN Base Monitor — Installer
-- Run on any fresh CC:Tweaked computer:
--   wget https://raw.githubusercontent.com/Jordomav/cabin-monitor/main/minecraft/installer.lua installer.lua
--   installer
-- Downloads the right script as startup.lua. Farm computers find their own
-- config from farms.json by computer ID (add the printed ID to farms.json).

local GITHUB_RAW = "https://raw.githubusercontent.com/Jordomav/cabin-monitor/main/minecraft/"

local function color(text, c)
  term.setTextColor(c or colors.white)
  print(text)
  term.setTextColor(colors.white)
end

local function download(file)
  local resp = http.get(GITHUB_RAW .. file)
  if not resp then return false, "download failed: " .. file end
  local body = resp.readAll()
  resp.close()
  local f = fs.open("startup.lua", "w")
  if not f then return false, "could not write startup.lua" end
  f.write(body)
  f.close()
  return true
end

local function main()
  if not http then
    color("HTTP API is disabled in the server config — cannot install.", colors.red)
    return
  end

  while true do
    term.clear()
    term.setCursorPos(1, 1)
    color("=== CABIN Base Monitor Installer ===\n", colors.yellow)
    color("This computer's ID: " .. os.getComputerID(), colors.lightGray)
    print("")
    color("1. Central control computer", colors.cyan)
    color("2. Farm computer (universal_farm)", colors.cyan)
    color("3. Update / reinstall current script", colors.cyan)
    color("4. Show this computer's ID", colors.cyan)
    color("5. Exit", colors.gray)
    print("")
    write("Choice: ")
    local choice = tonumber(read())

    if choice == 1 then
      local ok, err = download("central.lua")
      if ok then
        color("\nCentral installed as startup.lua.", colors.green)
        color("Edit WEB_SERVER_URL and WEB_API_KEY at the top of startup.lua,", colors.white)
        color("then reboot (Ctrl+R).", colors.white)
      else
        color("Error: " .. err, colors.red)
      end
      sleep(4)

    elseif choice == 2 then
      local ok, err = download("universal_farm.lua")
      if ok then
        color("\nFarm script installed as startup.lua.", colors.green)
        -- Server URL + API key live in farm_env.lua so re-installs (choice 3)
        -- never wipe them. Leave both blank to keep an existing farm_env.lua.
        color("\nWeb server URL (e.g. http://1.2.3.4:3000):", colors.white)
        write("> ")
        local url = read()
        color("Server API key:", colors.white)
        write("> ")
        local key = read()

        if url ~= "" and key ~= "" then
          local f = fs.open("farm_env.lua", "w")
          if f then
            f.write("-- Written by installer.lua. Edit if your server moves.\n")
            f.write("return {\n")
            f.write('  WEB_SERVER_URL = "' .. url .. '",\n')
            f.write('  WEB_API_KEY = "' .. key .. '"\n')
            f.write("}\n")
            f.close()
            color("Saved server settings to farm_env.lua.", colors.green)
          else
            color("Could not write farm_env.lua.", colors.red)
          end
        elseif fs.exists("farm_env.lua") then
          color("Kept existing farm_env.lua.", colors.gray)
        else
          color("No server settings entered — re-run installer or create farm_env.lua.", colors.yellow)
        end

        color("\nNext steps:", colors.white)
        color("  1. Note this computer ID: " .. os.getComputerID(), colors.yellow)
        color("  2. Add it as a farm (dashboard 🛠 or manage.lua)", colors.white)
        color("  3. Reboot this computer (Ctrl+R)", colors.white)
      else
        color("Error: " .. err, colors.red)
      end
      sleep(4)

    elseif choice == 3 then
      if not fs.exists("startup.lua") then
        color("No startup.lua yet — run a fresh install (1 or 2).", colors.red)
      else
        -- Re-pull whichever script is already installed.
        local f = fs.open("startup.lua", "r")
        local head = f.readAll():sub(1, 200)
        f.close()
        local file = head:find("Central Control") and "central.lua" or "universal_farm.lua"
        local ok, err = download(file)
        if ok then
          color("Updated " .. file .. ". Reboot to apply (Ctrl+R).", colors.green)
        else
          color("Error: " .. err, colors.red)
        end
      end
      sleep(3)

    elseif choice == 4 then
      color("\nThis computer's ID: " .. os.getComputerID(), colors.yellow)
      color("Use it as computer_id in farms.json.", colors.gray)
      sleep(3)

    elseif choice == 5 then
      term.clear()
      term.setCursorPos(1, 1)
      return
    end
  end
end

main()
