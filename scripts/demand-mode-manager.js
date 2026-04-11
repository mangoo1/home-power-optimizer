#!/usr/bin/env node
/**
 * demand-mode-manager.js
 *
 * Runs every 5 minutes (triggered by cron).
 * 1. Fetch real-time data: SOC, home load, PV power, grid power
 * 2. Fetch Amber electricity prices (current + forecast)
 * 3. Run decision tree and switch inverter mode automatically
 * 4. Write data to SQLite (energy_log) at :00/:30 or on mode change
 * 5. Upsert daily summary (daily_summary table)
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// ── Configuration ─────────────────────────────────────────────────────────────
const AMBER_TOKEN = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID || "01KMN0H71HS5SYAE5P3E9WDGCD";
const ESS_TOKEN = process.env.ESS_TOKEN;
const MAC_HEX = process.env.ESS_MAC_HEX || "00534E0045FF";
const STATION_SN = process.env.ESS_STATION_SN || "EU1774416396356";

const WORKSPACE = path.resolve(__dirname, "..");
const DATA_DIR = path.join(WORKSPACE, "data");

// OpenClaw Gateway API
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || "18789";
const SELLING_MONITOR_CRON_NAME = "selling-monitor-active";
const ENERGY_LOG = path.join(DATA_DIR, "energy-log.jsonl");
const DB_PATH = path.join(DATA_DIR, "energy.db");

// SQLite (lazy-loaded)
let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    const Database = require("better-sqlite3");
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS energy_log (
        ts TEXT PRIMARY KEY, nem_time TEXT, soc REAL, batt_power REAL,
        home_load REAL, pv_power REAL, grid_power REAL, buy_price REAL,
        feedin_price REAL, spot_price REAL, demand_window INTEGER,
        mode INTEGER, mode_changed INTEGER, mode_reason TEXT, renewables REAL, alert TEXT,
        meter_buy_total REAL, meter_sell_total REAL,
        -- extended fields
        batt_voltage REAL, batt_current REAL,
        flow_pv REAL, flow_grid REAL, flow_battery REAL, flow_load REAL,
        today_charge_kwh REAL, today_discharge_kwh REAL,
        today_pv_kwh REAL, today_grid_buy_kwh REAL, today_grid_sell_kwh REAL,
        today_home_kwh REAL, today_carbon_kg REAL,
        amber_descriptor TEXT, amber_tariff_period TEXT,
        amber_cl_price REAL, amber_cl_descriptor TEXT, amber_cl_tariff_period TEXT,
        amber_feedin_price REAL, amber_spot_price REAL,
        next_demand_min REAL, reported_mode REAL,
        -- interval cost accounting (0.5h window)
        interval_buy_aud REAL,   -- grid import kWh * buy_price / 100
        interval_sell_aud REAL,  -- grid export kWh * feedin_price / 100
        interval_net_aud REAL,   -- interval_buy_aud - interval_sell_aud
        meter_buy_delta REAL,    -- meter_buy_total - prev meter_buy_total (actual kWh from meter)
        meter_sell_delta REAL,   -- meter_sell_total - prev meter_sell_total (actual kWh from meter)
        record_trigger TEXT      -- why this row was written: 'scheduled' | 'mode_change'
      );
      CREATE TABLE IF NOT EXISTS daily_summary (
        date TEXT PRIMARY KEY, intervals INTEGER DEFAULT 0,
        home_kwh REAL DEFAULT 0, grid_buy_kwh REAL DEFAULT 0,
        grid_sell_kwh REAL DEFAULT 0, cost_aud REAL DEFAULT 0,
        earnings_aud REAL DEFAULT 0, demand_peak_kw REAL DEFAULT 0,
        demand_charge_est REAL DEFAULT 0, avg_soc REAL DEFAULT 0,
        min_soc REAL DEFAULT 100, max_soc REAL DEFAULT 0,
        meter_buy_start REAL, meter_buy_end REAL,
        meter_sell_start REAL, meter_sell_end REAL
      );
      CREATE TABLE IF NOT EXISTS meter_daily (
        date TEXT PRIMARY KEY,
        buy_start REAL, buy_end REAL,
        sell_start REAL, sell_end REAL
      );
      CREATE TABLE IF NOT EXISTS daily_plan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        generated_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'lp',
        created_by TEXT,
        soc_at_gen REAL,
        has_demand_window INTEGER NOT NULL DEFAULT 0,
        demand_window_start INTEGER,
        demand_window_end INTEGER,
        charge_cutoff_hour INTEGER NOT NULL DEFAULT 20,
        pv_forecast_kwh REAL,
        pv_peak_kw REAL,
        charge_windows_json TEXT,
        intervals_json TEXT,
        notes TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(date, version)
      );
      CREATE TABLE IF NOT EXISTS plan_execution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        plan_id INTEGER REFERENCES daily_plan(id),
        plan_version INTEGER,
        action TEXT NOT NULL,
        reason TEXT,
        soc REAL,
        buy_price_c REAL,
        pv_kw REAL,
        home_load_kw REAL,
        charge_kw REAL,
        mode_from INTEGER,
        mode_to INTEGER,
        verify_ok INTEGER
      );
    `);
  } catch (e) {
    console.warn("[DB] better-sqlite3 not available:", e.message);
  }
  return _db;
}
const DAILY_SUMMARY = path.join(DATA_DIR, "daily-summary.json");
const TODAY_PLAN_PATH = path.join(DATA_DIR, 'today-plan.json');
const STATE_FILE = "/tmp/demand-mode-state.json";

// Inverter modes
const MODE = { SELF_USE: 0, TIMED: 1, PV_PRIORITY: 5, SELLING: 6, BACKUP: 1 };
const MODE_LABEL = { 0: "Self-use", 1: "Timed/Charging", 3: "Backup(unused)", 5: "PV-Priority", 6: "Selling", 7: "Voltage-Reg" };

// Strategy parameters
const SOC_MAX_CHARGE = 85;        // Target SOC default — may be overridden dynamically below
const SOC_MAX_CHARGE_ULTRACHEAP = 100; // % — charge to 100% when price <= this threshold
const ULTRACHEAP_PRICE_C = 7.0;   // ¢ — "ultra cheap" threshold
                                  // 85% chosen: above this BMS throttles charge rate,
                                  // PV surplus only earns ~2.8c feedIn — not worth grid charging
// SOC_MIN_SELL is time-dependent (see getSocMinSell() below):
//   00:00–10:59 Sydney → 12% (morning, enough time for grid/PV to recharge before demand window)
//   11:00–23:59 Sydney → 35% (afternoon/evening, must reserve for demand window + overnight)
// Cutoff changed from 14:00 to 11:00: after 11am there's not enough recharge time before 15:00 DW
const SOC_MIN_SELL_MORNING  = 12;
const SOC_MIN_SELL_AFTERNOON = 35;
const SOC_MIN_SELL_CUTOFF_HOUR = 11; // switch to afternoon reserve at 11:00 Sydney time
const SELL_STOP_HOUR = 21;        // Hard stop selling after this hour (Sydney time) — reserve battery for overnight
const SOC_WARN = 20;              // Alert threshold: SOC too low during demand window
const SELL_FEEDIN_MIN = 0;        // Hard floor for selling (0 = rely solely on avg-buy+margin logic)
const CHARGE_SPOT_MAX = 0;        // Max spot price for free charging (spot <= 0 = free)
const BATTERY_CAPACITY = 42;      // kWh total battery capacity
const BATTERY_MIN_SOC = 10;       // Min SOC % (reserve, never discharge below this)
const INVERTER_MAX_DISCHARGE = 5; // kW max inverter discharge power

// ESS app API headers
const ESS_HEADERS = {
  lang: "en", platform: "linux", projectType: "1", source: "app",
  Origin: "https://euapp.ess-link.com", Referer: "https://euapp.ess-link.com/",
};

// ── Sydney time helpers ───────────────────────────────────────────────────────
// Always use Intl/toLocaleString — no hardcoded offsets, DST-safe.
function sydneyNow() {
  // Returns a plain object with Sydney local time fields
  const s = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  // "07/04/2026, 19:39:45" → parse fields
  const [datePart, timePart] = s.split(', ');
  const [dd, mo, yyyy] = datePart.split('/');
  const [hh, mm, ss] = timePart.replace('24:', '00:').split(':');
  return {
    year: parseInt(yyyy), month: parseInt(mo), day: parseInt(dd),
    hour: parseInt(hh), minute: parseInt(mm), second: parseInt(ss),
    hhmm: hh.padStart(2,'0') + mm.padStart(2,'0'),       // "1939"
    hhmmss: hh.padStart(2,'0')+':'+mm.padStart(2,'0')+':'+ss.padStart(2,'0'), // "19:39:45"
    dateStr: `${yyyy}-${mo.padStart(2,'0')}-${dd.padStart(2,'0')}`,  // "2026-04-07"
  };
}

function getSydneyHour() {
  return sydneyNow().hour;
}

function getSydneyDate(d = new Date()) {
  const s = d.toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const [datePart, timePart] = s.split(', ');
  const [dd, mo, yyyy] = datePart.split('/');
  const [hh, mm, ss] = timePart.replace('24:', '00:').split(':');
  return new Date(`${yyyy}-${mo}-${dd}T${hh}:${mm}:${ss}`);
}

function getSydneyOffsetMs(d = new Date()) {
  // Keep for backward compat — but prefer sydneyNow() for new code
  const utcH = d.getUTCHours();
  const sydH = parseInt(d.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hour12: false }), 10);
  let diff = sydH - utcH;
  if (diff < -12) diff += 24;
  if (diff > 12)  diff -= 24;
  return diff * 3600 * 1000;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
    }, (res) => {
      let resp = "";
      res.on("data", c => resp += c);
      res.on("end", () => { try { resolve(JSON.parse(resp)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

// ESS Web API headers (Bearer prefix, different from app API)
const ESS_WEB_HEADERS = {
  Authorization: `Bearer ${ESS_TOKEN}`,
  Referer: "https://eu.ess-link.com/appViews/appHome",
  lang: "en",
  showloading: "false",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36",
};

// ── ESS API ───────────────────────────────────────────────────────────────────
async function essGet(endpoint) {
  if (!ESS_TOKEN) return null;
  try {
    const data = await httpsGet(
      `https://eu.ess-link.com/api/app/deviceInfo/${endpoint}?macHex=${MAC_HEX}`,
      { Authorization: ESS_TOKEN, ...ESS_HEADERS }
    );
    return data.code === 200 ? data.data : null;
  } catch { return null; }
}

async function essWebGet(path) {
  if (!ESS_TOKEN) return null;
  try {
    const data = await httpsGet(`https://eu.ess-link.com${path}`, ESS_WEB_HEADERS);
    return data.code === 200 ? data.data : null;
  } catch { return null; }
}

function findVal(items, index) {
  if (!items) return null;
  const item = Array.isArray(items) ? items.find(i => i.index === index) : items[index];
  return item?.value ?? null;
}

function findValStr(items, index) {
  if (!items) return null;
  const item = Array.isArray(items) ? items.find(i => i.index === index) : items[index];
  return item?.valueStr != null ? parseFloat(item.valueStr) : null;
}

function loadTodayPlan() {
  try {
    const db = getDb();
    if (!db) return null;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const row = db.prepare(
      'SELECT * FROM daily_plan WHERE date=? AND is_active=1 ORDER BY version DESC LIMIT 1'
    ).get(today);
    if (!row) {
      console.log('[PLAN] No active plan in DB for today, falling back to dynamic threshold');
      return null;
    }
    const plan = {
      date: row.date,
      version: row.version,
      source: row.source,
      generatedAt: row.generated_at,
      currentSoc: row.soc_at_gen,
      hasDemandWindow: !!row.has_demand_window,
      demandWindowStart: row.demand_window_start,
      demandWindowEnd: row.demand_window_end,
      chargeCutoffHour: row.charge_cutoff_hour,
      pvForecastKwh: row.pv_forecast_kwh,
      pvPeakKw: row.pv_peak_kw,
      chargeWindows: JSON.parse(row.charge_windows_json || '[]'),
      intervals: JSON.parse(row.intervals_json || '[]'),
      notes: row.notes,
    };
    console.log(`[PLAN] Loaded v${row.version} from DB (source=${row.source}, date=${today}, hasDW=${plan.hasDemandWindow}, cutoff=${plan.chargeCutoffHour}, windows=${plan.chargeWindows.length})`);
    return plan;
  } catch(e) {
    console.log('[PLAN] Failed to load plan from DB:', e.message);
    return null;
  }
}

function savePlanOverride({ chargeWindows, chargeCutoffHour, hasDemandWindow, notes, createdBy }) {
  try {
    const db = getDb();
    if (!db) return false;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    db.prepare('UPDATE daily_plan SET is_active=0 WHERE date=? AND is_active=1').run(today);
    const lastVer = db.prepare('SELECT MAX(version) as v FROM daily_plan WHERE date=?').get(today);
    const newVersion = (lastVer?.v ?? 0) + 1;
    const cur = db.prepare('SELECT soc_at_gen FROM daily_plan WHERE date=? ORDER BY version DESC LIMIT 1').get(today);
    db.prepare(`
      INSERT INTO daily_plan (date, version, generated_at, source, created_by, soc_at_gen,
        has_demand_window, charge_cutoff_hour, charge_windows_json, notes, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)
    `).run(today, newVersion, new Date().toISOString(), 'manual', createdBy || 'user',
      cur?.soc_at_gen ?? null, hasDemandWindow ? 1 : 0, chargeCutoffHour ?? 20,
      JSON.stringify(chargeWindows || []), notes || null);
    console.log(`[PLAN] Saved manual override v${newVersion} to DB`);
    return newVersion;
  } catch(e) {
    console.error('[PLAN] savePlanOverride failed:', e.message);
    return false;
  }
}

async function getESSData() {
  const [battery, load, meter, pv, flow, battDetails, runInfo] = await Promise.all([
    essGet("getBatteryInfo"),
    essGet("getLoadInfo"),
    essGet("getMeterInfo"),
    essGet("getPhotovoltaicInfo"),
    essWebGet(`/api/web/station/totalFlowDiagram?stationSn=${STATION_SN}`),
    essWebGet(`/api/web/deviceInfo/getBatteryDetailsInfo?stationSn=${STATION_SN}`),
    essWebGet(`/api/web/deviceInfo/getDevicRunningInfo?stationSn=${STATION_SN}`),
  ]);

  return {
    // App API — realtime instantaneous values
    soc:            findVal(battery, "0x1212"),       // % state of charge
    battPower:      findVal(battery, "0x1210"),       // kW (positive=charging, negative=discharging)
    battVoltage:    findVal(battery, "0x120C"),       // V
    battCurrent:    findVal(battery, "0x120E"),       // A
    homeLoad:       findVal(load, "0x1274"),          // kW total home load
    gridPower:      findVal(meter, "0xA112"),         // kW: negative=import / positive=export
    pvPowerApp:     findValStr(pv, "0x1270"),         // kW realtime PV (valueStr avoids encoding bug)
    pvEnergy:       findVal(pv, "0x125C"),            // kWh cumulative PV generation
    purchasedTotal: findVal(meter, "0x1240"),         // kWh cumulative grid import
    feedTotal:      findVal(meter, "0x1242"),         // kWh cumulative grid export

    // Web API — flow diagram (single-call energy snapshot)
    flowPV:         flow?.totalPVPower      ?? null,  // kW solar
    flowGrid:       flow?.totalGridPower    ?? null,  // kW: negative=import / positive=export
    flowBattery:    flow?.totalBatteryPower ?? null,  // kW: positive=charging
    flowLoad:       flow?.totalLoadPower    ?? null,  // kW AC home load

    // Web API — battery details (today's kWh)
    todayChargeKwh:    battDetails?.todaycharge    ?? null,
    todayDischargeKwh: battDetails?.todaydischarge ?? null,

    // Web API — running info (today's totals + current reported mode)
    todayPvKwh:       runInfo?.x1264 ?? null,
    todayBattChargeKwh2: runInfo?.x1266 ?? null,
    todayGridBuyKwh:  runInfo?.x126A ?? null,
    todayGridSellKwh: runInfo?.x126C ?? null,
    todayHomeKwh:     runInfo?.x126E ?? null,
    todayCarbonKg:    runInfo?.carbon ?? null,
    reportedMode:     runInfo?.x300C ?? null,        // current mode as reported by portal
  };
}

// PV power: prefer app API real value; fall back to energy-balance estimate.
// Energy balance: homeLoad = pvPower + battDischarge + gridImport
function calcPVPower(ess) {
  if (ess.pvPowerApp != null) return ess.pvPowerApp;
  if (ess.homeLoad == null) return null;
  const battDischarge = ess.battPower != null ? -ess.battPower : 0; // discharge is positive
  const gridImport = ess.gridPower != null ? -ess.gridPower : 0;    // import is positive
  return Math.max(0, ess.homeLoad - battDischarge + gridImport);
}

// ── Cron management ───────────────────────────────────────────────────────────
function httpLocal(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = require("http").request({
      hostname: "localhost", port: parseInt(GATEWAY_PORT),
      path, method,
      timeout: 5000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("httpLocal timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

async function getSellingCronId() {
  try {
    const r = await httpLocal("GET", "/api/cron/jobs", null);
    const jobs = r.jobs || [];
    const job = jobs.find(j => j.name === SELLING_MONITOR_CRON_NAME && j.enabled);
    return job?.id || null;
  } catch { return null; }
}

async function createSellingCron() {
  const existingId = await getSellingCronId();
  if (existingId) { console.log(`[INFO] selling-monitor cron already active (${existingId})`); return; }
  const payload = {
    name: SELLING_MONITOR_CRON_NAME,
    schedule: { kind: "every", everyMs: 300000 },
    sessionTarget: "main",
    payload: {
      kind: "systemEvent",
      text: `[Selling Safety Monitor]\n\nAMBER_API_TOKEN=${AMBER_TOKEN} ESS_TOKEN=${ESS_TOKEN} ESS_MAC_HEX=${MAC_HEX} AMBER_SITE_ID=${AMBER_SITE_ID} node /home/deven/.openclaw/workspace/scripts/selling-monitor.js\n\nIf output contains [EXIT SELL] or [ENTER SELL] or warning, relay to user. Otherwise silent.`,
    },
  };
  try {
    const r = await httpLocal("POST", "/api/cron/jobs", payload);
    console.log(`[INFO] selling-monitor cron created: ${r.id}`);
  } catch (e) { console.error(`[ERROR] Failed to create selling cron: ${e.message}`); }
}

async function deleteSellingCron() {
  const id = await getSellingCronId();
  if (!id) return;
  try {
    await httpLocal("DELETE", `/api/cron/jobs/${id}`, null);
    console.log(`[INFO] selling-monitor cron deleted (${id})`);
  } catch (e) { console.error(`[ERROR] Failed to delete selling cron: ${e.message}`); }
}

// ── Inverter control ──────────────────────────────────────────────────────────
async function setParam(index, data) {
  if (!ESS_TOKEN) return false;
  try {
    const r = await httpsPost(
      "https://eu.ess-link.com/api/app/deviceInfo/setDeviceParam",
      { data, macHex: MAC_HEX, index },
      { Authorization: ESS_TOKEN, ...ESS_HEADERS }
    );
    return r.code === 200;
  } catch { return false; }
}

async function setWeekParam(index, data) {
  if (!ESS_TOKEN) return false;
  try {
    const r = await httpsPost(
      "https://eu.ess-link.com/api/app/deviceInfo/setDeviceWeekParam",
      { data, macHex: MAC_HEX, index },
      { Authorization: ESS_TOKEN, ...ESS_HEADERS }
    );
    return r.code === 200;
  } catch { return false; }
}

async function setDateParam(index, data) {
  if (!ESS_TOKEN) return false;
  try {
    const r = await httpsPost(
      "https://eu.ess-link.com/api/app/deviceInfo/setDeviceDateOrTimeParam",
      { data, macHex: MAC_HEX, index },
      { Authorization: ESS_TOKEN, ...ESS_HEADERS }
    );
    return r.code === 200;
  } catch { return false; }
}

async function setMode(mode) {
  return setParam("0x300C", mode);
}

// ── Timed mode helpers (shared by buy and sell) ───────────────────────────────
// Returns { aest, fmt2, startHHMM, endHHMM, clockStr, yesterday, tomorrow }
// endHHMM = demand window start - 5 min, or 18:00 if no DW today.
// 18:00 default ensures charging always stops before any potential DW (15:00–20:00).
// Using a fixed large window instead of rolling 10-min prevents charging from
// dropping out between cron runs.
function timedModeTimeContext(nextDemandMinutes) {
  const syd  = sydneyNow();
  const fmt2 = n => String(n).padStart(2, '0');

  // start = now - 1 min (window already active)
  const startTotalMins = syd.hour * 60 + syd.minute - 1;
  const startH = Math.floor(((startTotalMins % 1440) + 1440) % 1440 / 60);
  const startM = ((startTotalMins % 60) + 60) % 60;
  const startHHMM = fmt2(startH) + fmt2(startM);

  // end = demand window start - 5 min, or 18:00 for charge / 21:00 for sell
  // Caller passes mode via sellMode flag; here we default to charge end (18:00)
  // Sell end is handled separately in setTimedChargeDischarge
  let endHHMM;
  if (nextDemandMinutes != null && nextDemandMinutes > 15) {
    const nowMs  = Date.now();
    const endMs  = nowMs + (nextDemandMinutes - 5) * 60 * 1000;
    const endSyd = new Date(endMs).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney', hour12: false, hour: '2-digit', minute: '2-digit'
    }).replace('24:', '00:');
    const [eh, em] = endSyd.split(':');
    endHHMM = fmt2(parseInt(eh)) + fmt2(parseInt(em));
  } else {
    // No demand window — charge until 18:00, sell until 21:00 (set by caller)
    endHHMM = '1800';
    const nowMins = syd.hour * 60 + syd.minute;
    if (nowMins >= 18 * 60) endHHMM = '2359';
  }

  // Clock string for inverter sync
  const clockStr = `${syd.dateStr} ${syd.hhmmss}`;
  const yesterday = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().substring(0, 10);
  })();
  const tomorrow = (() => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return d.toISOString().substring(0, 10);
  })();

  return { startHHMM, endHHMM, clockStr, yesterday, tomorrow };
}

// Set Timed/Selling mode (discharge to grid).
// Steps:
//   0. Sync inverter clock
//   1. Set mode = Timed (1)
//   2. startTime = now - 1 min  (window already active)
//   3. endTime   = now + 10 min (rolling)
//   4. discharge power = 5 kW   (0xC0BC)
//   5. otherMode = 0             (0x314E)
//   6. weekdays = all            (0xC0B4)
//   7. startDate = yesterday     (0xC0B6)
//   8. endDate = tomorrow        (0xC0B8)
async function setTimedChargeDischarge({ mode, powerKw, tag, nextDemandMinutes }) {
  // mode: 'sell' | 'charge'
  // powerKw: number — for sell = discharge kW (0xC0BC), for charge = charge kW (0xC0BA)
  // tag: log prefix e.g. '[SELL]' or '[BUY]'
  if (!ESS_TOKEN) { console.log(`[SKIP] No ESS_TOKEN, would set ${tag} Timed mode`); return false; }

  const { startHHMM, endHHMM: chargeEndHHMM, clockStr, yesterday, tomorrow } = timedModeTimeContext(nextDemandMinutes);

  // Sell mode: end at SELL_STOP_HOUR (21:00) — fixed, not rolling +10min
  // This ensures a missed cron run won't cut selling short mid-session
  const sellEndHHMM = String(SELL_STOP_HOUR).padStart(2,'0') + '00';
  const endHHMM = mode === 'sell' ? sellEndHHMM : chargeEndHHMM;

  console.log(`${tag} Setting Timed mode (${mode}): ${startHHMM}–${endHHMM} AEST, clock=${clockStr}, dates ${yesterday}–${tomorrow}, power=${powerKw}kW`);

  const steps = mode === 'sell' ? [
    { label: `syncClock=${clockStr}`,  fn: () => httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceDateParam', { data: clockStr, macHex: MAC_HEX, index: '0x3050' }, { Authorization: ESS_TOKEN, ...ESS_HEADERS }).then(r => r.code === 200).catch(() => false) },
    { label: 'mode=Timed(1)',          fn: () => setParam('0x300C',  1) },
    { label: `sellStart=${startHHMM}`, fn: () => setParam('0xC018', startHHMM) },
    { label: `sellEnd=${endHHMM}`,     fn: () => setParam('0xC01A', endHHMM) },
    { label: `discharge=${powerKw}kW`, fn: () => setParam('0xC0BC', powerKw) },
    { label: 'charge=0kW',             fn: () => setParam('0xC0BA', 0) },    // prevent simultaneous charging
    { label: 'chargeStart=0000',       fn: () => setParam('0xC014', '0000') }, // collapse charge window
    { label: 'chargeEnd=0000',         fn: () => setParam('0xC016', '0000') }, // collapse charge window
    { label: 'otherMode=0',            fn: () => setParam('0x314E', 0) },
    { label: 'weekdays=all',           fn: () => setWeekParam('0xC0B4', [1,2,3,4,5,6,0]) },
    { label: `startDate=${yesterday}`, fn: () => setDateParam('0xC0B6', yesterday) },
    { label: `endDate=${tomorrow}`,    fn: () => setDateParam('0xC0B8', tomorrow) },
  ] : [
    // Charge from grid: collapse sell window, set charge window + power, zero discharge
    { label: `syncClock=${clockStr}`,    fn: () => httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceDateParam', { data: clockStr, macHex: MAC_HEX, index: '0x3050' }, { Authorization: ESS_TOKEN, ...ESS_HEADERS }).then(r => r.code === 200).catch(() => false) },
    { label: 'mode=Timed(1)',            fn: () => setParam('0x300C',  1) },
    { label: `chargeStart=${startHHMM}`, fn: () => setParam('0xC014', startHHMM) },
    { label: `chargeEnd=${endHHMM}`,     fn: () => setParam('0xC016', endHHMM) },
    { label: `charge=${powerKw}kW`,      fn: () => setParam('0xC0BA', powerKw) },
    { label: 'discharge=0kW',            fn: () => setParam('0xC0BC', 0) },    // prevent simultaneous discharging
    { label: 'sellStart=0000',           fn: () => setParam('0xC018', '0000') }, // collapse sell window
    { label: 'sellEnd=0000',             fn: () => setParam('0xC01A', '0000') }, // collapse sell window
    { label: 'otherMode=0',              fn: () => setParam('0x314E', 0) },
    { label: 'weekdays=all',             fn: () => setWeekParam('0xC0B4', [1,2,3,4,5,6,0]) },
    { label: `startDate=${yesterday}`,   fn: () => setDateParam('0xC0B6', yesterday) },
    { label: `endDate=${tomorrow}`,      fn: () => setDateParam('0xC0B8', tomorrow) },
  ];

  for (const step of steps) {
    const ok = await step.fn();
    console.log(`${tag}   ${step.label} -> ${ok ? 'OK' : 'FAILED'}`);
    if (!ok && step.label.startsWith('mode=')) return false; // mode step is critical
    await new Promise(r => setTimeout(r, 500));
  }
  return true;
}

// Convenience wrappers
async function setSellingMode(nextDemandMinutes, powerKw = 5) {
  const clampedPower = Math.min(5, Math.max(0, powerKw));
  console.log(`[SELL] discharge power=${clampedPower.toFixed(2)}kW (requested=${powerKw.toFixed(2)}kW)`);
  return setTimedChargeDischarge({ mode: 'sell', powerKw: clampedPower, tag: '[SELL]', nextDemandMinutes });
}

// chargeGridKw: dynamic charge power calculation
// Logic: grid must supply (homeLoad - pvPower) for the house, plus chargeKw for the battery.
// Total grid import = (homeLoad - pvPower) + chargeKw <= MAX_GRID_TARGET
// => chargeKw <= MAX_GRID_TARGET - homeLoad + pvPower
// Capped at MAX_CHARGE_KW (inverter limit), floor at 0. If below MIN_CHARGE_KW, skip charging.
const MAX_GRID_TARGET  = parseFloat(process.env.MAIN_BREAKER_KW ?? '7.7'); // kW — read from .env, default 7.7kW (32A@240V)
const MAX_GRID_IMPORT_KW = MAX_GRID_TARGET - 0.2; // hard guard
const MAX_CHARGE_KW    = 5.0;   // kW inverter max charge rate
const MIN_CHARGE_KW    = 0.2;   // kW minimum — allow trickle charge during high-load (hot water) periods
const CHARGE_SAFETY_BUFFER = 0.2; // kW safety headroom — small buffer, PV already offsets house load dynamically
// HIGH_LOAD_ABORT_KW: absolute hard stop — only abort charging when grid would genuinely exceed breaker
const HIGH_LOAD_ABORT_KW      = MAX_GRID_TARGET - 0.3; // kW
const HIGH_LOAD_THRESHOLD_KW  = 3.5; // kW — above this = big appliance running (e.g. hot water heater)
const THROTTLE_CHARGE_KW      = 0.5; // kW — trickle charge when high load detected

function calcChargeKw(homeLoad, pvPower) {
  // netHouseDraw = what grid actually supplies to house after PV offsets it
  // chargeKw = remaining breaker headroom after house draw and safety buffer
  // PV already reduces netHouseDraw, so on sunny days we can charge MORE even when homeLoad is high
  const netHouseDraw = (homeLoad ?? 0) - (pvPower ?? 0);
  const available = MAX_GRID_TARGET - netHouseDraw - CHARGE_SAFETY_BUFFER;
  const chargeKw = Math.min(MAX_CHARGE_KW, Math.max(0, available));
  return parseFloat(chargeKw.toFixed(2));
}

async function setChargingMode(homeLoad, pvPower, nextDemandMinutes, throttled = false, planOverrideKw = null) {
  let chargeKw;
  const netDraw = (homeLoad ?? 0) - (pvPower ?? 0);

  if (planOverrideKw === 0) {
    // Grid-standby: chargeKw=0, discharge=0 — grid supplies home, battery idles
    console.log(`[BUY] Grid-standby mode: chargeKw=0, discharge=0 (homeLoad=${(homeLoad??0).toFixed(2)}kW PV=${(pvPower??0).toFixed(2)}kW)`);
    return setTimedChargeDischarge({ mode: 'charge', powerKw: 0, tag: '[STANDBY]', nextDemandMinutes });
  } else if (planOverrideKw !== null && planOverrideKw > 0) {
    const dynKw = calcChargeKw(homeLoad, pvPower);
    chargeKw = Math.min(planOverrideKw, dynKw);
    console.log(`[BUY] chargeKw=${chargeKw.toFixed(2)}kW (plan=${planOverrideKw.toFixed(2)}kW, realtime=${dynKw.toFixed(2)}kW, using min)`);
  } else if (throttled) {
    chargeKw = THROTTLE_CHARGE_KW;
  } else {
    chargeKw = calcChargeKw(homeLoad, pvPower);
  }
  console.log(`[BUY] homeLoad=${(homeLoad??0).toFixed(2)}kW PV=${(pvPower??0).toFixed(2)}kW netDraw=${netDraw.toFixed(2)}kW → chargeKw=${chargeKw.toFixed(2)}kW (breaker=${MAX_GRID_TARGET}kW buffer=${CHARGE_SAFETY_BUFFER}kW)`);
  if (chargeKw < MIN_CHARGE_KW) {
    console.log(`[BUY] chargeKw=${chargeKw.toFixed(2)}kW < ${MIN_CHARGE_KW}kW min — skipping charge (grid headroom exhausted)`);
    return false;
  }
  const tag = throttled ? '[BUY-THROTTLE]' : '[BUY]';
  return setTimedChargeDischarge({ mode: 'charge', powerKw: chargeKw, tag, nextDemandMinutes });
}

// Update rolling end time window for active Selling mode (called each cron run while selling).
// Skips the API call if the target end time hasn't changed since last successful send.
async function updateSellingEndTime(state) {
  const syd = sydneyNow();
  const stopHour = syd.hour < SELL_STOP_HOUR ? SELL_STOP_HOUR : 23;
  const stopMin  = syd.hour < SELL_STOP_HOUR ? 0 : 59;
  const endHHMM  = String(stopHour).padStart(2,'0') + String(stopMin).padStart(2,'0');

  // Skip if already successfully sent this exact value
  if (state.lastSellEndSent === endHHMM) {
    console.log(`[SELL] End time ${endHHMM} already set, skipping`);
    return true;
  }

  let ok = await setParam('0xC01A', endHHMM);
  if (!ok) {
    // Retry once after short delay
    await new Promise(r => setTimeout(r, 1000));
    ok = await setParam('0xC01A', endHHMM);
  }
  console.log(`[SELL] Rolling end time -> ${endHHMM} ${ok ? 'OK' : 'FAILED'}`);
  if (ok) state.lastSellEndSent = endHHMM;
  return ok;
}

// Read current inverter mode from portal (0x300C)
async function getReportedMode() {
  try {
    const data = await essWebGet(`/api/web/deviceInfo/getDevicRunningInfo?stationSn=${STATION_SN}`);
    return data?.x300C ?? null;
  } catch { return null; }
}

// Read current grid power (negative = import, positive = export)
async function getGridPower() {
  try {
    const data = await essGet('getMeterInfo');
    return data ? findVal(data, '0xA112') : null;
  } catch { return null; }
}

// Set mode with post-switch verification and up to 4 retries (5 attempts total).
// For Selling mode, uses the full Timed discharge setup.
// For Charging mode (BACKUP), uses the Timed charge setup with dynamic power calc.
// Also verifies grid is actually exporting (gridPower > 0) for Selling.
// Returns true if mode was confirmed, false if all attempts failed.
async function setModeWithVerify(targetMode, { homeLoad, pvPower, nextDemandMinutes, sellPowerKw, throttled = false, planChargeKw = null } = {}) {
  const label = MODE_LABEL[targetMode] ?? targetMode;
  const isTimed = targetMode === MODE.SELLING || targetMode === MODE.BACKUP;
  const maxAttempts = isTimed ? 2 : 5; // Timed setup: max 2 (multi-step × 2 costly); Self-use/others: up to 5
  // Self-use needs longer wait — inverter takes time to exit Timed mode
  const verifyWaitMs = targetMode === MODE.SELF_USE ? 6000 : 4000;
  const retryWaitMs  = targetMode === MODE.SELF_USE ? 5000 : 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Use full Timed mode setup for Selling/Charging; simple setMode for others
    let ok;
    if (targetMode === MODE.SELLING) {
      ok = await setSellingMode(nextDemandMinutes, sellPowerKw);
    } else if (targetMode === MODE.BACKUP) {
      ok = await setChargingMode(homeLoad, pvPower, nextDemandMinutes, throttled, planChargeKw);
      if (!ok) {
        console.warn(`[WARN] Charging setup skipped or failed (attempt ${attempt}/${maxAttempts})`);
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 3000));
        continue;
      }
    } else {
      ok = await setMode(targetMode);
    }

    if (!ok) {
      console.warn(`[WARN] Mode setup failed (attempt ${attempt}/${maxAttempts})`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    // Wait for inverter to apply
    await new Promise(r => setTimeout(r, verifyWaitMs));

    const reported = await getReportedMode();

    if (targetMode === MODE.SELLING) {
      // For Selling: verify mode=Timed(1) AND grid is exporting
      const gridPower = await getGridPower();
      const modeOk = reported === MODE.TIMED; // Timed mode = 1
      const exportOk = gridPower != null && gridPower > 0;
      console.log(`[VERIFY] Selling check: mode=${reported}(${MODE_LABEL[reported]}) grid=${gridPower?.toFixed(2)}kW`);
      if (modeOk && exportOk) {
        console.log(`[VERIFY] Selling confirmed ✓ (mode=Timed, grid export=${gridPower.toFixed(2)}kW)`);
        return true;
      }
      if (modeOk && !exportOk) {
        console.warn(`[WARN] Mode=Timed but grid not exporting (${gridPower?.toFixed(2)}kW) — attempt ${attempt}/${maxAttempts}`);
      } else {
        console.warn(`[WARN] Mode mismatch: expected Timed(1), got ${reported}(${MODE_LABEL[reported]}) — attempt ${attempt}/${maxAttempts}`);
      }
    } else if (targetMode === MODE.BACKUP) {
      // For Backup/Charging: inverter reports Timed(1) when charging via Timed mode — accept that
      const modeOk = reported === MODE.TIMED || reported === MODE.BACKUP;
      if (modeOk) {
        console.log(`[VERIFY] Charging confirmed ✓ (mode=${reported}(${MODE_LABEL[reported] ?? reported}))`);
        return true;
      }
      console.warn(`[WARN] Mode mismatch after attempt ${attempt}/${maxAttempts}: expected Timed/Backup, got ${reported}(${MODE_LABEL[reported] ?? reported})`);
    } else if (targetMode === MODE.SELF_USE) {
      // Self-use: send setMode(0) then verify reported mode is 0.
      // Inverter may lag after exiting Timed mode — retry up to maxAttempts.
      if (reported === MODE.SELF_USE) {
        console.log(`[VERIFY] Self-use confirmed ✓ (reported=0)`);
        return true;
      }
      console.warn(`[WARN] Self-use not confirmed (reported=${reported}(${MODE_LABEL[reported] ?? reported})) — attempt ${attempt}/${maxAttempts}`);
    } else {
      if (reported === targetMode) {
        console.log(`[VERIFY] Mode confirmed: ${label} (reported=${reported}) ✓`);
        return true;
      }
      console.warn(`[WARN] Mode mismatch after attempt ${attempt}/${maxAttempts}: expected ${targetMode}(${label}), got ${reported}(${MODE_LABEL[reported] ?? reported})`);
    }

    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, retryWaitMs));
  }
  console.error(`[ERROR] Mode switch to ${label} failed after ${maxAttempts} attempts`);
  return false;
}

// ── Solar forecast helper ─────────────────────────────────────────────────────
// Reads current-hour solar data from the solar_forecast table (populated by solar-forecast.js).
// Falls back to null if not available — does not call external API inline.
function getCurrentSolarData() {
  try {
    const db = getDb();
    if (!db) return { solar_wm2: null, cloud_cover_pct: null };
    const now = new Date();
    const sydneyNow = new Date(now.getTime() + getSydneyOffsetMs(now));
    const today = sydneyNow.toISOString().substring(0, 10);
    const hour  = sydneyNow.getUTCHours();
    const target = `${today}T${String(hour).padStart(2, '0')}:00`;

    const row = db.prepare('SELECT forecast_json FROM solar_forecast WHERE date=?').get(today);
    // Do NOT close db here — getDb() returns a shared singleton connection
    if (!row) return { solar_wm2: null, cloud_cover_pct: null };

    const fc = JSON.parse(row.forecast_json);
    const idx = fc.time.indexOf(target);
    if (idx === -1) return { solar_wm2: null, cloud_cover_pct: null };
    return {
      solar_wm2:       fc.sw[idx]    ?? null,
      cloud_cover_pct: fc.cloud[idx] ?? null,
    };
  } catch { return { solar_wm2: null, cloud_cover_pct: null }; }
}


function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { currentMode: null, lastSwitchTime: null, chargeExitCount: 0, chargeEntryCount: 0, extremelyLowEntryCount: 0, elExitCount: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Data logging ──────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function appendLog(record) {
  ensureDataDir();
  // 1. Write JSONL backup
  fs.appendFileSync(ENERGY_LOG, JSON.stringify(record) + "\n");

  // 2. Write to SQLite
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO energy_log
        (ts, nem_time, soc, batt_power, home_load, pv_power, grid_power,
         buy_price, feedin_price, spot_price, demand_window, mode, mode_changed, mode_reason, renewables, alert,
         meter_buy_total, meter_sell_total,
         batt_voltage, batt_current,
         flow_pv, flow_grid, flow_battery, flow_load,
         today_charge_kwh, today_discharge_kwh,
         today_pv_kwh, today_grid_buy_kwh, today_grid_sell_kwh, today_home_kwh, today_carbon_kg,
         amber_descriptor, amber_tariff_period,
         amber_cl_price, amber_cl_descriptor, amber_cl_tariff_period,
         amber_feedin_price, amber_spot_price,
         next_demand_min, reported_mode,
         interval_buy_aud, interval_sell_aud, interval_net_aud,
         meter_buy_delta, meter_sell_delta, record_trigger,
         charge_kw, discharge_kw, mode_verify_ok, mode_from, mode_to,
         solar_wm2, cloud_cover_pct)
      VALUES
        (@ts, @nemTime, @soc, @battPower, @homeLoad, @pvPower, @gridPower,
         @buyPrice, @feedInPrice, @spotPrice, @demandWindow, @mode, @modeChanged, @modeReason, @renewables, @alert,
         @meterBuyTotal, @meterSellTotal,
         @battVoltage, @battCurrent,
         @flowPV, @flowGrid, @flowBattery, @flowLoad,
         @todayChargeKwh, @todayDischargeKwh,
         @todayPvKwh, @todayGridBuyKwh, @todayGridSellKwh, @todayHomeKwh, @todayCarbonKg,
         @descriptor, @tariffPeriod,
         @clPrice, @clDescriptor, @clTariffPeriod,
         @feedInPriceRaw, @spotPriceRaw,
         @nextDemandMin, @reportedMode,
         @intervalBuyAud, @intervalSellAud, @intervalNetAud,
         @meterBuyDelta, @meterSellDelta, @recordTrigger,
         @chargeKw, @dischargeKw, @modeVerifyOk, @modeFrom, @modeTo,
         @solarWm2, @cloudCoverPct)
    `).run({
      ts: record.ts, nemTime: record.nemTime, soc: record.soc,
      battPower: record.battPower, homeLoad: record.homeLoad,
      pvPower: record.pvPower, gridPower: record.gridPower,
      buyPrice: record.buyPrice, feedInPrice: record.feedInPrice,
      spotPrice: record.spotPrice, demandWindow: record.demandWindow ? 1 : 0,
      mode: record.mode, modeChanged: record.modeChanged ? 1 : 0,
      modeReason: record.modeReason || null, renewables: record.renewables,
      alert: record.alert ? (typeof record.alert === 'string' ? record.alert : JSON.stringify(record.alert)) : null,
      meterBuyTotal: record.meterBuyTotal ?? null,
      meterSellTotal: record.meterSellTotal ?? null,
      battVoltage: record.battVoltage ?? null,
      battCurrent: record.battCurrent ?? null,
      flowPV: record.flowPV ?? null,
      flowGrid: record.flowGrid ?? null,
      flowBattery: record.flowBattery ?? null,
      flowLoad: record.flowLoad ?? null,
      todayChargeKwh: record.todayChargeKwh ?? null,
      todayDischargeKwh: record.todayDischargeKwh ?? null,
      todayPvKwh: record.todayPvKwh ?? null,
      todayGridBuyKwh: record.todayGridBuyKwh ?? null,
      todayGridSellKwh: record.todayGridSellKwh ?? null,
      todayHomeKwh: record.todayHomeKwh ?? null,
      todayCarbonKg: record.todayCarbonKg ?? null,
      descriptor: record.descriptor || null,
      tariffPeriod: record.tariffPeriod || null,
      clPrice: record.clPrice ?? null,
      clDescriptor: record.clDescriptor || null,
      clTariffPeriod: record.clTariffPeriod || null,
      feedInPriceRaw: record.feedInPrice ?? null,
      spotPriceRaw: record.spotPrice ?? null,
      nextDemandMin: record.nextDemandMinutes ?? null,
      reportedMode: record.reportedMode ?? null,
      intervalBuyAud:  record.intervalBuyAud  ?? null,
      intervalSellAud: record.intervalSellAud ?? null,
      intervalNetAud:  record.intervalNetAud  ?? null,
      meterBuyDelta:   record.meterBuyDelta   ?? null,
      meterSellDelta:  record.meterSellDelta  ?? null,
      recordTrigger:   record.recordTrigger   ?? null,
      chargeKw:        record.chargeKw        ?? null,
      dischargeKw:     record.dischargeKw     ?? null,
      modeVerifyOk:    record.mode_verify_ok  != null ? (record.mode_verify_ok ? 1 : 0) : null,
      modeFrom:        record.mode_from       ?? null,
      modeTo:          record.mode_to         ?? null,
      solarWm2:        record.solar_wm2       ?? null,
      cloudCoverPct:   record.cloud_cover_pct ?? null,
    });
  } catch (e) {
    console.warn("[DB] insert failed:", e.message);
    // Debug: find bad field type
    try {
      const entries = { ts: record.ts, soc: record.soc, demandWindow: record.demandWindow, modeChanged: record.modeChanged, mode_verify_ok: record.mode_verify_ok, solar_wm2: record.solar_wm2, cloud_cover_pct: record.cloud_cover_pct };
      for (const [k, v] of Object.entries(entries)) {
        if (typeof v === 'boolean' || v === undefined) console.warn(`[DB] bad field: ${k}=${v} (${typeof v})`);
      }
    } catch {}
  }
}

function updateDailySummary(record) {
  ensureDataDir();
  const today = record.ts.substring(0, 10);

  const db = getDb();
  if (db) {
    try {
      const isCharging  = record.mode === MODE.BACKUP;
      const isSelling   = record.mode === MODE.SELLING;
      const isModeChange = record.modeChanged ? 1 : 0;

      db.prepare(`
        INSERT INTO daily_summary (date, intervals, home_kwh, grid_buy_kwh, grid_sell_kwh,
          cost_aud, earnings_aud, demand_peak_kw, demand_charge_est, avg_soc, min_soc, max_soc,
          meter_buy_start, meter_buy_end, meter_sell_start, meter_sell_end,
          pv_kwh, charge_grid_kwh, discharge_kwh, mode_changes, sell_sessions, charge_sessions)
        VALUES (@date, 1, @homeToday, 0, 0, COALESCE(@meterCost,0), COALESCE(@meterEarn,0), @peak, @peakCharge, @soc, @soc, @soc,
          @meterBuy, @meterBuy, @meterSell, @meterSell,
          @pvToday, @chargeGrid, @discharge, @modeChange, @sellSess, @chargeSess)
        ON CONFLICT(date) DO UPDATE SET
          intervals        = intervals + 1,
          home_kwh         = COALESCE(@homeToday, home_kwh),
          grid_buy_kwh     = CASE WHEN @meterBuy IS NOT NULL AND meter_buy_start IS NOT NULL THEN ROUND(@meterBuy - meter_buy_start, 3) ELSE grid_buy_kwh END,
          grid_sell_kwh    = CASE WHEN @meterSell IS NOT NULL AND meter_sell_start IS NOT NULL THEN ROUND(@meterSell - meter_sell_start, 3) ELSE grid_sell_kwh END,
          cost_aud         = cost_aud + COALESCE(@meterCost, 0),
          earnings_aud     = earnings_aud + COALESCE(@meterEarn, 0),
          demand_peak_kw   = MAX(demand_peak_kw, @peak),
          demand_charge_est = MAX(demand_peak_kw, @peak) * 0.6104,
          avg_soc          = (avg_soc * intervals + @soc) / (intervals + 1),
          min_soc          = MIN(min_soc, @soc),
          max_soc          = MAX(max_soc, @soc),
          meter_buy_end    = COALESCE(@meterBuy, meter_buy_end),
          meter_sell_end   = COALESCE(@meterSell, meter_sell_end),
          meter_buy_start  = COALESCE(meter_buy_start, @meterBuy),
          meter_sell_start = COALESCE(meter_sell_start, @meterSell),
          pv_kwh           = COALESCE(@pvToday, pv_kwh),
          charge_grid_kwh  = charge_grid_kwh + @chargeGrid,
          discharge_kwh    = discharge_kwh + @discharge,
          mode_changes     = mode_changes + @modeChange,
          sell_sessions    = sell_sessions + @sellSess,
          charge_sessions  = charge_sessions + @chargeSess
      `).run({
        date: today,
        homeToday: record.todayHomeKwh  ?? null,
        pvToday:   record.todayPvKwh    ?? null,
        home:   (record.homeLoad || 0) * 0.5,      // kept for reference
        // Cost/earn: use meter_delta × price (accurate), fall back to interval estimate
        meterCost: record.meterBuyDelta  != null ? record.meterBuyDelta  * (record.buyPrice  || 0) / 100 : null,
        meterEarn: record.meterSellDelta != null ? record.meterSellDelta * (record.feedInPrice|| 0) / 100 : null,
        buy:    record.gridPower < 0 ? Math.abs(record.gridPower) * 0.5 : 0,
        sell:   record.gridPower > 0 ? record.gridPower * 0.5 : 0,
        cost:   record.gridPower < 0 ? Math.abs(record.gridPower) * 0.5 * (record.buyPrice || 0) / 100 : 0,
        earn:   record.gridPower > 0 ? record.gridPower * 0.5 * (record.feedInPrice || 0) / 100 : 0,
        peak:   (record.demandWindow && record.gridPower < 0) ? Math.abs(record.gridPower) : 0,
        peakCharge: 0,
        soc:    record.soc || 0,
        meterBuy:  record.meterBuyTotal  ?? null,
        meterSell: record.meterSellTotal ?? null,
        chargeGrid: isCharging  ? (record.chargeKw  || 0) * 0.5 : 0,
        discharge:  isSelling   ? (record.dischargeKw || 0) * 0.5 : 0,
        modeChange: isModeChange,
        sellSess:   (isModeChange && isSelling)  ? 1 : 0,
        chargeSess: (isModeChange && isCharging) ? 1 : 0,
      });
    } catch (e) { console.warn("[DB] daily upsert failed:", e.message); }
  }

  // Return today's summary for printing
  if (db) {
    try { return db.prepare("SELECT * FROM daily_summary WHERE date=?").get(today) || {}; }
    catch {}
  }
  return {};
}

// ── Decision engine ───────────────────────────────────────────────────────────
function decide(ess, pvPower, amber, state, dailySummary) {
  // Load today's LP plan (primary charge strategy)
  const todayPlan = loadTodayPlan();
  const planSydHour = getSydneyHour();

  // Is current hour within a plan charge window?
  const inPlanChargeWindow = todayPlan?.chargeWindows?.some(w =>
    planSydHour >= w.startHour && planSydHour < w.endHour
  ) ?? false;

  // Is current hour past plan's charge cutoff?
  const pastChargeCutoff = todayPlan ? planSydHour >= todayPlan.chargeCutoffHour : false;

  console.log(`[PLAN] plan=${todayPlan ? 'loaded' : 'none'} inWindow=${inPlanChargeWindow} pastCutoff=${pastChargeCutoff} hour=${planSydHour}`);

  const { soc, homeLoad, gridPower, battPower } = ess;
  const { currentDemand, currentPrice, feedInPrice, spotPrice, nextDemandMinutes, descriptor, peakFeedInForecast, forecastGeneral, forecastFeedIn } = amber;
  const forecast = forecastGeneral ?? [];
  const usableEnergy = (soc - BATTERY_MIN_SOC) / 100 * BATTERY_CAPACITY; // usable kWh remaining
  const hoursRemaining = homeLoad > 0 ? usableEnergy / homeLoad : 99;

  let targetMode = state.currentMode;
  let reason = "no change";
  let alert = null;

  // ── Priority 1: Demand window protection (highest priority) ───────────────
  // During demand window:
  //   - NO charging allowed (grid import = demand charge)
  //   - Selling IS allowed (grid export does NOT create demand charge)
  if (currentDemand) {
    if (soc < SOC_WARN) {
      alert = `⚠️ Demand window: SOC only ${soc}%, usable ${usableEnergy.toFixed(1)} kWh, ~${hoursRemaining.toFixed(1)}h remaining`;
    }
    // If currently charging — stop immediately
    if (state.currentMode === MODE.BACKUP) {
      targetMode = MODE.SELF_USE;
      reason = `demand window active — stop charging, switch to Self-use (SOC ${soc}%)`;
      return { targetMode, reason, alert };
    }
    // Not charging: allow sell logic (priority 5) to run below.
    // Set a default reason in case sell doesn't trigger.
    if (state.currentMode !== MODE.SELLING) {
      reason = `demand window active — maintaining Self-use`;
    }
    // Fall through to priority 5 sell check
  }

  // ── Priority 2: Demand window imminent (within 10 minutes) ────────────────
  // Stop any charging before demand window starts. 10-min buffer for mode switch.
  if (!currentDemand && nextDemandMinutes != null && nextDemandMinutes <= 10 && nextDemandMinutes > -5) {
    targetMode = MODE.SELF_USE;
    reason = `demand window starts in ${nextDemandMinutes.toFixed(0)} min — switching to Self-use`;
    return { targetMode, reason, alert };
  }

  // ── Priority 2.5: Pre-demand window forced charge (10–60 min before) ──────
  // Only force charge if SOC < 60% AND a demand window is actually scheduled today.
  // nextDemandMinutes != null means the Amber API returned a real upcoming demand window event.
  // On non-demand days (weekends/holidays) nextDemandMinutes is null → this branch is skipped.
  // If SOC >= 60%, the battery is sufficient; let normal price rules apply.
  const PRE_DW_CHARGE_SOC = 60; // % minimum SOC threshold for forced pre-DW charging
  const hasDWToday = todayPlan ? todayPlan.hasDemandWindow : (nextDemandMinutes != null);
  if (hasDWToday && !currentDemand && nextDemandMinutes != null && nextDemandMinutes <= 60 && nextDemandMinutes > 10 && soc < PRE_DW_CHARGE_SOC && gridHeadroomOk) {
    targetMode = MODE.BACKUP;
    reason = `demand window in ${nextDemandMinutes.toFixed(0)} min — force charging (SOC ${soc}% < ${PRE_DW_CHARGE_SOC}%)`;
    return { targetMode, reason, alert };
  }

  // ── Grid headroom check (shared by all charging decisions) ──────────────
  const pvPowerVal = pvPower ?? 0;
  const homeLoadVal = homeLoad ?? 0;
  const netHouseDraw = homeLoadVal - pvPowerVal;
  const availableChargeKw = MAX_GRID_TARGET - netHouseDraw;
  const gridHeadroomOk = (homeLoad == null) || availableChargeKw >= MIN_CHARGE_KW;
  if (!gridHeadroomOk) {
    // No headroom for charging — but if we're in a cheap-price charging window,
    // use Timed discharge to balance the breaker (supply the excess homeLoad from battery)
    // dischargeKw = netHouseDraw - BREAKER (just enough to keep grid under limit)
    const breakerBalanceKw = parseFloat(Math.min(INVERTER_MAX_DISCHARGE, Math.max(0, netHouseDraw - MAX_GRID_TARGET)).toFixed(2));
    if (breakerBalanceKw > 0) {
      targetMode = MODE.SELLING; // Timed mode, discharge only (no sell window needed — just balance)
      reason = `no charge headroom: homeLoad=${homeLoadVal.toFixed(2)}kW netDraw=${netHouseDraw.toFixed(2)}kW > breaker=${MAX_GRID_TARGET}kW — Timed discharge ${breakerBalanceKw.toFixed(2)}kW to balance`;
      alert = { ...alert, sellPowerKw: breakerBalanceKw };
      return { targetMode, reason, alert };
    }
    // netHouseDraw <= BREAKER but still < MIN_CHARGE_KW headroom — Self-use is fine
    if (state.currentMode === MODE.BACKUP) {
      targetMode = MODE.SELF_USE;
      reason = `no charge headroom: homeLoad=${homeLoadVal.toFixed(2)}kW PV=${pvPowerVal.toFixed(2)}kW → Self-use`;
      return { targetMode, reason, alert };
    }
  }

  // ── Dynamic SOC target ───────────────────────────────────────────────────
  // Base target: 85%
  // Ultra-cheap grid (buy <= 7c): charge to 100% — cheap enough to top up from grid
  // PV surplus (pvPower > homeLoad) + cheap price: also allow up to 100% — free solar, don't waste
  const pvPowerVal2  = pvPower ?? 0;
  const homeLoadVal2 = ess.homeLoad ?? 0;
  const pvSurplus    = pvPowerVal2 > homeLoadVal2;  // PV generating more than house needs
  const cheapPrice   = currentPrice <= 9.6; // early estimate — use 9.6c threshold before plan loads
  const CHEAP_CHARGE_SOC = (currentPrice <= ULTRACHEAP_PRICE_C || (pvSurplus && cheapPrice))
    ? SOC_MAX_CHARGE_ULTRACHEAP   // 100% — free solar surplus or ultra-cheap grid
    : SOC_MAX_CHARGE;             // 85% — normal target
  console.log(`[SOC] target=${CHEAP_CHARGE_SOC}% (pvSurplus=${pvSurplus} cheapPrice=${cheapPrice} buy=${currentPrice.toFixed(1)}c ultraCheap=${currentPrice<=ULTRACHEAP_PRICE_C})`);
  // Note: spot<=0 grid-standby uses SOC_MAX_CHARGE (85%) — see Priority 3 below

  // ── Priority 3: Free/negative-price charging (spot <= 0) ─────────────────
  // Guard: never charge during demand window (handled in priority 1)
  // Use SOC_MAX_CHARGE (85%) as target — NOT the ultra-cheap 100% target
  if (gridHeadroomOk && !currentDemand && spotPrice <= CHARGE_SPOT_MAX && soc < SOC_MAX_CHARGE) {
    targetMode = MODE.BACKUP;
    reason = `spot=${spotPrice.toFixed(2)}c (<=0) — free charging (SOC ${soc}% -> ${SOC_MAX_CHARGE}%)`;
    return { targetMode, reason, alert };
  }
  if (!currentDemand && spotPrice <= CHARGE_SPOT_MAX && soc >= SOC_MAX_CHARGE) {
    // SOC full but price is free/negative
    // If PV is generating surplus → switch to Self-use so PV charges battery (free solar, don't waste)
    // If no PV surplus → grid-standby: grid supplies home load, battery idles
    if (pvSurplus) {
      targetMode = MODE.SELF_USE;
      reason = `spot=${spotPrice.toFixed(2)}c (<=0), SOC=${soc}% full but PV surplus ${(pvPowerVal2 - homeLoadVal2).toFixed(1)}kW — Self-use (let PV charge battery)`;
      return { targetMode, reason, alert };
    }
    if (state.currentMode !== MODE.BACKUP) {
      targetMode = MODE.BACKUP;
      reason = `spot=${spotPrice.toFixed(2)}c (<=0), SOC=${soc}% full, no PV surplus — grid-standby (chargeKw=0, block discharge)`;
      alert = { ...(alert||{}), planChargeKwOverride: 0 };
    } else {
      reason = `spot<=0, SOC full, no PV surplus — holding grid-standby`;
    }
    return { targetMode, reason, alert };
  }

  // ── Priority 4: Cheap rate charging ──────────────────────────────────────
  // Two entry conditions (either triggers charging):
  //   A. Price <= dynamicBuyMax: today's forecast min buy price * 1.5 (captures whole cheap window)
  //   B. Price spread: currentPrice + SPREAD_MIN <= peakFeedInToday
  //      (buy cheap now, sell high later — worthwhile even at moderate buy price)
  // Charging stops when: demand window starts OR price rises above CHEAP_EXIT_MIN.
  // ENTRY BUFFER: require 2 consecutive qualifying readings before starting.

  // Dynamic buy ceiling: cheapest forecast price today (until DW or end of day) × 1.5
  // This self-adjusts: on an expensive day the threshold rises, on a cheap day it stays low.
  const nowMs = Date.now();
  const demandWindowMs = nextDemandMinutes != null ? nowMs + nextDemandMinutes * 60 * 1000 : null;
  const endOfDayMs = (() => { const d = new Date(); d.setHours(23,30,0,0); return d.getTime(); })();
  const chargeHorizonMs = demandWindowMs ?? endOfDayMs;

  // Hard cap: don't consider slots after 16:00 local time for charging decisions.
  // Without this, evening peak prices (17–21c) get included in the avg6 window when there's
  // no DW, driving dynamicBuyMax up to 20c+ and causing charging during the expensive peak.
  // Also block overnight charging (00:00–06:00): after midnight the cutoff resets to today 16:00,
  // but overnight prices (15–18c) are still expensive — no grid charging until morning.
  const CHARGE_CUTOFF_HOUR = 16; // Sydney local time — no grid charging after 16:00
  const CHARGE_START_HOUR  = 6;  // Sydney local time — no grid charging before 06:00 (overnight block)
  const sydneyHourForWindow = getSydneyHour();
  const chargeCutoffMs = (() => {
    const d = new Date();
    d.setHours(CHARGE_CUTOFF_HOUR, 0, 0, 0);
    return d.getTime();
  })();
  // If current time is past 16:00 OR before 06:00, set effectiveHorizon to now
  // (empty forecast window = dynamicBuyMax collapses to 9.6c floor = no charging).
  const inOvernightBlock = sydneyHourForWindow < CHARGE_START_HOUR;
  const effectiveHorizonMs = (inOvernightBlock)
    ? nowMs  // empty window → no charging overnight
    : Math.min(chargeHorizonMs, chargeCutoffMs);

  // Forecast window: next 10 hours, non-demand-window slots only, capped at 16:00.
  // chargeHorizonMs already caps at DW start; the demandWindow filter below double-guards.
  const tenHoursMs = 10 * 60 * 60 * 1000;
  const forecastBuyPrices = forecast
    .filter(p => !p.tariffInformation?.demandWindow)
    .filter(p => {
      const t = new Date(p.startTime).getTime();
      return t > nowMs && t <= Math.min(nowMs + tenHoursMs, effectiveHorizonMs);
    })
    .map(p => p.perKwh ?? 999);
  // Take the 6 cheapest half-hour slots (≈3h low-valley) and average them.
  // Multiply by 1.3 — buffer so we only charge when price is truly near the valley.
  const sortedBuyPrices = [...forecastBuyPrices].sort((a, b) => a - b);
  const avgWindowN = Math.min(6, sortedBuyPrices.length);
  const forecastMinBuy = avgWindowN > 0
    ? sortedBuyPrices.slice(0, avgWindowN).reduce((s, v) => s + v, 0) / avgWindowN
    : 0;  // No forecast slots available (past 16:00 or no data) — set to 0 so dynamicBuyMax falls to floor (9.6c), effectively disabling grid charging
  const dynamicBuyMax = Math.min(12.0, Math.max(9.6, forecastMinBuy * 1.3)); // capped at 12c hard ceiling — never charge above this even on expensive days

  // High-load throttle: when homeLoad is large (e.g. hot water heater), charge at 0.5kW only.
  // When homeLoad is small, Self-use mode lets solar charge the battery naturally — no grid charge needed.
  const chargeThrottled = false; // Throttle logic removed — calcChargeKw() already accounts for PV and breaker headroom dynamically
  // Previously: homeLoad >= 3.5kW → fixed 0.5kW throttle. Problem: ignored PV offset.
  // Now: always use calcChargeKw(homeLoad, pvPower) which computes: 7.7 - (homeLoad - pvPower) - 0.2
  // When hot water heater runs (homeLoad=9kW, PV=3kW): chargeKw = 7.7 - 6.0 - 0.2 = 1.5kW (not 0.5kW!)

  // Peak feedIn until end of selling window (until SELL_STOP_HOUR or demand window)
  const sellStopMs = (() => { const d = new Date(); d.setHours(SELL_STOP_HOUR,0,0,0); return d.getTime(); })();
  const feedInHorizonMs = demandWindowMs ? Math.min(demandWindowMs, sellStopMs) : sellStopMs;
  const peakFeedInToday = (forecastFeedIn ?? [])
    .filter(p => { const t = new Date(p.startTime).getTime(); return t > nowMs && t <= feedInHorizonMs; })
    .map(p => Math.abs(p.perKwh ?? 0))
    .sort((a,b) => b-a)
    .slice(0,4)
    .reduce((s,v,_,a) => s + v/a.length, 0); // top-4 average

  const CHEAP_EXIT_MIN  = 13.0;  // c/kWh — exit threshold (asymmetric: hold charge longer)
  const SPREAD_MIN      = 7.0;   // c/kWh — minimum buy→sell spread to justify charging

  const peakFeedIn      = peakFeedInToday ?? 0;
  const spreadOk        = peakFeedIn > 0 && (currentPrice + SPREAD_MIN) <= peakFeedIn;

  // ── Emergency charge: predict if battery will run out before tomorrow morning ──
  // Hot water heater runs on grid at low price — NOT from battery. Exclude from estimate.
  // Battery only covers: evening home load + overnight standby + 12% morning reserve.
  const sydneyHourForCharge = getSydneyHour();
  const OVERNIGHT_RESERVE_PCT = 12; // morning floor — will top up from PV/grid during day
  let estimatedConsumption = 0;
  if (sydneyHourForCharge >= 17 && sydneyHourForCharge < 23) {
    const eveHours = 23 - sydneyHourForCharge;
    estimatedConsumption = eveHours * 1.0 + 7.5 * 0.35; // eve (1kW) + overnight standby (0.35kW)
  } else if (sydneyHourForCharge >= 23 || sydneyHourForCharge < 6) {
    const nightHours = sydneyHourForCharge >= 23 ? (6.5 - (sydneyHourForCharge - 24)) : (6.5 - sydneyHourForCharge);
    estimatedConsumption = Math.max(0, nightHours) * 0.35;
  }
  const socKwh = (soc / 100) * 42;
  const reserveKwh = (OVERNIGHT_RESERVE_PCT / 100) * 42;
  const projectedDeficit = estimatedConsumption + reserveKwh - socKwh;
  const emergencyCharge = projectedDeficit > 2 && !currentDemand && sydneyHourForCharge >= 17 && sydneyHourForCharge < 23;
  if (emergencyCharge) {
    console.log(`[CHARGE] ⚠️ Emergency: deficit=${projectedDeficit.toFixed(1)}kWh (consume=${estimatedConsumption.toFixed(1)}kWh + reserve=${reserveKwh.toFixed(1)}kWh - have=${socKwh.toFixed(1)}kWh) — charging at ${currentPrice.toFixed(1)}c`);
  }

  // ── PV-only path: strong solar surplus → no need to buy grid power ───────
  // When PV is generating more than homeLoad by a meaningful margin (>1kW headroom),
  // and SOC is already reasonable (>= 65%), switch to Self-use and let solar do the work.
  // No point paying for grid kWh when the sun is charging for free.
  // Exception: keep buying if price is ultra-cheap (<=7c) AND PV surplus is small (<1kW) —
  //   in that case grid top-up is still worthwhile.
  const pvSurplusKw = Math.max(0, pvPowerVal2 - homeLoadVal2);
  const PV_ONLY_SOC_MIN   = 65;  // % — don't switch to PV-only if SOC is still low
  const PV_ONLY_SURPLUS_KW = 1.0; // kW — require at least this much PV headroom above homeLoad
  const pvOnlyCondition = pvSurplusKw >= PV_ONLY_SURPLUS_KW
    && soc >= PV_ONLY_SOC_MIN
    && !currentDemand
    && !(currentPrice <= ULTRACHEAP_PRICE_C && pvSurplusKw < PV_ONLY_SURPLUS_KW); // allow ultra-cheap if big surplus
  if (pvOnlyCondition && state.currentMode === MODE.BACKUP) {
    targetMode = MODE.SELF_USE;
    reason = `PV surplus ${pvSurplusKw.toFixed(1)}kW (PV=${pvPowerVal2.toFixed(1)}kW load=${homeLoadVal2.toFixed(1)}kW), SOC=${soc}% — switching to Self-use, no grid charge needed`;
    state.chargeEntryCount = 0;
    return { targetMode, reason, alert };
  }
  if (pvOnlyCondition && state.currentMode !== MODE.BACKUP) {
    console.log(`[PV-ONLY] PV surplus ${pvSurplusKw.toFixed(1)}kW, SOC=${soc}% — staying Self-use, skipping grid charge`);
  }

  const cheapEntryOk = gridHeadroomOk && !currentDemand && soc < CHEAP_CHARGE_SOC && state.currentMode !== MODE.BACKUP && !pvOnlyCondition;


  // ── Charge decision — driven by today's plan thresholds ─────────────────
  // If a plan exists (source=rules), use its buyThresholdC as the charge ceiling.
  // Fall back to dynamicBuyMax if no plan is loaded.
  // Emergency charge bypasses price check when SOC is critically low.
  let planBuyThresholdC = null;
  let planSellMinC      = null;
  if (todayPlan?.notes) {
    try {
      const notes = typeof todayPlan.notes === 'string' ? JSON.parse(todayPlan.notes) : todayPlan.notes;
      if (notes.buyThresholdC) planBuyThresholdC = notes.buyThresholdC;
      if (notes.sellMinC)      planSellMinC      = notes.sellMinC;
    } catch {}
  }

  // Lookup current 30-min slot action from plan intervals
  const nowMs30  = Date.now();
  const sydNow   = new Date(nowMs30 + getSydneyOffsetMs());
  // Round down to nearest 30 min
  const sydSlot  = new Date(sydNow);
  sydSlot.setUTCMinutes(sydSlot.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
  const slotKey  = sydSlot.toISOString();

  let planSlot = null;
  if (todayPlan?.intervals?.length) {
    planSlot = todayPlan.intervals.find(iv => iv.key === slotKey)
            || todayPlan.intervals.find(iv => iv.key && slotKey.startsWith(iv.key.substring(0, 15)));
  }

  const planAction       = planSlot?.action ?? null;   // 'charge' | 'sell' | 'self-use' | 'charge+hw'
  const planSlotBuyC     = planSlot?.buyC   ?? null;   // this slot's buy price from plan
  const planSlotChargeKw = planSlot?.chargeKw ?? null; // pre-calculated charge power (accounts for hot water)
  const planSlotInHW     = planSlot?.inHW    ?? false; // hot water heater active this slot
  const planSaysCharge   = planAction === 'charge';
  const planSaysSell     = planAction === 'sell';

  // Effective buy ceiling: plan threshold if available, else dynamicBuyMax (defined earlier)
  const effectiveBuyMaxFull = planBuyThresholdC ?? dynamicBuyMax;
  const chargeCondition  = currentPrice <= effectiveBuyMaxFull || emergencyCharge;

  console.log(`[PLAN] plan=${todayPlan ? `loaded(v${todayPlan.version})` : 'none'} slot=${planAction ?? 'none'} price=${currentPrice.toFixed(1)}c buyMax=${effectiveBuyMaxFull.toFixed(1)}c chargeCondition=${chargeCondition}`);

  if (cheapEntryOk && chargeCondition) {
    // If plan says charge: act immediately (no buffer needed — plan already smoothed noise)
    // If no plan (fallback): keep 3-interval buffer to avoid single-spike noise
    const entryCount = planSaysCharge ? 3 : (state.chargeEntryCount || 0) + 1;
    const condLabel = emergencyCharge
      ? `EMERGENCY SOC=${soc}% deficit=${projectedDeficit.toFixed(1)}kWh`
      : planSaysCharge
        ? `plan:charge buy=${currentPrice.toFixed(1)}c (≤${effectiveBuyMaxFull.toFixed(1)}c)`
        : `buy=${currentPrice.toFixed(1)}c (≤${effectiveBuyMaxFull.toFixed(1)}c fallback)`;
    if (entryCount >= 3 || emergencyCharge) {
      targetMode = MODE.BACKUP;
      reason = `${condLabel} — charging (SOC ${soc}% → ${CHEAP_CHARGE_SOC}%)`;
      state.chargeEntryCount = 0;
      return { targetMode, reason, alert };
    } else {
      state.chargeEntryCount = entryCount;
      console.log(`[INFO] Charge entry buffer (fallback): ${condLabel} (count=${entryCount}/3)`);
    }
  } else if (state.currentMode !== MODE.BACKUP) {
    state.chargeEntryCount = 0;
  }

  // Exit charging: SOC full or price too high
  if (state.currentMode === MODE.BACKUP && !emergencyCharge) {
    const socFull = soc >= CHEAP_CHARGE_SOC;

    if (socFull && currentPrice <= effectiveBuyMaxFull && !pvSurplus) {
      // SOC full, price cheap, but no PV surplus → grid-standby
      // Grid supplies home load, battery idles. No need to charge or discharge.
      reason = `SOC ${soc}% full, price=${currentPrice.toFixed(1)}c cheap, no PV surplus — grid-standby (chargeKw=0)`;
      alert = { ...(alert||{}), planChargeKwOverride: 0 };
      console.log(`[INFO] Grid-standby: SOC full + cheap price + no PV surplus → chargeKw=0`);
      return { targetMode: MODE.BACKUP, reason, alert };
    }
    if (socFull) {
      // Don't return here — fall through to Priority 5 sell check
      // If feedIn is high enough, selling is better than Self-use even when SOC is full
      state.chargeExitCount = 0;
      targetMode = MODE.SELF_USE;
      reason = `SOC target ${CHEAP_CHARGE_SOC}% reached (SOC ${soc}%), price=${currentPrice.toFixed(1)}c — checking sell...`;
      // (sell logic below may override this)
    }
    // Exit when price rises above threshold — 3-interval buffer to avoid thrashing
    // Use effectiveBuyMaxFull (plan threshold if set) so manual overrides are respected
    const exitThreshold = effectiveBuyMaxFull;
    if (currentPrice > exitThreshold) {
      // If plan has explicit buyThresholdC, exit immediately (no buffer needed — plan decision is authoritative)
      // Otherwise use 3-interval buffer to avoid single-spike noise
      const useBuffer = !planBuyThresholdC;
      const overCount = useBuffer ? (state.chargeExitCount || 0) + 1 : 3;
      if (overCount >= 3) {
        targetMode = MODE.SELF_USE;
        reason = `price ${currentPrice.toFixed(1)}c > ${exitThreshold.toFixed(1)}c (exit${planBuyThresholdC ? '/plan' : ''}, count=${overCount})`;
        state.chargeExitCount = 0;
        return { targetMode, reason, alert };
      } else {
        state.chargeExitCount = overCount;
        console.log(`[INFO] Charge exit buffer: ${currentPrice.toFixed(1)}c > ${exitThreshold.toFixed(1)}c (count=${overCount}/3)`);
      }
    } else {
      state.chargeExitCount = 0;
    }
  } // end exit-charging block

  // ── extremelyLow opportunistic charging (no plan / outside window) ─────────
  // Only fires when no plan active OR plan says idle but price is extremely cheap.
  // Uses 2-interval buffer to avoid single-spike noise.
  // Respects planBuyThresholdC: if plan sets a lower threshold, don't charge above it.
  const EXTREMELY_LOW_MAX = 10; // c/kWh
  const elMaxPrice = planBuyThresholdC != null ? Math.min(EXTREMELY_LOW_MAX, planBuyThresholdC) : EXTREMELY_LOW_MAX;
  if (gridHeadroomOk && !currentDemand && descriptor === 'extremelyLow' && currentPrice < elMaxPrice && soc < CHEAP_CHARGE_SOC && state.currentMode !== MODE.BACKUP) {
    const elEntryCount = (state.extremelyLowEntryCount || 0) + 1;
    if (elEntryCount >= 2) {
      targetMode = MODE.BACKUP;
      reason = `extremelyLow buy=${currentPrice.toFixed(1)}c — opportunistic charge (SOC ${soc}%)`;
      state.extremelyLowEntryCount = 0;
      return { targetMode, reason, alert };
    } else {
      state.extremelyLowEntryCount = elEntryCount;
      console.log(`[INFO] ExtremeLow entry buffer: ${currentPrice.toFixed(1)}c (count=${elEntryCount}/2)`);
    }
  } else if (state.currentMode !== MODE.BACKUP) {
    state.extremelyLowEntryCount = 0;
  }
  if (state.currentMode === MODE.BACKUP && !emergencyCharge) {
    const elExitMax = planBuyThresholdC != null ? Math.min(dynamicBuyMax, planBuyThresholdC) : dynamicBuyMax;
    if (currentPrice > elExitMax || soc >= CHEAP_CHARGE_SOC) {
      // If plan has explicit threshold, exit immediately; else use buffer
      const useBuffer = !planBuyThresholdC;
      const overCount = useBuffer ? (state.elExitCount || 0) + 1 : 3;
      if (soc >= CHEAP_CHARGE_SOC || overCount >= 3) {
        targetMode = MODE.SELF_USE;
        reason = `extremelyLow ended buy=${currentPrice.toFixed(1)}c exitMax=${elExitMax.toFixed(1)}c SOC=${soc}%`;
        state.elExitCount = 0;
        return { targetMode, reason, alert };
      } else {
        state.elExitCount = overCount;
        console.log(`[INFO] ExtremeLow exit buffer: ${currentPrice.toFixed(1)}c > ${dynamicBuyMax.toFixed(1)}c (count=${overCount}/3)`);
      }
    } else {
      state.elExitCount = 0;
    }
  } else if (emergencyCharge && state.currentMode === MODE.BACKUP) {
    state.elExitCount = 0;  // reset exit counter — emergency overrides exit
    console.log(`[INFO] Emergency charge active — suppressing elExit despite price ${currentPrice.toFixed(1)}c`);
  }

  // ── Priority 5: Sell to grid (high feedIn, sufficient SOC, inverter headroom) ──
  // Selling is allowed during demand window (exporting does NOT create demand charge).
  // Charging priorities 3/4/4b are NOT reached during demand window because
  // priority 1 either returns early (if was charging) or falls through here.
  const SELL_MIN_MARGIN = 5;        // c/kWh minimum margin above avg buy price
  const SELL_ABS_MIN = 13.5;        // c/kWh absolute floor
  const SELL_MIN_SAMPLES_KWH = 1.0; // require at least 1 kWh bought today to have a reliable avg

  const avgBuyCalc = (() => {
    try {
      const _db = getDb();
      if (!_db) return { avg: null, kwh: 0, reason: 'db unavailable' };
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
      const sql = 'SELECT SUM(meter_buy_delta * buy_price / 100.0) AS cost, SUM(meter_buy_delta) AS kwh, COUNT(*) AS cnt' +
                  ' FROM energy_log WHERE date(ts) = ? AND meter_buy_delta > 0 AND buy_price IS NOT NULL';
      const r = _db.prepare(sql).get(today);
      if (!r || r.kwh == null || r.kwh < SELL_MIN_SAMPLES_KWH) {
        return { avg: null, kwh: r?.kwh ?? 0, reason: `insufficient data (bought ${(r?.kwh??0).toFixed(2)} kWh today, need ${SELL_MIN_SAMPLES_KWH})` };
      }
      const avg = (r.cost / r.kwh) * 100; // cents/kWh
      if (avg < 1) {
        return { avg: null, kwh: r.kwh, reason: `avg price anomaly (${avg.toFixed(2)}c — possible data error)` };
      }
      return { avg, kwh: r.kwh, reason: null };
    } catch (e) {
      return { avg: null, kwh: 0, reason: `query failed: ${e.message}` };
    }
  })();

  const avgBuyPrice = avgBuyCalc.avg;
  // If avg price is valid: use avg + margin (floor at SELL_ABS_MIN).
  // If avg is unavailable (midnight/error): fall back to absolute floor to prevent false triggers.
  // effectiveSellMin = absolute floor only. avgBuyPrice-based margin removed:
  // today's avg buy often includes expensive intervals (hot water, DW), which incorrectly
  // raises the sell threshold and blocks profitable selling at 14c+.
  // Use plan's sellMinC if available, else absolute floor
  const effectiveSellMin = planSellMinC ?? SELL_ABS_MIN;
  const sellMinLabel = planSellMinC
    ? `plan_sell_min=${planSellMinC.toFixed(1)}c`
    : `abs_floor=${SELL_ABS_MIN}c`;

  // ── Priority 5: Sell to grid ─────────────────────────────────────────────
  // Hard stop: no selling after SELL_STOP_HOUR (Sydney time) — reserve battery overnight
  const sydneyHourNow = getSydneyHour();
  const afterSellStopHour = sydneyHourNow >= SELL_STOP_HOUR;

  // Time-dependent SOC floor: morning allows lower reserve (can recharge before demand window)
  const socMinSell = sydneyHourNow < SOC_MIN_SELL_CUTOFF_HOUR
    ? SOC_MIN_SELL_MORNING    // 00:00–13:59 → 12%
    : SOC_MIN_SELL_AFTERNOON; // 14:00–23:59 → 35%

  // ── Priority 5a: Already selling — hold unless exit condition met ─────────
  // If we're currently selling, don't re-evaluate entry conditions each cron run.
  // Only stop if: past stop hour / SOC too low / feedIn collapsed / emergency charge.
  // This prevents Amber price blips or plan-slot changes from interrupting a sell session.
  if (state.currentMode === MODE.SELLING) {
    if (afterSellStopHour) {
      targetMode = MODE.SELF_USE;
      reason = `stop selling — past ${SELL_STOP_HOUR}:00 (overnight reserve)`;
      return { targetMode, reason, alert };
    }
    if (emergencyCharge) {
      targetMode = MODE.BACKUP;
      reason = `EMERGENCY stop selling — deficit ${projectedDeficit.toFixed(1)}kWh`;
      return { targetMode, reason, alert };
    }
    if (soc <= socMinSell) {
      targetMode = MODE.SELF_USE;
      reason = `stop selling — SOC ${soc}% <= floor ${socMinSell}%`;
      return { targetMode, reason, alert };
    }
    if (feedInPrice < effectiveSellMin) {
      targetMode = MODE.SELF_USE;
      reason = `stop selling — feedIn=${feedInPrice.toFixed(1)}c < ${effectiveSellMin.toFixed(1)}c`;
      return { targetMode, reason, alert };
    }
    // All good — keep selling, just roll the window
    const sellPower = INVERTER_MAX_DISCHARGE;
    reason = `holding sell — feedIn=${feedInPrice.toFixed(1)}c SOC=${soc}% (floor=${socMinSell}%)`;
    alert = { ...alert, sellPowerKw: sellPower };
    return { targetMode: MODE.SELLING, reason, alert };
  }

  if (afterSellStopHour) {
    // Don't enter selling after stop hour
  } else if (emergencyCharge && state.currentMode === MODE.SELLING) {
    // (handled above)
  } else if (feedInPrice >= effectiveSellMin && soc > socMinSell && !emergencyCharge) {
    // Max sell power = inverter discharge cap (independent of homeLoad — grid handles both simultaneously)
    const maxSellPower = INVERTER_MAX_DISCHARGE;
    if (maxSellPower > 0) {
      // If projected deficit tonight, scale down sell power proportionally to preserve battery
      let sellPower = maxSellPower;
      if (projectedDeficit > 0) {
        // Reduce sell power so we don't drain below what's needed tonight
        // Scale: sellPower = maxSellPower * (socKwh - reserveKwh - estimatedConsumption) / socKwh
        // Simpler: reduce proportionally to how tight the deficit is (cap at maxSellPower)
        const safeDischargeKwh = socKwh - reserveKwh - estimatedConsumption;
        const safeRatio = Math.max(0, safeDischargeKwh / Math.max(socKwh, 1));
        sellPower = parseFloat(Math.max(0.1, maxSellPower * safeRatio).toFixed(2));
      }
      if (sellPower > 0) {
        targetMode = MODE.SELLING;
        reason = `feedIn=${feedInPrice.toFixed(1)}c (>=${effectiveSellMin.toFixed(1)}c, ${sellMinLabel}), SOC ${soc}% (>${socMinSell}%${projectedDeficit > 0 ? `, deficit=${projectedDeficit.toFixed(1)}kWh → reduced power` : ''}), sellPower=${sellPower.toFixed(2)}kW`;
        alert = { ...alert, sellPowerKw: sellPower };
      } else {
        reason = `feedIn high but deficit=${projectedDeficit.toFixed(1)}kWh — not enough battery for tonight, skip selling`;
      }
    } else {
      reason = `feedIn high but home load ${homeLoad?.toFixed(1)}kW saturates inverter — no selling (${sellMinLabel})`;
    }
    return { targetMode, reason, alert };
  }

  // Exit selling mode: price dropped, SOC too low, or past stop hour
  if (state.currentMode === MODE.SELLING && (feedInPrice < effectiveSellMin || soc <= socMinSell)) {
    targetMode = MODE.SELF_USE;
    reason = `stop selling (feedIn=${feedInPrice.toFixed(1)}c < ${effectiveSellMin.toFixed(1)}c, ${sellMinLabel}, SOC=${soc}%, floor=${socMinSell}%)`;
    return { targetMode, reason, alert };
  }

  // ── Default: Self-use ────────────────────────────────────────────────────
  // Also catches: demand window active + sell not triggered = stay Self-use
  if (state.currentMode == null) {
    targetMode = MODE.SELF_USE;
    reason = "initialising — default to Self-use";
  }

  return { targetMode, reason, alert, chargeThrottled, planSlotChargeKw };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  console.log(`\n[${now.toISOString()}] === demand-mode-manager ===`);

  if (!AMBER_TOKEN) { console.error("[ERROR] AMBER_API_TOKEN not set"); process.exit(1); }

  // 1. Fetch ESS + Amber data concurrently
  const [ess, amberRaw] = await Promise.all([
    getESSData(),
    httpsGet(
      `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?resolution=5&next=72`,
      { Authorization: `Bearer ${AMBER_TOKEN}` }
    ).catch(() => []),
  ]);

  // 2. Parse Amber response
  const general        = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "general")        : [];
  const feedInCh       = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "feedIn")         : [];
  const controlledLoad = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "controlledLoad") : [];
  const current        = general[0]        || {};
  const feedInCurrent  = feedInCh[0]       || {};
  const clCurrent      = controlledLoad[0] || {};
  const forecast       = general.filter(p => p.type === "ForecastInterval");

  const currentDemand  = current.tariffInformation?.demandWindow ?? false;
  const currentPrice   = current.perKwh ?? 0;
  const feedInPrice    = Math.abs(feedInCurrent.perKwh ?? 0);
  const clPrice        = clCurrent.perKwh ?? null;
  const clDescriptor   = clCurrent.descriptor ?? null;
  const spotPrice      = current.spotPerKwh ?? 0;
  const descriptor     = current.descriptor ?? "unknown";
  const renewables     = current.renewables ?? 0;
  const nemTime        = current.nemTime ?? now.toISOString();
  const tariffPeriod   = current.tariffInformation?.period ?? null;
  const clTariffPeriod = clCurrent.tariffInformation?.period ?? null;

  // Guard: detect Amber API returning all-zero data (transient error).
  // Zero price + zero renewables + no nemTime = bad data.
  // Strategy: use stale cached price data for up to AMBER_STALE_TOLERANCE_MIN minutes
  //           before falling back to Self-use. This prevents losing charge sessions during
  //           brief Amber API blips (common around interval boundaries).
  const AMBER_STALE_TOLERANCE_MIN = 15;
  const amberDataValid = general.length > 0 && (currentPrice !== 0 || renewables !== 0 || current.nemTime != null);

  if (!amberDataValid) {
    // Amber API blip — use daily plan to decide, don't just hold stale mode.
    const blipState = loadState();
    const cacheAge = blipState.lastAmberData
      ? (Date.now() - new Date(blipState.lastAmberData.ts).getTime()) / 60000 : 999;
    console.warn(`[WARN] Amber API blip (cache age=${cacheAge.toFixed(0)}min) — falling back to daily plan`);

    // Try to follow the daily plan even without live prices
    const blipPlan = loadTodayPlan();
    const nowSyd = new Date(new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }));
    const blipHour = nowSyd.getHours();
    const blipMin  = nowSyd.getMinutes();
    const blipSlotKey = `${String(blipHour).padStart(2,'0')}:${blipMin < 30 ? '00' : '30'}`;
    const blipSlot = blipPlan?.intervals?.find(iv => iv.key === blipSlotKey)
                  || blipPlan?.intervals?.find(iv => iv.key && blipSlotKey.startsWith(iv.key.substring(0,15)));
    const blipAction = blipSlot?.action ?? null;
    const blipInChargeWindow = blipPlan?.chargeWindows?.some(w => {
      // Support both {start:'HH:MM', end:'HH:MM'} and {startHour:N, endHour:N} formats
      let sh, sm, eh, em;
      if (w.start != null) {
        [sh, sm] = w.start.split(':').map(Number);
        [eh, em] = w.end.split(':').map(Number);
      } else {
        sh = w.startHour ?? 0; sm = 0;
        eh = w.endHour   ?? 0; em = 0;
      }
      const nowMins = blipHour * 60 + blipMin;
      return nowMins >= sh * 60 + sm && nowMins < eh * 60 + em;
    }) ?? false;

    console.log(`[BLIP] plan slot=${blipAction ?? 'none'} inChargeWindow=${blipInChargeWindow} mode=${MODE_LABEL[blipState.currentMode]??blipState.currentMode}`);

    if (blipState.currentMode === MODE.SELLING) {
      // Keep sell session alive
      await updateSellingEndTime(blipState);
      console.log(`[DONE] (Amber blip — sell session held)`);
    } else if (blipInChargeWindow || blipAction === 'charge') {
      // Plan explicitly says charge in this window — keep/start charging
      // NOTE: do NOT use blipState.currentMode === BACKUP as a condition here,
      //       because that would blindly continue charging even when price is now high.
      const planChargeKw = blipSlot?.chargeKw ?? null;
      await setModeWithVerify(MODE.BACKUP, { planChargeKw });
      console.log(`[DONE] (Amber blip — charging per plan chargeKw=${planChargeKw ?? 'auto'})`);
    } else {
      // API blip + no plan action → safest option is Self-use (don't charge at unknown price)
      await setModeWithVerify(MODE.SELF_USE);
      console.log(`[DONE] (Amber blip — falling back to Self-use, no plan charge action for ${blipSlotKey})`);
    }
    return;
  }

  // Cache this valid Amber response for stale-data tolerance
  {
    const cacheState = loadState();
    cacheState.lastAmberData = {
      ts: now.toISOString(),
      current: { ...current },
      general: general.slice(0, 20),  // keep first 20 intervals (enough for decisions)
      feedIn:  feedInCh.slice(0, 20),
    };
    saveState(cacheState);
  }

  // Find next demand window start time from forecast
  const nextDemandInterval = !currentDemand
    ? forecast.find(p => p.tariffInformation?.demandWindow === true)
    : null;
  const nextDemandMinutes = nextDemandInterval
    ? (new Date(nextDemandInterval.startTime) - now) / 1000 / 60
    : null;

  // Peak evening feedIn in next 6 hours (used for spread-based charging decision)
  const feedInForecastOuter = feedInCh.filter(p => p.type === "ForecastInterval");
  const nowMsOuter          = Date.now();
  const sixHoursMsOuter     = 6 * 60 * 60 * 1000;
  // Use average of top-4 feedIn forecast values in next 6h (more robust than single peak)
  const feedInInRange       = feedInForecastOuter
    .filter(p => { const t = new Date(p.startTime).getTime(); return t > nowMsOuter && t <= nowMsOuter + sixHoursMsOuter; })
    .map(p => Math.abs(p.perKwh ?? 0))
    .sort((a, b) => b - a);
  const top4               = feedInInRange.slice(0, 4);
  const peakFeedInForecast  = top4.length > 0 ? top4.reduce((s, v) => s + v, 0) / top4.length : 0;

  const amber = { currentDemand, currentPrice, feedInPrice, spotPrice, descriptor, renewables, nextDemandMinutes, tariffPeriod, clPrice, clDescriptor, clTariffPeriod, peakFeedInForecast, forecastGeneral: forecast, forecastFeedIn: feedInCh.filter(p => p.type === "ForecastInterval") };

  // 3. Calculate PV power
  const pvPower = calcPVPower(ess);

  // 4. Print real-time status
  console.log(`[DATA] NEM: ${nemTime}`);
  console.log(`[DATA] SOC: ${ess.soc}%  BattPwr: ${ess.battPower?.toFixed(2)} kW  HomeLoad: ${ess.homeLoad?.toFixed(2)} kW  PV: ${pvPower?.toFixed(2)} kW  Grid: ${ess.gridPower?.toFixed(2)} kW`);
  console.log(`[DATA] Price: buy=${currentPrice.toFixed(2)}c  cl=${clPrice != null ? clPrice.toFixed(2)+"c" : "n/a"}  feedIn=${feedInPrice.toFixed(2)}c  spot=${spotPrice.toFixed(2)}c  demandWindow=${currentDemand}  renewables=${renewables}%`);
  if (nextDemandMinutes != null) console.log(`[DATA] Next demandWindow in ${nextDemandMinutes.toFixed(0)} min`);

  // 5. Run decision engine
  // Load today's summary first (used for avg buy price in sell decision)
  const state = loadState();

  // ── Sync state.currentMode from reportedMode ──────────────────────────────
  // The ESS inverter reports mode=1 (Timed) for BOTH charging and selling.
  // We must distinguish them using grid power direction:
  //   grid < -0.2kW  → exporting → treat as SELLING(6)
  //   grid >= -0.2kW → not exporting → treat as BACKUP/charging(1)
  // This prevents a "charging exit" from interrupting an active sell session.
  if (ess.reportedMode !== null && ess.reportedMode !== undefined && state.currentMode !== null) {
    if (ess.reportedMode === MODE.TIMED) {
      // Disambiguate Timed: check grid direction
      const gridKw = ess.gridPower ?? 0;
      const isExporting = gridKw < -0.2; // negative = export
      const inferredMode = isExporting ? MODE.SELLING : MODE.BACKUP;
      if (state.currentMode !== inferredMode && state.currentMode !== MODE.SELLING && !isExporting) {
        // Only sync BACKUP side (charging→charging is fine); don't clobber SELLING state with BACKUP
        console.log(`[SYNC] reportedMode=Timed(1), grid=${gridKw.toFixed(2)}kW → inferred=${inferredMode===MODE.SELLING?'Selling':'Backup'}, state=${MODE_LABEL[state.currentMode]??state.currentMode} — syncing`);
        state.currentMode = inferredMode;
      } else if (isExporting && state.currentMode !== MODE.SELLING) {
        console.log(`[SYNC] reportedMode=Timed(1), grid=${gridKw.toFixed(2)}kW → exporting → treating as Selling(6), syncing state`);
        state.currentMode = MODE.SELLING;
      } else {
        console.log(`[SYNC] reportedMode=Timed(1), grid=${gridKw.toFixed(2)}kW → ${isExporting?'Selling':'Backup'} (state=${MODE_LABEL[state.currentMode]??state.currentMode}, no change needed)`);
      }
    } else if (ess.reportedMode !== state.currentMode) {
      // Non-Timed mode: direct sync
      console.log(`[SYNC] reportedMode=${ess.reportedMode}(${MODE_LABEL[ess.reportedMode]??ess.reportedMode}) ≠ state=${state.currentMode}(${MODE_LABEL[state.currentMode]??state.currentMode}) — syncing state to reported`);
      state.currentMode = ess.reportedMode;
    }
  }

  // ── Force mode override ───────────────────────────────────────────────────
  // If state.forceMode is set and forceModeUntil is in the future,
  // skip the decision engine and hold the forced mode.
  if (state.forceMode != null && state.forceModeUntil) {
    const forceUntil = new Date(state.forceModeUntil);
    if (now < forceUntil) {
      const minsLeft = ((forceUntil - now) / 60000).toFixed(0);
      console.log(`[INFO] Force mode active: ${MODE_LABEL[state.forceMode] ?? state.forceMode} until ${state.forceModeUntil} (${minsLeft} min remaining)`);
      // Roll sell end time if currently selling
      if (state.forceMode === MODE.SELLING) {
        await updateSellingEndTime(state);
      }
      state.lastCheck = now.toISOString();
      saveState(state);
      console.log(`[DONE]`);
      return;
    } else {
      // Force period expired — clear it
      console.log(`[INFO] Force mode expired, resuming normal decision`);
      delete state.forceMode;
      delete state.forceModeUntil;
      saveState(state);
    }
  }
  const todaySummary = (() => {
    try {
      const _db = getDb();
      if (!_db) return {};
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
      return _db.prepare("SELECT * FROM daily_summary WHERE date=?").get(today) || {};
    } catch { return {}; }
  })();
  const { targetMode, reason, alert, chargeThrottled, planSlotChargeKw } = decide(ess, pvPower, amber, state, todaySummary);

  if (alert) console.log(`[ALERT] ${typeof alert === 'object' ? JSON.stringify(alert) : alert}`);

  let modeChanged = false;
  let modeVerifyOk = null;
  const modeFrom = state.currentMode;  // capture before any switch

  if (targetMode !== null && targetMode !== state.currentMode) {
    console.log(`[ACTION] ${MODE_LABEL[state.currentMode] ?? "unknown"} -> ${MODE_LABEL[targetMode]}: ${reason}`);
    const ok = await setModeWithVerify(targetMode, { homeLoad: ess.homeLoad, pvPower, nextDemandMinutes: amber.nextDemandMinutes, sellPowerKw: alert?.sellPowerKw, throttled: chargeThrottled, planChargeKw: alert?.planChargeKwOverride ?? planSlotChargeKw });
    if (ok) {
      state.currentMode = targetMode;
      state.lastSwitchTime = now.toISOString();
      state.lastSwitchReason = reason;
      state.lastModeVerifyOk = true;
      modeChanged = true;
      if (targetMode === MODE.SELLING) {
        await createSellingCron();
      } else {
        await deleteSellingCron();
        state.lastSellEndSent = null; // reset so next sell session re-sends end time
      }

      // Mode verify: after a mode change, re-read reportedMode after 8s and retry if mismatch
      if (targetMode !== modeFrom) {
        await new Promise(r => setTimeout(r, 8000));
        // re-fetch reportedMode
        const verifyEss = await getESSData().catch(() => null);
        const verifiedMode = verifyEss?.reportedMode ?? null;
        const verifyOk = verifiedMode === targetMode;
        if (!verifyOk && verifiedMode !== null) {
          console.log(`[MODE VERIFY] Mismatch: set=${targetMode} reported=${verifiedMode}, retrying...`);
          await setMode(targetMode).catch(e => console.error('[MODE VERIFY] retry failed:', e));
          await new Promise(r => setTimeout(r, 5000));
          const verifyEss2 = await getESSData().catch(() => null);
          const verifiedMode2 = verifyEss2?.reportedMode ?? null;
          const verifyOk2 = verifiedMode2 === targetMode;
          if (!verifyOk2) {
            console.log(`⚠️ Mode verify FAILED after retry: set=${targetMode} reported=${verifiedMode2}`);
          }
          modeVerifyOk = verifyOk2 ? 1 : 0;
        } else {
          modeVerifyOk = verifyOk ? 1 : null;
        }
      }
    } else {
      state.lastModeVerifyOk = false;
      console.error(`[ERROR] Mode switch failed`);
    }
  } else {
    // Already in Selling mode: roll the end time window forward (+10 min)
    if (state.currentMode === MODE.SELLING) {
      await updateSellingEndTime(state);
    }
    // Already in Backup (charging) mode: roll the charge end time window forward (+10 min)
    if (state.currentMode === MODE.BACKUP) {
      // ── High load abort: stop charging immediately if no headroom remains ──
      // calcChargeKw() already does dynamic power calculation; this is a hard safety net.
      // Abort only when homeLoad is so high that even calcChargeKw returns < MIN_CHARGE_KW.
      const abortChargeKw = calcChargeKw(ess.homeLoad, pvPower);
      if (ess.homeLoad != null && ess.homeLoad >= HIGH_LOAD_ABORT_KW && abortChargeKw < MIN_CHARGE_KW) {
        console.log(`[BUY] ⚠️ HIGH LOAD ABORT: homeLoad=${ess.homeLoad.toFixed(2)}kW >= ${HIGH_LOAD_ABORT_KW}kW, headroom=${abortChargeKw.toFixed(2)}kW < ${MIN_CHARGE_KW}kW — stopping charge to prevent trip`);
        await setMode(MODE.SELF_USE);
        state.currentMode = MODE.SELF_USE;
        state.lastSwitchReason = `high load abort: homeLoad=${ess.homeLoad.toFixed(2)}kW >= ${HIGH_LOAD_ABORT_KW}kW`;
        saveState(state);
        console.log(`[INFO] Switched to Self-use due to high load`);
        return;
      }
      const { startHHMM, endHHMM } = timedModeTimeContext(amber.nextDemandMinutes);
      // Roll charge window
      const startOk = await setParam('0xC014', startHHMM);
      const endOk = await setParam('0xC016', endHHMM);
      console.log(`[BUY] Rolling charge window -> ${startHHMM}–${endHHMM} start=${startOk?'OK':'FAILED'} end=${endOk?'OK':'FAILED'}`);
      // Keep sell window collapsed (mutual exclusion) and discharge power = 0
      await setParam('0xC018', '0000');
      await setParam('0xC01A', '0000');
      await setParam('0xC0BC', 0); // ensure discharge power is zero while charging
      // Recalculate and update charge power based on current load/PV (throttle if cheaper slot coming)
      const chargeKw = chargeThrottled ? THROTTLE_CHARGE_KW : calcChargeKw(ess.homeLoad, pvPower);
      const minKwForUpdate = chargeThrottled ? 0.1 : MIN_CHARGE_KW;
      const buyTag = chargeThrottled ? '[BUY-THROTTLE]' : '[BUY]';
      if (chargeKw >= minKwForUpdate) {
        const pwOk = await setParam('0xC0BA', chargeKw);
        console.log(`${buyTag} Updated charge power -> ${chargeKw.toFixed(2)}kW (homeLoad=${(ess.homeLoad??0).toFixed(2)}kW, PV=${(pvPower??0).toFixed(2)}kW, buffer=${CHARGE_SAFETY_BUFFER}kW${chargeThrottled ? ', high-load throttle' : ''}) ${pwOk?'OK':'FAILED'}`);
      } else {
        console.log(`${buyTag} chargeKw=${chargeKw.toFixed(2)}kW < ${minKwForUpdate}kW — stopping charge (no headroom), switching to Self-use`);
        await setMode(MODE.SELF_USE);
        state.currentMode = MODE.SELF_USE;
        state.lastSwitchReason = `no headroom: chargeKw=${chargeKw.toFixed(2)}kW < ${MIN_CHARGE_KW}kW`;
        saveState(state);
        return;
      }
    }
    console.log(`[INFO] Mode: ${MODE_LABEL[state.currentMode] ?? "none"} (${reason})`);
  }

  state.lastCheck = now.toISOString();
  saveState(state);

  // ── Write decision ────────────────────────────────────────────────────────
  // Logging rules (DO NOT remove modeChanged from shouldLog when adjusting intervals):
  //   1. MODE CHANGE → ALWAYS write to DB, regardless of sampling interval.
  //      This is a hard requirement so mode transitions are never lost, even if the
  //      sampling cadence is later changed (e.g. from 5-min to 30-min or hourly).
  //   2. Dense logging window (2026-04-02 → 2026-04-16, 14 days): every 5-min run.
  //      Storage: 288 records/day × ~650 bytes ≈ 187 KB/day → ~2.6 MB total (SQLite ~4-5MB).
  //   3. After dense window: fall back to :01/:31 half-hour scheduled intervals.
  const minOfHour = now.getMinutes();
  const DENSE_LOG_END   = new Date('2026-04-16T00:00:00+11:00');
  const inDenseWindow   = now < DENSE_LOG_END;
  const isScheduledInterval = minOfHour === 1 || minOfHour === 31;
  // ⚠️  Keep `modeChanged` as an independent OR — never fold it into inDenseWindow/isScheduledInterval.
  const shouldLog = inDenseWindow || isScheduledInterval || modeChanged;

  if (!shouldLog) {
    console.log(`[SKIP] Not a log interval (:${String(minOfHour).padStart(2,'0')}, no mode change) — skipping DB write`);
    console.log(`[DONE]`);
    return;
  }

  if (modeChanged) console.log(`[LOG] Mode change triggered record`);
  else if (inDenseWindow) console.log(`[LOG] 5-min record (:${String(minOfHour).padStart(2,'0')})`);
  else console.log(`[LOG] Scheduled record (~${isScheduledInterval ? 'half-hour' : 'on-the-hour'})`);

  const record = {
    ts: now.toISOString(),
    nemTime,
    soc: ess.soc,
    battPower: ess.battPower,
    battVoltage: ess.battVoltage ?? null,
    battCurrent: ess.battCurrent ?? null,
    homeLoad: ess.homeLoad,
    pvPower,
    gridPower: ess.gridPower,
    buyPrice: currentPrice,
    feedInPrice,
    spotPrice,
    descriptor,
    tariffPeriod: tariffPeriod ?? null,
    clPrice:       clPrice ?? null,
    clDescriptor:  clDescriptor ?? null,
    clTariffPeriod: clTariffPeriod ?? null,
    renewables,
    demandWindow: currentDemand,
    nextDemandMinutes: nextDemandMinutes ?? null,
    mode: state.currentMode,
    modeChanged,
    modeReason: reason,
    alert: alert || null,
    meterBuyTotal: ess.purchasedTotal ?? null,
    meterSellTotal: ess.feedTotal ?? null,
    flowPV:      ess.flowPV      ?? null,
    flowGrid:    ess.flowGrid    ?? null,
    flowBattery: ess.flowBattery ?? null,
    flowLoad:    ess.flowLoad    ?? null,
    todayChargeKwh:    ess.todayChargeKwh    ?? null,
    todayDischargeKwh: ess.todayDischargeKwh ?? null,
    todayPvKwh:        ess.todayPvKwh        ?? null,
    todayGridBuyKwh:   ess.todayGridBuyKwh   ?? null,
    todayGridSellKwh:  ess.todayGridSellKwh  ?? null,
    todayHomeKwh:      ess.todayHomeKwh      ?? null,
    todayCarbonKg:     ess.todayCarbonKg     ?? null,
    reportedMode:      ess.reportedMode      ?? null,
    recordTrigger: modeChanged ? "mode_change" : isScheduledInterval ? "scheduled" : "5min",
    // Timed mode charge/discharge power set this interval (null if not in charge/sell mode)
    chargeKw:    state.currentMode === MODE.BACKUP  ? (chargeThrottled ? THROTTLE_CHARGE_KW : calcChargeKw(ess.homeLoad, pvPower)) : null,
    dischargeKw: state.currentMode === MODE.SELLING ? 5.0 : null,
    mode_verify_ok: modeChanged ? (modeVerifyOk !== null ? modeVerifyOk : (state.lastModeVerifyOk ? 1 : 0)) : null,
    mode_from: modeChanged ? modeFrom : null,
    mode_to:   modeChanged ? state.currentMode : null,
    // Solar/weather data from Open-Meteo forecast (populated by solar-forecast.js cron at 07:00)
    ...getCurrentSolarData(),
  };

  // ── Interval cost accounting ──────────────────────────────────────────────
  // gridPower: negative=import(buy), positive=export(sell)
  // intervalHours: 5-min cron=5/60, mode_change=5/60, scheduled(:00/:30)=0.5h
  const intervalHours = (record.recordTrigger === 'scheduled') ? 0.5 : (5/60);
  const intervalImportKwh = ess.gridPower != null && ess.gridPower < 0 ? Math.abs(ess.gridPower) * intervalHours : 0;
  const intervalExportKwh = ess.gridPower != null && ess.gridPower > 0 ? ess.gridPower * intervalHours : 0;
  // Prefer meter_delta for cost if available (more accurate); fall back to power×interval
  // intervalBuyAud is used for per-interval logging; daily_summary uses meter_delta sum
  record.intervalBuyAud  = parseFloat((intervalImportKwh * currentPrice / 100).toFixed(6));
  record.intervalSellAud = parseFloat((intervalExportKwh * feedInPrice  / 100).toFixed(6));
  record.intervalNetAud  = parseFloat((record.intervalBuyAud - record.intervalSellAud).toFixed(6));

  // ── Meter delta (actual kWh from cumulative meter readings) ──────────────
  // More accurate than power * interval — uses real meter values from inverter.
  const db = getDb();
  if (db && ess.purchasedTotal != null && ess.feedTotal != null) {
    try {
      const prev = db.prepare(
        "SELECT meter_buy_total, meter_sell_total FROM energy_log WHERE meter_buy_total IS NOT NULL ORDER BY ts DESC LIMIT 1"
      ).get();
      if (prev && prev.meter_buy_total != null) {
        const buyDelta  = ess.purchasedTotal - prev.meter_buy_total;
        const sellDelta = ess.feedTotal      - prev.meter_sell_total;
        // Sanity check: delta must be non-negative and under 1 kWh (max in 5 min at 10 kW)
        record.meterBuyDelta  = buyDelta  >= 0 && buyDelta  < 1 ? parseFloat(buyDelta.toFixed(4))  : null;
        record.meterSellDelta = sellDelta >= 0 && sellDelta < 1 ? parseFloat(sellDelta.toFixed(4)) : null;
      }
    } catch { /* silent */ }
  }
  appendLog(record);
  const daily = updateDailySummary(record);

  // 7. Price spike alerts
  if (descriptor === "spike" || currentPrice > 50) {
    console.log(`🚨 Price spike! ${currentPrice.toFixed(1)} c/kWh`);
  } else if (descriptor === "high" || currentPrice > 30) {
    console.log(`⚠️ High price: ${currentPrice.toFixed(1)} c/kWh`);
  }

  // 8. Print today's summary
  // Prefer inverter's own daily totals (accurate, from inverter registers x126A/x126C/x126E)
  // Fall back to DB accumulated values if inverter data unavailable
  const todayBuyKwh  = ess.todayGridBuyKwh  ?? daily.grid_buy_kwh  ?? 0;
  const todaySellKwh = ess.todayGridSellKwh ?? daily.grid_sell_kwh ?? 0;
  const todayHomeKwh = ess.todayHomeKwh     ?? daily.home_kwh      ?? 0;
  // Cost: use meter_buy/sell delta totals from DB (start vs end of day)
  const meterBuyKwh  = (daily.meter_buy_end  != null && daily.meter_buy_start  != null)
    ? (daily.meter_buy_end  - daily.meter_buy_start).toFixed(3)  : null;
  const meterSellKwh = (daily.meter_sell_end != null && daily.meter_sell_start != null)
    ? (daily.meter_sell_end - daily.meter_sell_start).toFixed(3) : null;

  const netCost = ((daily.cost_aud || 0) - (daily.earnings_aud || 0));
  console.log(`\n[TODAY] Home: ${todayHomeKwh.toFixed(2)} kWh  Grid-buy: ${todayBuyKwh.toFixed(2)} kWh  Grid-sell: ${todaySellKwh.toFixed(2)} kWh`);
  if (meterBuyKwh != null) {
    console.log(`[TODAY] Meter: buy=${meterBuyKwh} kWh  sell=${meterSellKwh} kWh  (cumulative delta, accurate)`);
  }
  console.log(`[TODAY] Cost: $${(daily.cost_aud||0).toFixed(3)}  Revenue: $${(daily.earnings_aud||0).toFixed(3)}  Net: $${netCost.toFixed(3)}`);
  console.log(`[TODAY] SOC avg/min/max: ${(daily.avg_soc||0).toFixed(0)}% / ${daily.min_soc||0}% / ${daily.max_soc||0}%`);
  if ((daily.demand_peak_kw || 0) > 0) {
    console.log(`[TODAY] ⚠️ Demand window peak: ${daily.demand_peak_kw.toFixed(2)} kW -> est. demand charge $${(daily.demand_charge_est||0).toFixed(2)}/day`);
  }

  console.log(`[DONE]`);
}

main().catch(err => { console.error("[FATAL]", err.message); process.exit(1); });
