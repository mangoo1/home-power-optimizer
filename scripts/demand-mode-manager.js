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
    `);
  } catch (e) {
    console.warn("[DB] better-sqlite3 not available:", e.message);
  }
  return _db;
}
const DAILY_SUMMARY = path.join(DATA_DIR, "daily-summary.json");
const STATE_FILE = "/tmp/demand-mode-state.json";

// Inverter modes
const MODE = { SELF_USE: 0, TIMED: 1, PV_PRIORITY: 5, SELLING: 6, BACKUP: 3 };
const MODE_LABEL = { 0: "Self-use", 1: "Timed", 3: "Backup", 5: "PV-Priority", 6: "Selling", 7: "Voltage-Reg" };

// Strategy parameters
const SOC_MAX_CHARGE = 90;        // Target SOC for backup/charge modes (%)
const SOC_MIN_SELL = 35;          // Min SOC allowed when selling (reserve for demand window)
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
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on("error", reject);
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
      text: `[Selling Safety Monitor]\n\nAMBER_API_TOKEN=psk_c654897f6caa055fda06e83369936242 ESS_TOKEN=${ESS_TOKEN} ESS_MAC_HEX=${MAC_HEX} AMBER_SITE_ID=${AMBER_SITE_ID} node /home/deven/.openclaw/workspace/scripts/selling-monitor.js\n\nIf output contains [EXIT SELL] or [ENTER SELL] or warning, relay to user. Otherwise silent.`,
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

// Set Timed/Selling mode with all required parameters.
// Steps:
//   0. Sync inverter clock to current AEST time
//   1. Set mode to Timed (1)
//   2. Set start time = now (HHMM)
//   3. Set end time = now + 10 min (HHMM) — rolling window, updated each 5-min cron
//   4. Set discharge power = 5 kW
//   5. Set other mode param = 0 (fixed)
//   6. Set active days = all week [0-6] (fixed)
//   7. Set start date = yesterday (already active)
//   8. Set end date = tomorrow (covers today fully)
async function setSellingMode() {
  if (!ESS_TOKEN) { console.log(`[SKIP] No ESS_TOKEN, would set Selling mode`); return false; }

  const now = new Date();
  const aest = new Date(now.getTime() + 11 * 3600 * 1000); // AEST = UTC+11

  // Current time as HHMM string (e.g. "1830")
  const fmt2 = n => String(n).padStart(2,'0');
  const startHHMM = fmt2(aest.getUTCHours()) + fmt2(aest.getUTCMinutes());

  // End time = now + 10 min rolling window
  const endDate = new Date(aest.getTime() + 10 * 60 * 1000);
  const endHHMM = fmt2(endDate.getUTCHours()) + fmt2(endDate.getUTCMinutes());

  // AEST datetime string for clock sync: "YYYY-MM-DD HH:MM:SS"
  const clockStr = aest.toISOString().replace('T',' ').substring(0,19);

  // Yesterday and tomorrow in AEST
  const fmtDate = d => d.toISOString().substring(0,10);
  const yesterday = fmtDate(new Date(aest.getTime() - 86400000));
  const tomorrow  = fmtDate(new Date(aest.getTime() + 86400000));

  console.log(`[SELL] Setting Timed mode: ${startHHMM}–${endHHMM} AEST, clock=${clockStr}, dates ${yesterday}–${tomorrow}`);

  const steps = [
    { label: `syncClock=${clockStr}`,  fn: () => httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceDateParam', { data: clockStr, macHex: MAC_HEX, index: '0x3050' }, { Authorization: ESS_TOKEN, ...ESS_HEADERS }).then(r => r.code === 200).catch(() => false) },
    { label: 'mode=Timed(1)',          fn: () => setParam('0x300C',  1) },
    { label: `startTime=${startHHMM}`, fn: () => setParam('0xC018', startHHMM) },
    { label: `endTime=${endHHMM}`,     fn: () => setParam('0xC01A', endHHMM) },
    { label: 'discharge=5kW',          fn: () => setParam('0xC0BC', 5) },
    { label: 'otherMode=0',            fn: () => setParam('0x314E', 0) },
    { label: 'weekdays=all',           fn: () => setParam('0xC0B4', [0,1,2,3,4,5,6]) },
    { label: `startDate=${yesterday}`, fn: () => setDateParam('0xC0B6', yesterday) },
    { label: `endDate=${tomorrow}`,    fn: () => setDateParam('0xC0B8', tomorrow) },
  ];

  for (const step of steps) {
    const ok = await step.fn();
    console.log(`[SELL]   ${step.label} -> ${ok ? 'OK' : 'FAILED'}`);
    if (!ok && step.label.startsWith('mode=')) return false; // mode step is critical
    await new Promise(r => setTimeout(r, 500));
  }
  return true;
}

// Update rolling end time window for active Selling mode (called each cron run while selling).
async function updateSellingEndTime() {
  const aest = new Date(Date.now() + 11 * 3600 * 1000);
  const end = new Date(aest.getTime() + 10 * 60 * 1000);
  const endHHMM = String(end.getUTCHours()).padStart(2,'0') + String(end.getUTCMinutes()).padStart(2,'0');
  const ok = await setParam('0xC01A', endHHMM);
  console.log(`[SELL] Rolling end time -> ${endHHMM} ${ok ? 'OK' : 'FAILED'}`);
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
// For Selling mode, uses the full 8-step Timed mode setup.
// Also verifies grid is actually exporting (gridPower > 0) for Selling.
// Returns true if mode was confirmed, false if all attempts failed.
async function setModeWithVerify(targetMode) {
  const label = MODE_LABEL[targetMode] ?? targetMode;
  const maxAttempts = targetMode === MODE.SELLING ? 2 : 5; // Selling: max 2 (8 steps × 2 costly)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Use full Timed mode setup for Selling; simple setMode for others
    const ok = targetMode === MODE.SELLING
      ? await setSellingMode()
      : await setMode(targetMode);

    if (!ok) {
      console.warn(`[WARN] Mode setup failed (attempt ${attempt}/${maxAttempts})`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    // Wait for inverter to apply
    await new Promise(r => setTimeout(r, 4000));

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
    } else {
      if (reported === targetMode) {
        console.log(`[VERIFY] Mode confirmed: ${label} (reported=${reported}) ✓`);
        return true;
      }
      console.warn(`[WARN] Mode mismatch after attempt ${attempt}/${maxAttempts}: expected ${targetMode}(${label}), got ${reported}(${MODE_LABEL[reported] ?? reported})`);
    }

    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 3000));
  }
  console.error(`[ERROR] Mode switch to ${label} failed after ${maxAttempts} attempts`);
  return false;
}

// ── State ─────────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { currentMode: null, lastSwitchTime: null }; }
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
         meter_buy_delta, meter_sell_delta, record_trigger)
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
         @meterBuyDelta, @meterSellDelta, @recordTrigger)
    `).run({
      ts: record.ts, nemTime: record.nemTime, soc: record.soc,
      battPower: record.battPower, homeLoad: record.homeLoad,
      pvPower: record.pvPower, gridPower: record.gridPower,
      buyPrice: record.buyPrice, feedInPrice: record.feedInPrice,
      spotPrice: record.spotPrice, demandWindow: record.demandWindow ? 1 : 0,
      mode: record.mode, modeChanged: record.modeChanged ? 1 : 0,
      modeReason: record.modeReason || null, renewables: record.renewables,
      alert: record.alert || null,
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
    });
  } catch (e) { console.warn("[DB] insert failed:", e.message); }
}

