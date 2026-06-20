# CABIN Base Monitor — SQLite Farm Store Migration Plan

**Status:** Proposed (no code written yet)
**Branch:** `SQlite`
**Goal:** Replace the static `minecraft/farms.json` single-source-of-truth with a
SQLite database on the Node server, and expose full CRUD over farms (and wings)
from **both** the web dashboard **and** in-game (CC:Tweaked).

---

## 1. Why this change

Today `minecraft/farms.json` is the single source of truth, consumed in **three**
independent places:

| Consumer | How it reads farms.json today |
|----------|-------------------------------|
| `monitor/server/server.js` | Reads the local file at startup, serves it at `GET /api/farms-config` |
| `minecraft/central.lua` | Fetches from **GitHub raw**, caches to `farms_cache.json` |
| `minecraft/universal_farm.lua` | Fetches from **GitHub raw**, finds own entry by `computer_id` |
| Dashboard (`baseStore.js`) | Loads once from `GET /api/farms-config` |

Changing a farm today means: edit JSON → `git commit` → `git push` → (server) `git pull`
→ `pm2 restart`, and each Lua computer re-pulls from GitHub. There is no way to add,
edit, or remove a farm at runtime, and no way to do it from the dashboard or in game.

**Target architecture:** SQLite on the server becomes the single source of truth.
Every consumer reads from the server. Edits are live — no git round-trip.

```
                 ┌──────────────────────────────┐
                 │  SQLite (cabin.db) on droplet │  ← single source of truth
                 └──────────────┬───────────────┘
                                │ farmsRepo (data-access layer)
        ┌───────────────────────┼────────────────────────┐
        │                       │                         │
  GET /api/farms-config   GET /config (X-API-Key)   /api/farms CRUD
   (session, dashboard)   (CC computers)            (session OR X-API-Key)
        │                       │                         │
   Dashboard            central.lua / universal_farm   Dashboard "Manage Farms"
   (read)               .lua (read, cached fallback)   + in-game manage.lua (write)
```

### Locked decisions (confirmed with user)

1. **Lua config source → the server.** Add an API-key-protected `GET /config` that
   serves the live DB in the existing `farms.json` JSON shape. `central.lua` and
   `universal_farm.lua` fetch from the droplet instead of GitHub raw, keeping the
   local-cache fallback. No git push needed for farm changes.
2. **In-game CRUD → a dedicated `manage.lua` admin tool** run on the central
   computer, talking to the server CRUD endpoints with the API key. A fresh farm
   computer can also self-register on first boot.

---

## 2. What stays the same (compatibility contract)

These must NOT change, so existing code and the live data flow keep working:

- The **JSON shape** of farm config: `{ central_computer_id, priority_labels, wings[], farms[] }`
  with the exact farm fields in `farms.json` today. `GET /api/farms-config` and the new
  `GET /config` both return this assembled shape. The dashboard's `baseStore.js`,
  `FarmGrid.vue`, and the Lua scripts' parsing all keep working unchanged.
- The **`/update` / `/commands` / `/command`** contract (status ingest + command queue)
  is untouched. This migration is only about farm *definitions*, not live status.
- The status-only live payload (`farms.<id> = { fill, running, override, online }`)
  is unchanged.

`minecraft/farms.json` is **retained in the repo** as (a) the one-time DB seed and
(b) a git-tracked backup/disaster-recovery export — but it is no longer read at
runtime by the Lua scripts, and the server reads it only to seed an empty DB.

---

## 3. Data model (SQLite schema)

DB file: `monitor/server/data/cabin.db` (new `data/` dir, git-ignored).
Library: **`better-sqlite3`** (synchronous API, fast, battle-tested; native module
with prebuilt binaries for Node 20 — see deployment notes).

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- seeded: ('central_computer_id', '0')

