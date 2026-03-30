#!/usr/bin/env node
/**
 * demand-mode-manager.js
 *
 * 每 30 分钟执行一次（由 cron 触发）：
 * 1. 读取实时数据：SOC、家庭用电、PV发电、电网功率
 * 2. 读取 Amber 电价（当前 + 预测）
 * 3. 根据决策树自动切换逆变器模式
 * 4. 将数据追加到 data/energy-log.jsonl（每 30 分钟一行）
 * 5. 更新 data/daily-summary.json（当天汇总）
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// Load .env from project root (one level up from scripts/)
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

// ── 配置 ─────────────────────────────────────────────────────────────────────
const AMBER_TOKEN = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID || "YOUR_AMBER_SITE_ID";
const ESS_TOKEN = process.env.ESS_TOKEN;
const MAC_HEX = process.env.ESS_MAC_HEX || "YOUR_ESS_MAC_HEX";
const STATION_SN = process.env.ESS_STATION_SN || "YOUR_ESS_STATION_SN";

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
        meter_sell_delta REAL    -- meter_sell_total - prev meter_sell_total (actual kWh from meter)
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
      -- 迁移：补加新列（已存在时忽略报错）
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

// 逆变器模式
const MODE = { SELF_USE: 0, TIMED: 1, PV_PRIORITY: 5, SELLING: 6, BACKUP: 3 };
const MODE_LABEL = { 0: "Self-use", 1: "Timed", 3: "Backup", 5: "PV-Priority", 6: "Selling", 7: "Voltage-Reg" };

// 策略参数
const SOC_MAX_CHARGE = 90;        // Backup 模式充电上限
const SOC_MIN_SELL = 35;          // 卖电时 SOC 不低于此值（保留明天 demand window 用量）
const SOC_WARN = 20;              // Demand window 内 SOC 告警阈值
const SELL_FEEDIN_MIN = 10;       // 卖电最低 feedIn 价格（c/kWh）
const CHARGE_SPOT_MAX = 0;        // Backup 充电最高 spot 价格（≤0 才充）
const BATTERY_CAPACITY = 42;      // kWh 总容量
const BATTERY_MIN_SOC = 10;       // 最低 SOC %
const INVERTER_MAX_DISCHARGE = 5; // kW 最大放电功率

// ESS API headers
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

// ESS Web API headers (uses Bearer prefix, different from app API)
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
    // App API — realtime instantaneous
    soc:            findVal(battery, "0x1212"),       // %
    battPower:      findVal(battery, "0x1210"),       // kW (+充电 / -放电)
    battVoltage:    findVal(battery, "0x120C"),       // V
    battCurrent:    findVal(battery, "0x120E"),       // A
    homeLoad:       findVal(load, "0x1274"),          // kW 家庭用电总功率
    gridPower:      findVal(meter, "0xA112"),         // kW: negative=import(买电) / positive=export(卖电)
    pvPowerApp:     findValStr(pv, "0x1270"),         // kW 实时 PV（用 valueStr，value 字段有编码 bug）
    pvEnergy:       findVal(pv, "0x125C"),            // kWh 累计发电
    purchasedTotal: findVal(meter, "0x1240"),         // kWh 累计买电
    feedTotal:      findVal(meter, "0x1242"),         // kWh 累计卖电

    // Web API — flow diagram (single-call energy snapshot)
    flowPV:         flow?.totalPVPower      ?? null,  // kW solar
    flowGrid:       flow?.totalGridPower    ?? null,  // kW: negative=import(买电) / positive=export(卖电)
    flowBattery:    flow?.totalBatteryPower ?? null,  // kW: positive=charging
    flowLoad:       flow?.totalLoadPower    ?? null,  // kW AC home load

    // Web API — battery details (today's kWh)
    todayChargeKwh:    battDetails?.todaycharge    ?? null,
    todayDischargeKwh: battDetails?.todaydischarge ?? null,

    // Web API — running info (today's totals + current mode)
    todayPvKwh:       runInfo?.x1264 ?? null,   // today PV kWh
    todayBattChargeKwh2: runInfo?.x1266 ?? null, // today batt charge kWh (alt source)
    todayGridBuyKwh:  runInfo?.x126A ?? null,   // today grid buy kWh
    todayGridSellKwh: runInfo?.x126C ?? null,   // today grid sell kWh
    todayHomeKwh:     runInfo?.x126E ?? null,   // today home load kWh
    todayCarbonKg:    runInfo?.carbon ?? null,  // kg CO2 saved today
    reportedMode:     runInfo?.x300C ?? null,   // current mode from portal
  };
}

// PV 实时功率：优先用 app API 0x1270 真实值，fallback 推算
// homeLoad = pvPower + battDischarge + gridImport  (逆变器能量守恒)
function calcPVPower(ess) {
  if (ess.pvPowerApp != null) return ess.pvPowerApp;
  if (ess.homeLoad == null) return null;
  const battDischarge = ess.battPower != null ? -ess.battPower : 0; // 放电为正
  // gridPower 负=买电(import)，取反得正的买电量
  const gridImport = ess.gridPower != null ? -ess.gridPower : 0;
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
      text: `【卖电安全监控】\n\nAMBER_API_TOKEN=ESS_TOKEN=${ESS_TOKEN} ESS_MAC_HEX=${MAC_HEX} AMBER_SITE_ID=${AMBER_SITE_ID} node /home/deven/.openclaw/workspace/scripts/selling-monitor.js\n\n如果输出包含 [EXIT SELL] 或 [ENTER SELL] 或 ⚠️，请转告用户。否则静默。`,
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
async function setMode(mode) {
  if (!ESS_TOKEN) { console.log(`[SKIP] No ESS_TOKEN, would set mode ${MODE_LABEL[mode]}`); return false; }
  try {
    const r = await httpsPost(
      "https://eu.ess-link.com/api/app/deviceInfo/setDeviceParam",
      { data: mode, macHex: MAC_HEX, index: "0x300C" },
      { Authorization: ESS_TOKEN, ...ESS_HEADERS }
    );
    return r.code === 200;
  } catch { return false; }
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
  // 1. 写 JSONL（备份）
  fs.appendFileSync(ENERGY_LOG, JSON.stringify(record) + "\n");

  // 2. 写 SQLite
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
         meter_buy_delta, meter_sell_delta)
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
         @meterBuyDelta, @meterSellDelta)
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
    });
  } catch (e) { console.warn("[DB] insert failed:", e.message); }
}

function updateDailySummary(record) {
  ensureDataDir();
  const today = record.ts.substring(0, 10);

  // SQLite upsert
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
        // gridPower: negative=import(买电), positive=export(卖电)
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

  // 返回今天汇总供打印
  if (db) {
    try { return db.prepare("SELECT * FROM daily_summary WHERE date=?").get(today) || {}; }
    catch {}
  }
  return {};
}

// ── Decision engine ───────────────────────────────────────────────────────────
function decide(ess, pvPower, amber, state) {
  const { soc, homeLoad, gridPower, battPower } = ess;
  const { currentDemand, currentPrice, feedInPrice, spotPrice, nextDemandMinutes } = amber;
  const usableEnergy = (soc - BATTERY_MIN_SOC) / 100 * BATTERY_CAPACITY; // kWh 可用
  const hoursRemaining = homeLoad > 0 ? usableEnergy / homeLoad : 99;

  let targetMode = state.currentMode;
  let reason = "no change";
  let alert = null;

  // ── 优先级 1：Demand window 保护（最高优先级）──────────────────────
  if (currentDemand) {
    if (soc < SOC_WARN) {
      alert = `⚠️ Demand window 中 SOC 仅 ${soc}%，剩余可用 ${usableEnergy.toFixed(1)} kWh，预计 ${hoursRemaining.toFixed(1)} 小时后耗尽`;
    }
    if (state.currentMode !== MODE.SELF_USE) {
      targetMode = MODE.SELF_USE;
      reason = `demand window 中，强制 Self-use（SOC ${soc}%）`;
    } else {
      reason = `demand window 中，维持 Self-use`;
    }
    return { targetMode, reason, alert };
  }

  // ── 优先级 2：Demand window 即将开始（5 分钟内）───────────────────
  if (!currentDemand && nextDemandMinutes != null && nextDemandMinutes <= 5 && nextDemandMinutes > -5) {
    targetMode = MODE.SELF_USE;
    reason = `demand window 将在 ${nextDemandMinutes.toFixed(0)} 分钟后开始`;
    return { targetMode, reason, alert };
  }

  // ── 优先级 3：免费/负价充电（spot ≤ 0）──────────────────────────────
  if (spotPrice <= CHARGE_SPOT_MAX && soc < SOC_MAX_CHARGE) {
    targetMode = MODE.BACKUP;
    reason = `spot=${spotPrice.toFixed(2)}c（≤0），免费充电（SOC ${soc}% → 目标 ${SOC_MAX_CHARGE}%）`;
    return { targetMode, reason, alert };
  }
  if (spotPrice <= CHARGE_SPOT_MAX && soc >= SOC_MAX_CHARGE) {
    // 满了，切回 Self-use
    if (state.currentMode === MODE.BACKUP) {
      targetMode = MODE.SELF_USE;
      reason = `SOC 已达 ${soc}%（≥${SOC_MAX_CHARGE}%），停止充电`;
    }
    return { targetMode, reason, alert };
  }

  // ── 优先级 4：低价充电（buy < 10c 且 SOC < 95%）────────────────────────────────
  // Demand window 已在优先级 1/2 处理，走到这里说明不在 demand window 内
  const CHEAP_BUY_MAX = 10;   // c/kWh
  const CHEAP_CHARGE_SOC = 95; // % 充到此 SOC 停止
  if (currentPrice < CHEAP_BUY_MAX && soc < CHEAP_CHARGE_SOC) {
    targetMode = MODE.BACKUP;
    reason = `buy=${currentPrice.toFixed(2)}c（<${CHEAP_BUY_MAX}c），低价充电（SOC ${soc}% → 目标 ${CHEAP_CHARGE_SOC}%）`;
    return { targetMode, reason, alert };
  }
  // 充满或电价回升 → 已在 Backup 模式则退出
  if (state.currentMode === MODE.BACKUP && (currentPrice >= CHEAP_BUY_MAX || soc >= CHEAP_CHARGE_SOC)) {
    // 只有当前处于"低价充电"触发的 Backup 才退出（免费/负价充电在优先级 3 已处理）
    if (spotPrice > CHARGE_SPOT_MAX) {
      targetMode = MODE.SELF_USE;
      reason = `低价充电结束（buy=${currentPrice.toFixed(2)}c，SOC=${soc}%）`;
      return { targetMode, reason, alert };
    }
  }

  // ── 优先级 5：高价卖电机会（feedIn 高 且 SOC 充裕 且 逆变器有余量）──────────────
  if (feedInPrice >= SELL_FEEDIN_MIN && soc > SOC_MIN_SELL) {
    const maxSellPower = INVERTER_MAX_DISCHARGE - (homeLoad ?? 0) - 0.3;
    if (maxSellPower > 0.2) {
      targetMode = MODE.SELLING;
      reason = `feedIn=${feedInPrice.toFixed(1)}c（≥${SELL_FEEDIN_MIN}c），SOC ${soc}%（>${SOC_MIN_SELL}%），逆变器余量 ${maxSellPower.toFixed(1)}kW`;
    } else {
      reason = `feedIn 够高但家用 ${homeLoad?.toFixed(1)}kW 占满逆变器，不卖电`;
    }
    return { targetMode, reason, alert };
  }

  // 已在卖电模式，但价格不够高或 SOC 太低 → 停止
  if (state.currentMode === MODE.SELLING && (feedInPrice < SELL_FEEDIN_MIN || soc <= SOC_MIN_SELL)) {
    targetMode = MODE.SELF_USE;
    reason = `停止卖电（feedIn=${feedInPrice.toFixed(1)}c，SOC=${soc}%）`;
    return { targetMode, reason, alert };
  }

  // ── 默认：Self-use ────────────────────────────────────────────────────
  if (state.currentMode == null) {
    targetMode = MODE.SELF_USE;
    reason = "初始化默认模式";
  }

  return { targetMode, reason, alert };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  console.log(`\n[${now.toISOString()}] === demand-mode-manager ===`);

  if (!AMBER_TOKEN) { console.error("[ERROR] AMBER_API_TOKEN not set"); process.exit(1); }

  // 1. 并发获取 ESS + Amber 数据
  const [ess, amberRaw] = await Promise.all([
    getESSData(),
    httpsGet(
      `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?resolution=30&next=8`,
      { Authorization: `Bearer ${AMBER_TOKEN}` }
    ).catch(() => []),
  ]);

  // 2. 解析 Amber 数据
  const general        = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "general")        : [];
  const feedInCh       = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "feedIn")         : [];
  const controlledLoad = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "controlledLoad") : [];
  const current        = general[0]        || {};
  const feedInCurrent  = feedInCh[0]       || {};
  const clCurrent      = controlledLoad[0] || {};
  const forecast       = general.filter(p => p.type === "ForecastInterval");

  const currentDemand  = current.tariffInformation?.demandWindow ?? false;
  const currentPrice   = current.perKwh ?? 0;
  const feedInPrice    = Math.abs(feedInCurrent.perKwh ?? 0);  // feedIn perKwh 为负，取绝对值得实际收入
  const feedInSpot     = current.spotPerKwh ?? 0;               // spot 对 feedIn 也相同（同一 NEM 节点）
  const clPrice        = clCurrent.perKwh ?? null;              // Controlled Load 电价（null 若不存在）
  const clDescriptor   = clCurrent.descriptor ?? null;
  const spotPrice      = current.spotPerKwh ?? 0;
  const descriptor     = current.descriptor ?? "unknown";
  const renewables     = current.renewables ?? 0;
  const nemTime        = current.nemTime ?? now.toISOString();
  const tariffPeriod   = current.tariffInformation?.period ?? null;
  const clTariffPeriod = clCurrent.tariffInformation?.period ?? null;

  // 找下一个 demand window 开始时间
  const nextDemandInterval = !currentDemand
    ? forecast.find(p => p.tariffInformation?.demandWindow === true)
    : null;
  const nextDemandMinutes = nextDemandInterval
    ? (new Date(nextDemandInterval.startTime) - now) / 1000 / 60
    : null;

  const amber = { currentDemand, currentPrice, feedInPrice, spotPrice, descriptor, renewables, nextDemandMinutes, tariffPeriod, clPrice, clDescriptor, clTariffPeriod };

  // 3. 计算推算 PV 功率
  const pvPower = calcPVPower(ess);

  // 4. 打印实时状态
  console.log(`[DATA] NEM: ${nemTime}`);
  console.log(`[DATA] SOC: ${ess.soc}%  BattPwr: ${ess.battPower?.toFixed(2)} kW  HomeLoad: ${ess.homeLoad?.toFixed(2)} kW  PV: ${pvPower?.toFixed(2)} kW  Grid: ${ess.gridPower?.toFixed(2)} kW`);
  console.log(`[DATA] Price: buy=${currentPrice.toFixed(2)}c  cl=${clPrice != null ? clPrice.toFixed(2)+"c" : "n/a"}  feedIn=${feedInPrice.toFixed(2)}c  spot=${spotPrice.toFixed(2)}c  demandWindow=${currentDemand}  renewables=${renewables}%`);
  if (nextDemandMinutes != null) console.log(`[DATA] Next demandWindow in ${nextDemandMinutes.toFixed(0)} min`);

  // 5. 执行决策
  const state = loadState();
  const { targetMode, reason, alert } = decide(ess, pvPower, amber, state);

  if (alert) console.log(`[ALERT] ${alert}`);

  let modeChanged = false;
  if (targetMode !== null && targetMode !== state.currentMode) {
    console.log(`[ACTION] ${MODE_LABEL[state.currentMode] ?? "unknown"} → ${MODE_LABEL[targetMode]}: ${reason}`);
    const ok = await setMode(targetMode);
    if (ok) {
      state.currentMode = targetMode;
      state.lastSwitchTime = now.toISOString();
      state.lastSwitchReason = reason;
      modeChanged = true;
      // 进入卖电模式：启动 5 分钟安全监控 cron
      if (targetMode === MODE.SELLING) {
        await createSellingCron();
      } else {
        // 离开卖电模式：停止安全监控 cron
        await deleteSellingCron();
      }
    } else {
      console.error(`[ERROR] Mode switch failed`);
    }
  } else {
    console.log(`[INFO] Mode: ${MODE_LABEL[state.currentMode] ?? "none"} (${reason})`);
  }

  state.lastCheck = now.toISOString();
  saveState(state);

  // 6. 记录数据
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
    // Amber — Controlled Load channel
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
    // Web API — flow
    flowPV:      ess.flowPV      ?? null,
    flowGrid:    ess.flowGrid    ?? null,
    flowBattery: ess.flowBattery ?? null,
    flowLoad:    ess.flowLoad    ?? null,
    // Web API — today's totals (from battDetails + runInfo)
    todayChargeKwh:    ess.todayChargeKwh    ?? null,
    todayDischargeKwh: ess.todayDischargeKwh ?? null,
    todayPvKwh:        ess.todayPvKwh        ?? null,
    todayGridBuyKwh:   ess.todayGridBuyKwh   ?? null,
    todayGridSellKwh:  ess.todayGridSellKwh  ?? null,
    todayHomeKwh:      ess.todayHomeKwh      ?? null,
    todayCarbonKg:     ess.todayCarbonKg     ?? null,
    reportedMode:      ess.reportedMode      ?? null,
  };

  // ── Interval cost accounting ──────────────────────────────────────────────
  // gridPower: negative=import(买电), positive=export(卖电)
  // 0.5h window: kWh = |gridPower| * 0.5
  const intervalImportKwh = ess.gridPower != null && ess.gridPower < 0 ? Math.abs(ess.gridPower) * 0.5 : 0;
  const intervalExportKwh = ess.gridPower != null && ess.gridPower > 0 ? ess.gridPower * 0.5 : 0;
  record.intervalBuyAud  = parseFloat((intervalImportKwh * currentPrice / 100).toFixed(6));
  record.intervalSellAud = parseFloat((intervalExportKwh * feedInPrice  / 100).toFixed(6));
  record.intervalNetAud  = parseFloat((record.intervalBuyAud - record.intervalSellAud).toFixed(6));

  // ── Meter delta (actual kWh from meter cumulative totals) ─────────────────
  // More accurate than power * 0.5h estimate — uses real meter readings
  const db = getDb();
  if (db && ess.purchasedTotal != null && ess.feedTotal != null) {
    try {
      const prev = db.prepare(
        "SELECT meter_buy_total, meter_sell_total FROM energy_log WHERE meter_buy_total IS NOT NULL ORDER BY ts DESC LIMIT 1"
      ).get();
      if (prev && prev.meter_buy_total != null) {
        const buyDelta  = ess.purchasedTotal - prev.meter_buy_total;
        const sellDelta = ess.feedTotal      - prev.meter_sell_total;
        // Sanity check: delta should be positive and < 5 kWh (max 10 kW * 0.5h)
        record.meterBuyDelta  = buyDelta  >= 0 && buyDelta  < 5 ? parseFloat(buyDelta.toFixed(4))  : null;
        record.meterSellDelta = sellDelta >= 0 && sellDelta < 5 ? parseFloat(sellDelta.toFixed(4)) : null;
      }
    } catch { /* silent */ }
  }
  appendLog(record);
  const daily = updateDailySummary(record);

  // 7. 电价告警
  if (descriptor === "spike" || currentPrice > 50) {
    console.log(`🚨 电价尖峰！${currentPrice.toFixed(1)} c/kWh`);
  } else if (descriptor === "high" || currentPrice > 30) {
    console.log(`⚠️ 电价偏高：${currentPrice.toFixed(1)} c/kWh`);
  }

  // 8. 打印今日汇总
  const netCost = ((daily.cost_aud || 0) - (daily.earnings_aud || 0));
  console.log(`\n[TODAY] 家用: ${(daily.home_kwh||0).toFixed(2)} kWh  买电: ${(daily.grid_buy_kwh||0).toFixed(2)} kWh  卖电: ${(daily.grid_sell_kwh||0).toFixed(2)} kWh`);
  console.log(`[TODAY] 电费: $${(daily.cost_aud||0).toFixed(3)}  卖电收入: $${(daily.earnings_aud||0).toFixed(3)}  净成本: $${netCost.toFixed(3)}`);
  console.log(`[TODAY] SOC avg/min/max: ${(daily.avg_soc||0).toFixed(0)}% / ${daily.min_soc||0}% / ${daily.max_soc||0}%`);
  if ((daily.demand_peak_kw || 0) > 0) {
    console.log(`[TODAY] ⚠️ demand window 内电网峰值: ${daily.demand_peak_kw.toFixed(2)} kW → 预估需量电费: $${(daily.demand_charge_est||0).toFixed(2)}/day`);
  }

  console.log(`[DONE]`);
}

main().catch(err => { console.error("[FATAL]", err.message); process.exit(1); });