function updateDailySummary(record) {
  ensureDataDir();
  const today = record.ts.substring(0, 10);

  const db = getDb();
  if (db) {
    try {
      db.prepare(`
        INSERT INTO daily_summary (date, intervals, home_kwh, grid_buy_kwh, grid_sell_kwh,
          cost_aud, earnings_aud, demand_peak_kw, demand_charge_est, avg_soc, min_soc, max_soc,
          meter_buy_start, meter_buy_end, meter_sell_start, meter_sell_end)
        VALUES (@date, 1, @home, @buy, @sell, @cost, @earn, @peak, @charge, @soc, @soc, @soc,
          @meterBuy, @meterBuy, @meterSell, @meterSell)
        ON CONFLICT(date) DO UPDATE SET
          intervals = intervals + 1,
          home_kwh = home_kwh + @home,
          grid_buy_kwh = grid_buy_kwh + @buy,
          grid_sell_kwh = grid_sell_kwh + @sell,
          cost_aud = cost_aud + @cost,
          earnings_aud = earnings_aud + @earn,
          demand_peak_kw = MAX(demand_peak_kw, @peak),
          demand_charge_est = MAX(demand_peak_kw, @peak) * 0.6104,
          avg_soc = (avg_soc * intervals + @soc) / (intervals + 1),
          min_soc = MIN(min_soc, @soc),
          max_soc = MAX(max_soc, @soc),
          meter_buy_end  = COALESCE(@meterBuy, meter_buy_end),
          meter_sell_end = COALESCE(@meterSell, meter_sell_end),
          meter_buy_start  = COALESCE(meter_buy_start, @meterBuy),
          meter_sell_start = COALESCE(meter_sell_start, @meterSell)
      `).run({
        date: today,
        home: (record.homeLoad || 0) * 0.5,
        // gridPower: negative=import(buy), positive=export(sell)
        buy:  record.gridPower < 0 ? Math.abs(record.gridPower) * 0.5 : 0,
        sell: record.gridPower > 0 ? record.gridPower * 0.5 : 0,
        cost: record.gridPower < 0 ? Math.abs(record.gridPower) * 0.5 * (record.buyPrice || 0) / 100 : 0,
        earn: record.gridPower > 0 ? record.gridPower * 0.5 * (record.feedInPrice || 0) / 100 : 0,
        peak: (record.demandWindow && record.gridPower < 0) ? Math.abs(record.gridPower) : 0,
        charge: 0, soc: record.soc || 0,
        meterBuy:  record.meterBuyTotal ?? null,
        meterSell: record.meterSellTotal ?? null,
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
  const { soc, homeLoad, gridPower, battPower } = ess;
  const { currentDemand, currentPrice, feedInPrice, spotPrice, nextDemandMinutes, descriptor } = amber;
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
  // Only force charge if SOC < 60% — enough reserve to cover the demand window.
  // If SOC >= 60%, the battery is sufficient; let normal price rules apply.
  const PRE_DW_CHARGE_SOC = 60; // % minimum SOC threshold for forced pre-DW charging
  if (!currentDemand && nextDemandMinutes != null && nextDemandMinutes <= 60 && nextDemandMinutes > 10 && soc < PRE_DW_CHARGE_SOC) {
    targetMode = MODE.BACKUP;
    reason = `demand window in ${nextDemandMinutes.toFixed(0)} min — force charging (SOC ${soc}% < ${PRE_DW_CHARGE_SOC}%)`;
    return { targetMode, reason, alert };
  }

  // ── Priority 3: Free/negative-price charging (spot <= 0) ─────────────────
  // Guard: never charge during demand window (handled in priority 1)
  if (!currentDemand && spotPrice <= CHARGE_SPOT_MAX && soc < SOC_MAX_CHARGE) {
    targetMode = MODE.BACKUP;
    reason = `spot=${spotPrice.toFixed(2)}c (<=0) — free charging (SOC ${soc}% -> ${SOC_MAX_CHARGE}%)`;
    return { targetMode, reason, alert };
  }
  if (!currentDemand && spotPrice <= CHARGE_SPOT_MAX && soc >= SOC_MAX_CHARGE) {
    // Battery full — exit Backup
    if (state.currentMode === MODE.BACKUP) {
      targetMode = MODE.SELF_USE;
      reason = `SOC reached ${soc}% (>=${SOC_MAX_CHARGE}%) — stop charging`;
    }
    return { targetMode, reason, alert };
  }

  // ── Priority 4: Cheap rate charging (buy < 10c, SOC < 90%) ───────────────
  // Guard: never charge during demand window.
  const CHEAP_BUY_MAX = 10;                // c/kWh upper limit for cheap charging
  const CHEAP_CHARGE_SOC = SOC_MAX_CHARGE; // stop charging at this SOC
  if (!currentDemand && currentPrice < CHEAP_BUY_MAX && soc < CHEAP_CHARGE_SOC) {
    targetMode = MODE.BACKUP;
    reason = `buy=${currentPrice.toFixed(2)}c (<${CHEAP_BUY_MAX}c) — cheap rate charging (SOC ${soc}% -> ${CHEAP_CHARGE_SOC}%)`;
    return { targetMode, reason, alert };
  }
  // Exit cheap-rate charging: SOC full or price rose above threshold
  if (state.currentMode === MODE.BACKUP && (currentPrice >= CHEAP_BUY_MAX || soc >= CHEAP_CHARGE_SOC)) {
    if (spotPrice > CHARGE_SPOT_MAX) {
      targetMode = MODE.SELF_USE;
      reason = `cheap rate charging ended (buy=${currentPrice.toFixed(2)}c, SOC=${soc}%, target=${CHEAP_CHARGE_SOC}%)`;
      return { targetMode, reason, alert };
    }
  }

  // ── Priority 4b: extremelyLow descriptor charging (buy < 12c) ─────────────
  // When Amber rates the price as extremelyLow, allow charging up to 12c/kWh.
  // Priorities 1/2/2.5 guarantee we are outside the demand window here.
  const EXTREMELY_LOW_MAX = 12; // c/kWh — relaxed ceiling for extremelyLow periods
  if (!currentDemand && descriptor === 'extremelyLow' && currentPrice < EXTREMELY_LOW_MAX && soc < SOC_MAX_CHARGE) {
    targetMode = MODE.BACKUP;
    reason = `descriptor=extremelyLow, buy=${currentPrice.toFixed(2)}c (<${EXTREMELY_LOW_MAX}c) — charging (SOC ${soc}% -> ${SOC_MAX_CHARGE}%)`;
    return { targetMode, reason, alert };
  }
  // Exit extremelyLow charging
  if (state.currentMode === MODE.BACKUP && descriptor === 'extremelyLow' && (currentPrice >= EXTREMELY_LOW_MAX || soc >= SOC_MAX_CHARGE) && spotPrice > CHARGE_SPOT_MAX) {
    targetMode = MODE.SELF_USE;
    reason = `extremelyLow charging ended (buy=${currentPrice.toFixed(2)}c, SOC=${soc}%)`;
    return { targetMode, reason, alert };
  }

  // ── Priority 5: Sell to grid (high feedIn, sufficient SOC, inverter headroom) ──
  // Selling is allowed during demand window (exporting does NOT create demand charge).
  // Charging priorities 3/4/4b are NOT reached during demand window because
  // priority 1 either returns early (if was charging) or falls through here.
  const SELL_MIN_MARGIN = 5;        // c/kWh minimum margin above avg buy price
  const SELL_ABS_MIN = 14;          // c/kWh absolute floor (protects against midnight/no-data edge case)
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
  const effectiveSellMin = avgBuyPrice != null
    ? Math.max(SELL_ABS_MIN, avgBuyPrice + SELL_MIN_MARGIN)
    : SELL_ABS_MIN;
  const sellMinLabel = avgBuyPrice != null
    ? `avg_buy=${avgBuyPrice.toFixed(1)}c+${SELL_MIN_MARGIN}c=>${effectiveSellMin.toFixed(1)}c`
    : `abs_floor=${SELL_ABS_MIN}c (${avgBuyCalc.reason})`;

  if (feedInPrice >= effectiveSellMin && soc > SOC_MIN_SELL) {
    const maxSellPower = INVERTER_MAX_DISCHARGE - (homeLoad ?? 0) - 0.3;
    if (maxSellPower > 0.2) {
      targetMode = MODE.SELLING;
      reason = `feedIn=${feedInPrice.toFixed(1)}c (>=${effectiveSellMin.toFixed(1)}c, ${sellMinLabel}), SOC ${soc}% (>${SOC_MIN_SELL}%), headroom ${maxSellPower.toFixed(1)}kW`;
    } else {
      reason = `feedIn high but home load ${homeLoad?.toFixed(1)}kW saturates inverter — no selling (${sellMinLabel})`;
    }
    return { targetMode, reason, alert };
  }

  // Exit selling mode: price dropped or SOC too low
  if (state.currentMode === MODE.SELLING && (feedInPrice < effectiveSellMin || soc <= SOC_MIN_SELL)) {
    targetMode = MODE.SELF_USE;
    reason = `stop selling (feedIn=${feedInPrice.toFixed(1)}c < ${effectiveSellMin.toFixed(1)}c, ${sellMinLabel}, SOC=${soc}%)`;
    return { targetMode, reason, alert };
  }

  // ── Default: Self-use ────────────────────────────────────────────────────
  // Also catches: demand window active + sell not triggered = stay Self-use
  if (state.currentMode == null) {
    targetMode = MODE.SELF_USE;
    reason = "initialising — default to Self-use";
  }

  return { targetMode, reason, alert };
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
      `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?resolution=5&next=3`,
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
  // Zero price + zero renewables + no nemTime = bad data. Skip decision to avoid false charging.
  const amberDataValid = general.length > 0 && (currentPrice !== 0 || renewables !== 0 || current.nemTime != null);
  if (!amberDataValid) {
    console.error("[ERROR] Amber API returned invalid/zero data — skipping decision to avoid false mode switch");
    console.log(`[DONE]`);
    return;
  }

  // Find next demand window start time from forecast
  const nextDemandInterval = !currentDemand
    ? forecast.find(p => p.tariffInformation?.demandWindow === true)
    : null;
  const nextDemandMinutes = nextDemandInterval
    ? (new Date(nextDemandInterval.startTime) - now) / 1000 / 60
    : null;

  const amber = { currentDemand, currentPrice, feedInPrice, spotPrice, descriptor, renewables, nextDemandMinutes, tariffPeriod, clPrice, clDescriptor, clTariffPeriod };

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
  const todaySummary = (() => {
    try {
      const _db = getDb();
      if (!_db) return {};
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
      return _db.prepare("SELECT * FROM daily_summary WHERE date=?").get(today) || {};
    } catch { return {}; }
  })();
  const { targetMode, reason, alert } = decide(ess, pvPower, amber, state, todaySummary);

  if (alert) console.log(`[ALERT] ${alert}`);

  let modeChanged = false;
  if (targetMode !== null && targetMode !== state.currentMode) {
    console.log(`[ACTION] ${MODE_LABEL[state.currentMode] ?? "unknown"} -> ${MODE_LABEL[targetMode]}: ${reason}`);
    const ok = await setModeWithVerify(targetMode);
    if (ok) {
      state.currentMode = targetMode;
      state.lastSwitchTime = now.toISOString();
      state.lastSwitchReason = reason;
      modeChanged = true;
      if (targetMode === MODE.SELLING) {
        await createSellingCron();
      } else {
        await deleteSellingCron();
      }
    } else {
      console.error(`[ERROR] Mode switch failed`);
    }
  } else {
    // Already in Selling mode: roll the end time window forward (+10 min)
    if (state.currentMode === MODE.SELLING) {
      await updateSellingEndTime();
    }
    console.log(`[INFO] Mode: ${MODE_LABEL[state.currentMode] ?? "none"} (${reason})`);
  }

  state.lastCheck = now.toISOString();
  saveState(state);

  // ── Write decision ────────────────────────────────────────────────────────
  // Runs every 5 min but only writes to DB on:
  //   A. Scheduled intervals (:00 or :30 of each hour)
  //   B. Mode change (immediate capture of trigger reason)
  const minOfHour = now.getMinutes();
  const isScheduledInterval = (minOfHour === 0 || minOfHour === 30);
  const shouldLog = isScheduledInterval || modeChanged;

  if (!shouldLog) {
    console.log(`[SKIP] Not a log interval (${minOfHour}min, no mode change) — skipping DB write`);
    console.log(`[DONE]`);
    return;
  }

  if (modeChanged) console.log(`[LOG] Mode change triggered record`);
  else console.log(`[LOG] Scheduled record (${minOfHour === 0 ? "on-the-hour" : "half-hour"})`);

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
    recordTrigger: modeChanged ? "mode_change" : "scheduled",
  };

  // ── Interval cost accounting ──────────────────────────────────────────────
  // gridPower: negative=import(buy), positive=export(sell)
  // Scheduled records use 0.5h window; mode-change records use 5-min window.
  const intervalHours = modeChanged ? (5/60) : 0.5;
  const intervalImportKwh = ess.gridPower != null && ess.gridPower < 0 ? Math.abs(ess.gridPower) * intervalHours : 0;
  const intervalExportKwh = ess.gridPower != null && ess.gridPower > 0 ? ess.gridPower * intervalHours : 0;
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
  const netCost = ((daily.cost_aud || 0) - (daily.earnings_aud || 0));
  console.log(`\n[TODAY] Home: ${(daily.home_kwh||0).toFixed(2)} kWh  Grid-buy: ${(daily.grid_buy_kwh||0).toFixed(2)} kWh  Grid-sell: ${(daily.grid_sell_kwh||0).toFixed(2)} kWh`);
  console.log(`[TODAY] Cost: $${(daily.cost_aud||0).toFixed(3)}  Revenue: $${(daily.earnings_aud||0).toFixed(3)}  Net: $${netCost.toFixed(3)}`);
  console.log(`[TODAY] SOC avg/min/max: ${(daily.avg_soc||0).toFixed(0)}% / ${daily.min_soc||0}% / ${daily.max_soc||0}%`);
  if ((daily.demand_peak_kw || 0) > 0) {
    console.log(`[TODAY] ⚠️ Demand window peak: ${daily.demand_peak_kw.toFixed(2)} kW -> est. demand charge $${(daily.demand_charge_est||0).toFixed(2)}/day`);
  }

  console.log(`[DONE]`);
}

main().catch(err => { console.error("[FATAL]", err.message); process.exit(1); });