CREATE TABLE IF NOT EXISTS wings (
  id        TEXT PRIMARY KEY,      -- e.g. "farm_wing"
  label     TEXT NOT NULL,
  color     TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS farms (
  id              TEXT PRIMARY KEY,           -- "wood"
  label           TEXT NOT NULL,              -- "Wood Farm"
  computer_id     INTEGER NOT NULL UNIQUE,    -- CC:Tweaked id; UNIQUE is critical
  priority        INTEGER NOT NULL,           -- 1..4
  high_threshold  INTEGER NOT NULL DEFAULT 90,
  low_threshold   INTEGER NOT NULL DEFAULT 50,
  monitor_side    TEXT NOT NULL DEFAULT 'top',
  vault_side      TEXT NOT NULL DEFAULT 'left',
  modem_side      TEXT NOT NULL DEFAULT 'right',
  redstone_side   TEXT NOT NULL DEFAULT 'bottom',
  wing            TEXT NOT NULL REFERENCES wings(id),
  color           TEXT,
  report_interval INTEGER NOT NULL DEFAULT 5,
  sort_order      INTEGER DEFAULT 0
);
```

`priority_labels` (1→Critical … 4→Low) is a fixed mapping — keep it as a constant
in the server code (and in the assembled JSON) rather than a table. It never changes.

**Why `computer_id` UNIQUE matters:** `universal_farm.lua` finds *itself* by
`computer_id`, and `central.lua` builds `ID_TO_FARM[computer_id]`. Two farms sharing a
`computer_id` would break both. The DB constraint + API validation enforce this — an
improvement over the current JSON, which has no guard (note: today `iron` uses
`computer_id: 1` and `central_computer_id` is `0`, so verify no collisions on seed).

---

## 4. Server changes (`monitor/server/`)

### 4.1 New files
- `db.js` — opens/creates `cabin.db`, runs schema DDL (idempotent), runs the seed
  on an empty DB.
- `farmsRepo.js` — data-access layer. All SQL lives here:
  - `listFarms()`, `getFarm(id)`, `createFarm(obj)`, `updateFarm(id, obj)`, `deleteFarm(id)`
  - `listWings()`, `createWing()`, `updateWing()`, `deleteWing()`
  - `getSetting(key)`, `setSetting(key, value)`
  - `assembleConfig()` → returns the full `farms.json`-shaped object (used by both
    `/api/farms-config` and `/config`).
- `validateFarm.js` — field validation (shared by create/update). Rules:
  - `id`: non-empty, `^[a-z0-9_]+$`, unique
  - `computer_id`: integer ≥ 0, unique, **and ≠ `central_computer_id`** (a farm and
    central must never share an ID — their rednet reports would collide)
  - `priority`: integer 1–4
  - `high_threshold`/`low_threshold`: 0–100, `low < high`
  - sides: one of `top|bottom|left|right|front|back`
  - `wing`: must reference an existing wing
  - `label`: non-empty
  - **Editing `computer_id` is allowed but warned:** the API accepts a changed
    `computer_id`, but the response flags it (and the dashboard/`manage.lua` surface a
    warning) — changing it re-points the entry at a *different* physical computer, which
    is only correct if the hardware was actually swapped. Setting `central_computer_id`
    is validated the same way (must not equal any farm's `computer_id`).

### 4.2 `server.js` edits
- Replace the `loadFarmsConfig()` file-read + module-level `farmsConfig` cache with
  calls into `farmsRepo`. Keep a small in-process cache that is **invalidated on any
  write** (so `farmLabel()` in alert code and `/api/farms-config` stay fast and fresh).
- `GET /api/farms-config` → `res.json(farmsRepo.assembleConfig())` (session auth; shape
  unchanged).
- **New `GET /config`** (X-API-Key auth) → same assembled config, for CC computers.
- **New CRUD routes** (auth: see 4.3):
  - `GET    /api/farms`            — list
  - `GET    /api/farms/:id`        — one
  - `POST   /api/farms`            — create (validate)
  - `PUT    /api/farms/:id`        — update (validate)
  - `DELETE /api/farms/:id`        — delete
  - `GET    /api/wings`, `POST/PUT/DELETE /api/wings[/:id]` — wing management
  - `GET    /api/settings`, `PUT /api/settings` — `central_computer_id`
- Apply the existing `express.json` limit + global error handler (already present).

### 4.3 Auth for CRUD (dashboard OR in-game)
Add a combined middleware `requireAuthOrApiKey`:
```js
const requireAuthOrApiKey = (req, res, next) => {
  if (req.session?.authenticated) return next()
  if (req.headers['x-api-key'] === process.env.API_KEY) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}
```
All `/api/farms*`, `/api/wings*`, `/api/settings` write routes use this so the
dashboard (session cookie) and `manage.lua` (API key) can both write. `GET /config`
stays API-key-only; `GET /api/farms-config` stays session-only (no change for dashboard).

### 4.4 Seeding
On first boot, if the `farms` table is empty, import `minecraft/farms.json`
(wings, farms, `central_computer_id`). Log the count. Idempotent — never overwrites an
existing DB. This makes the cutover zero-touch: deploy, server seeds itself from the
file already in the repo. **Fail loud, not silent:** if the seed data contains a
duplicate `computer_id` (or a farm whose `computer_id` equals `central_computer_id`),
the seeder logs the offending IDs and aborts rather than importing a half-broken set —
you find out immediately instead of debugging an always-OFFLINE farm later. (Your
current `farms.json` is clean: central = 0, farms = 1,2,4–19, no collisions.)

---

## 5. Dashboard changes (`monitor/client/`)

### 5.1 New "Manage Farms" admin UI
- New component `ManageFarms.vue` (modal/panel, reachable from `Header.vue` ⚙ menu
  alongside the existing Settings panel — likely a second gear/admin action).
- Lists farms grouped by wing (reuse store data); each row → edit / delete.
- `FarmEditForm.vue` — form for all farm fields (label, computer_id, priority dropdown,
  thresholds, the four sides, wing dropdown, color, report_interval). Used for both
  create and edit.
- Delete uses the existing `ConfirmModal.vue`.
- Wing management (add/rename/delete) — a small section in the same panel.
- Client-side validation mirrors the server (server remains authoritative).

### 5.2 `baseStore.js` additions
- CRUD actions: `createFarm`, `updateFarm`, `deleteFarm`, plus wing/settings actions,
  each calling the new endpoints via `api.js` (already supports GET/POST/DELETE; **add
  `put`** to `api.js`).
- After any successful mutation, call `loadFarmsConfig()` to refresh `farmsConfig`
  so `FarmGrid` and the manage UI reflect the change immediately.

### 5.3 No change required to
`FarmGrid.vue`, `FarmCard.vue`, `PowerCard.vue` — they already consume `farmsConfig`
shape from the store and will simply re-render after a refresh.

---

## 6. CC:Tweaked / Lua changes (`minecraft/`)

### 6.1 `central.lua`
- `loadFarmsConfig()` — replace the GitHub-raw `http.get(GITHUB_RAW .. "farms.json")`
  with `http.get(WEB_SERVER_URL .. "/config", { ["X-API-Key"] = WEB_API_KEY })`.
  Keep the `farms_cache.json` write + offline fallback exactly as-is.
- **Hot reload:** re-fetch config every N main-loop cycles (e.g. every ~30s) so DB
  edits (new farm, changed priority/threshold) propagate without a reboot. Rebuild
  `FARM_PRIORITIES` / `FARM_IDS` / `ID_TO_FARM` on each successful refresh.
- Remove `GITHUB_RAW` usage for config (can keep the constant only if still used by the
  updater; otherwise drop it).

### 6.2 `universal_farm.lua`
- Replace GitHub-raw fetch with the server `GET /config`, find own entry by
  `os.getComputerID()`. Keep cache fallback.
- **Hot reload:** periodically re-fetch so threshold/priority/side edits apply live.
  (Side changes still effectively need a reboot to re-wrap peripherals — document that.)
- Needs the server URL + API key. Today the farm scripts have no server config (only
  central does). Options: bake `WEB_SERVER_URL` + `WEB_API_KEY` into the script header
  (set by `installer.lua`), **or** keep farms fetching the bootstrap list from central
  over rednet. **Recommended:** add `WEB_SERVER_URL`/`WEB_API_KEY` to the universal_farm
  header, written by the installer — consistent with central, and avoids a rednet
  bootstrap dependency.

### 6.3 New `manage.lua` (in-game admin tool)
Menu-driven script run on the central computer (installable via `installer.lua`):
- **List farms** — pull `GET /config`, print id / label / computer_id / wing / priority.
- **Add farm** — prompt for fields (revives the old `askConfig` flow), `POST /api/farms`
  with `X-API-Key`. Show server validation errors.
- **Edit farm** — pick by id, prompt for changed fields, `PUT /api/farms/:id`.
- **Delete farm** — pick by id, confirm, `DELETE /api/farms/:id`.
- **Manage wings** — list/add/delete via `/api/wings`.
- **Set central_computer_id** — `PUT /api/settings`.
- Reads `WEB_SERVER_URL` + `WEB_API_KEY` from a small shared config or its own header.

### 6.4 `installer.lua`
- Add a menu entry to install `manage.lua`.
- When installing `universal_farm.lua`, prompt for and write `WEB_SERVER_URL` +
  `WEB_API_KEY` into the script header (so farms can reach `/config`).
- **Self-registration is the recommended way to add a farm.** After install, offer to
  `POST /api/farms` an entry for this computer (label/wing/sides/thresholds prompted),
  with `computer_id` filled **automatically** from `os.getComputerID()`. This is the
  only typo-proof path — the computer knows its own ID, so the DB↔hardware join key can
  never be entered wrong. Adding via the dashboard requires hand-typing the ID and is
  the fallback. Document "add new farms from the farm computer itself" as the happy path.

---

## 7. Migration / cutover sequence

1. Deploy server with DB layer. On boot it seeds `cabin.db` from the existing
   `farms.json`. `GET /api/farms-config` now serves from DB — **dashboard behaves
   identically** (verify byte-for-byte shape).
2. Deploy CRUD endpoints + dashboard Manage UI. Test create/edit/delete from the
   dashboard; confirm `farmsConfig` refreshes and `FarmGrid` updates.
3. Update `central.lua` to read `/config` from the server. Reboot central; confirm
   farms still appear and commands still flow.
4. Update `universal_farm.lua` + `installer.lua`; re-deploy to farm computers
   (one at a time — old GitHub-fetch and new server-fetch can coexist during rollout
   since both produce the same config shape).
5. Install `manage.lua` on central; test in-game CRUD round-trip (add a farm in game →
   appears on dashboard; edit on dashboard → central hot-reloads).
6. Update docs (`DEPLOYMENT.md`, TRD) to describe the DB as source of truth and the new
   "edit live, no git push" workflow.

**Rollback:** the DB seeds from `farms.json`, which stays in the repo. Reverting the
Lua scripts to GitHub-raw fetch + reverting the server restores the old behavior. Keep
a periodic `farms.json` export (see §8) for a known-good snapshot.

---

## 8. Operational concerns

- **DB persistence:** `cabin.db` lives in `monitor/server/data/` (git-ignored). It must
  survive deploys/`pm2 restart` — it does, since it's outside the Vite `public/` output.
  Document it in the backup routine.
- **Backup / export:** add `GET /api/farms.json` (or a `npm run export-farms` script)
  that writes the current DB back to `minecraft/farms.json` for a git-committable
  snapshot. Cheap insurance and keeps the seed file current.
- **`better-sqlite3` native build:** ships prebuilt binaries for common Node 20 / Linux
  targets; the DO droplet should `npm install` cleanly. If a prebuild is unavailable it
  compiles from source (needs `build-essential` + `python3`). Note in DEPLOYMENT.md.
- **Concurrency:** `better-sqlite3` is synchronous; with one PM2 process this is safe.
  If the server is ever scaled to multiple PM2 instances, switch SQLite to WAL mode
  (`PRAGMA journal_mode=WAL`) — set it anyway as a default.
- **Validation parity:** server is authoritative; dashboard + `manage.lua` show server
  errors rather than duplicating logic.

---

## 9. Testing plan

- **Seed correctness:** fresh DB seeded from `farms.json` → `assembleConfig()` deep-equals
  the original JSON (modulo key order).
- **Endpoint shape:** `GET /api/farms-config` and `GET /config` return identical bodies.
- **CRUD + validation:** create (happy path + each validation failure: dup id, dup
  computer_id, bad priority, low≥high, bad side, missing wing), update, delete.
- **Auth:** `/config` rejects missing/wrong API key; CRUD accepts session OR API key,
  rejects neither; `/api/farms-config` still rejects unauthenticated.
- **Dashboard round-trip:** add/edit/delete in UI → store refresh → `FarmGrid` reflects.
- **Lua (manual, in-game):** central reads `/config`; hot-reload picks up a dashboard
  edit; `manage.lua` add → dashboard shows it; cache fallback works with server down.

---

## 10. Proposed work breakdown (milestones)

| # | Milestone | Scope | Done when |
|---|-----------|-------|-----------|
| S1 | **Server DB layer** | `better-sqlite3`, `db.js`, `farmsRepo.js`, schema, seed from `farms.json`, `assembleConfig()`; switch `/api/farms-config` + alert `farmLabel()` to DB | Dashboard behaves identically; DB seeded; shape verified |
| S2 | **Server CRUD + `/config`** | validation, `/api/farms*`, `/api/wings*`, `/api/settings`, `GET /config`, `requireAuthOrApiKey`, cache invalidation | All CRUD + auth tests pass |
| S3 | **Dashboard Manage UI** | `ManageFarms.vue`, `FarmEditForm.vue`, store CRUD actions, `api.put`, header entry, delete confirm | Full CRUD from the browser, live refresh |
| S4 | **Lua config from server** | `central.lua` + `universal_farm.lua` read `/config` (cache fallback) + hot reload; installer writes server URL/key to farm header | Farms appear from DB; commands flow; edits hot-reload |
| S5 | **In-game `manage.lua`** | admin tool + installer entry + optional self-registration | In-game CRUD round-trips to dashboard |
| S6 | **Docs + ops** | `DEPLOYMENT.md`, TRD updates, export/backup script, `.gitignore` for `data/` | Docs describe DB-as-source-of-truth workflow |

Each milestone is independently committable and leaves the system working.

---

## 11. Open questions / risks

- **`computer_id` is the DB↔hardware join key** — it must equal the physical
  computer's `os.getComputerID()`. Three resolved defaults guard this:
  1. UNIQUE in the schema; `computer_id ≠ central_computer_id` enforced in validation;
     the seeder fails loud on any collision (§4.1, §4.4).
  2. Editing `computer_id` is **allowed but warned** — it re-points the entry at a
     different physical computer, only correct after a hardware swap (§4.1).
  3. **Self-registration is the recommended add path** — fills `computer_id`
     automatically from the computer itself, eliminating the only real typo risk (§6.4).
  Current `farms.json` is clean (central = 0, farms = 1,2,4–19), so the seed is safe.
- **Side edits need a reboot:** changing a farm's peripheral sides via CRUD won't
  re-wrap peripherals on a running `universal_farm.lua` until reboot — document this;
  thresholds/priority/label hot-reload fine.
- **API key in farm headers:** baking `WEB_API_KEY` into `universal_farm.lua` means the
  key sits on every farm computer (already true for `central.lua`). Acceptable for a
  private SMP; note it.
```
