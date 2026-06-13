#!/usr/bin/env node
/**
 * v2/plan-executor-v3.js — 适配 v3-sell 策略的计划执行器
 *
 * 基于 plan-executor.js，关键改动：
 *   - 支持 v3-sell source 计划（overnightReservePct=35%，无 BUY_MAX_C）
 *   - 向后兼容 v2-rules source 计划（SOC_OVERNIGHT=50%，保留利润检查）
 *   - 卖电判断简化：v3 计划中 action=sell 直接执行，不再算利润
 *   - 记录触发器改为 'executor-v3'
 *
 * 保留所有 v2 功能：
 *   1. 每5分钟跑一次，读 daily_plan is_active=1
 *   2. 动态调充电功率（断路器限制）
 *   3. hardwareTasks（热水器 Tuya MCP）
 *   4. energy_log 记录
 *   5. 卖电动态调功率 + SOC 保护
 *   6. Turso 同步
 */
'use strict';

process.env.TZ = 'Australia/Sydney';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https    = require('https');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const essApi   = require('./ess-api');

// ── 环境变量 ──────────────────────────────────────────────────
const AMBER_TOKEN   = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID;
const ESS_TOKEN     = process.env.ESS_TOKEN;
const ESS_MAC_HEX   = process.env.ESS_MAC_HEX;
const ESS_STATION   = process.env.ESS_STATION_SN;
const GW_PORT       = process.env.OPENCLAW_GATEWAY_PORT || '18789';

if (!AMBER_TOKEN || !AMBER_SITE_ID) { console.error('[ERROR] Missing AMBER_API_TOKEN or AMBER_SITE_ID'); process.exit(1); }
if (!ESS_TOKEN   || !ESS_MAC_HEX)   { console.error('[ERROR] Missing ESS_TOKEN or ESS_MAC_HEX');          process.exit(1); }

// ── 系统常量 ──────────────────────────────────────────────────
const BREAKER_KW      = parseFloat(process.env.MAIN_BREAKER_KW ?? '7.7');
const BREAKER_BUFFER  = 0.3;
const MAX_CHARGE_KW   = 5.0;
const MAX_SELL_KW     = 5.0;
const SOC_FLOOR       = 10;    // % 绝对底线
const DB_PATH         = path.join(__dirname, '..', 'data', 'energy.db');

// v2 兼容默认值
const SOC_OVERNIGHT_V2 = 50;   // v2-rules 过夜保留
// v3 默认值（会从 plan notes 读取覆盖）
const SOC_OVERNIGHT_V3 = 35;   // v3-sell 过夜保留

// ── 工具 ──────────────────────────────────────────────────────
function sydneyTime() {
  const s = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  });
  const [datePart, timePart] = s.split(', ');
  const [dd, mm, yyyy] = datePart.split('/');
  const [hh, mi, ss]   = timePart.split(':').map(Number);
  return { date:`${yyyy}-${mm}-${dd}`, hh, mi, hhmm:`${String(hh).padStart(2,'0')}${String(mi).padStart(2,'0')}` };
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname:u.hostname, path:u.pathname+u.search, method:'GET', headers },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} }); });
    req.on('error', reject); req.end();
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname:u.hostname, path:u.pathname+u.search, method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...headers} },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve({});} }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 发送 WhatsApp 告警 ────────────────────────────────────────
async function sendAlert(message) {
  try {
    const body = JSON.stringify({ message });
    await new Promise(resolve => {
      const req = http.request({
        hostname: 'localhost', port: GW_PORT, path: '/send', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(); });
      req.on('error', () => resolve());
      req.write(body); req.end();
    });
    console.log('[告警] 已发送 WhatsApp:', message.slice(0, 80));
  } catch(e) {
    console.warn('[告警] 发送失败:', e.message);
  }
}

const MAX_ALERTS_PER_DAY = 2;

async function sendAlertOnce(db, key, message) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const storeKey = `alert:${key}:${today}`;
  const row = db.prepare("SELECT value FROM kv_store WHERE key=?").get(storeKey);
  const count = row ? parseInt(row.value) : 0;
  if (count >= MAX_ALERTS_PER_DAY) return;
  db.prepare("INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)").run(storeKey, String(count + 1));
  await sendAlert(message);
}

// ── ESS API ───────────────────────────────────────────────────
const ESS_HEADERS = {
  Authorization: ESS_TOKEN, lang:'en', showloading:'false',
  Referer:'https://eu.ess-link.com/appViews/appHome', 'User-Agent':'Mozilla/5.0',
};

async function essGet(endpoint) {
  try {
    const r = await httpsGet(`https://eu.ess-link.com/api/app/deviceInfo/${endpoint}?macHex=${ESS_MAC_HEX}`, ESS_HEADERS);
    return r.code === 200 ? r.data : null;
  } catch { return null; }
}

async function essWebGet(path) {
  try {
    const r = await httpsGet(`https://eu.ess-link.com${path}`, { Authorization:`Bearer ${ESS_TOKEN}`, lang:'en', showloading:'false', Referer:'https://eu.ess-link.com/appViews/appHome', 'User-Agent':'Mozilla/5.0' });
    return r.code === 200 ? r.data : null;
  } catch { return null; }
}

function findVal(items, index) {
  if (!items) return null;
  const item = Array.isArray(items) ? items.find(i => i.index === index) : null;
  if (!item) return null;
  if (item.value === 0 && item.valueStr && parseFloat(item.valueStr) !== 0) {
    return parseFloat(item.valueStr);
  }
  return item.value ?? null;
}

async function readEss() {
  const [batt, load, meter, pv, runInfo, flowInfo] = await Promise.all([
    essGet('getBatteryInfo'),
    essGet('getLoadInfo'),
    essGet('getMeterInfo'),
    essGet('getPhotovoltaicInfo'),
    essWebGet(`/api/web/deviceInfo/getDevicRunningInfo?stationSn=${ESS_STATION}`),
    essWebGet(`/api/web/station/totalFlowDiagram?stationSn=${ESS_STATION}`),
  ]);

  const soc          = findVal(batt, '0x1212') ?? findVal(batt, '0xB106') ?? null;
  const battPower    = findVal(batt, '0x1210') ?? null;
  const battVoltage  = findVal(batt, '0x120C') ?? null;
  const battCurrent  = findVal(batt, '0x120E') ?? null;
  const homeLoad     = findVal(load, '0x1274') ?? null;
  const gridPower    = findVal(meter,'0xA112') ?? null;
  const pvPower      = findVal(pv,   '0x1270') ?? null;
  const meterBuy     = findVal(meter,'0x1240') ?? null;
  const meterSell    = findVal(meter,'0x1242') ?? null;
  const reportedMode = runInfo?.x300C ?? null;

  const todayChargeKwh    = runInfo?.x126A ?? null;
  const todayDischargeKwh = runInfo?.x126C ?? null;
  const todayPvKwh        = runInfo?.x1264 ?? null;
  const todayGridBuyKwh   = runInfo?.x1266 ?? null;
  const todayGridSellKwh  = runInfo?.x1268 ?? null;
  const todayHomeKwh      = runInfo?.x126E ?? null;

  const flowPv       = flowInfo?.pvPower    ?? null;
  const flowGrid     = flowInfo?.gridPower  ?? null;
  const flowBattery  = flowInfo?.battPower  ?? null;
  const flowLoad     = flowInfo?.loadPower  ?? null;

  return {
    soc, battPower, battVoltage, battCurrent,
    homeLoad, gridPower, pvPower,
    meterBuy, meterSell,
    reportedMode,
    todayChargeKwh, todayDischargeKwh, todayPvKwh,
    todayGridBuyKwh, todayGridSellKwh, todayHomeKwh,
    flowPv, flowGrid, flowBattery, flowLoad,
  };
}

// ── Amber API ─────────────────────────────────────────────────
async function readAmber() {
  try {
    const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=48`;
    const raw = await httpsGet(url, { Authorization:`Bearer ${AMBER_TOKEN}` });
    if (!Array.isArray(raw)) return null;

    let buyPrice = null, feedInPrice = null, spotPrice = null;
    let clPrice = null, clDescriptor = null, clTariffPeriod = null;
    let demandWindow = false, nemTime = null, descriptor = null, tariffPeriod = null;
    let renewables = null, nextDemandMin = null;
    const futureBuyPrices = [];
    const todayDate = new Date(Date.now() + 10*3600*1000).toISOString().slice(0,10);

    for (const p of raw) {
      if (p.type === 'CurrentInterval') {
        nemTime      = p.nemTime;
        renewables   = p.renewables ?? null;
        if (p.channelType === 'general') {
          buyPrice     = p.perKwh;
          spotPrice    = p.spotPerKwh ?? null;
          descriptor   = p.descriptor;
          tariffPeriod = p.tariffInformation?.period ?? null;
          if (p.tariffInformation?.demandWindow) demandWindow = true;
        }
        if (p.channelType === 'feedIn')         feedInPrice = Math.abs(p.perKwh);
        if (p.channelType === 'controlledLoad') {
          clPrice       = p.perKwh;
          clDescriptor  = p.descriptor;
          clTariffPeriod = p.tariffInformation?.period ?? null;
        }
      }
      if ((p.type === 'CurrentInterval' || p.type === 'ForecastInterval') && p.channelType === 'general') {
        const pDate = p.startTime ? new Date(new Date(p.startTime).getTime() + 10*3600*1000).toISOString().slice(0,10) : null;
        if (pDate === todayDate && p.perKwh != null) {
          futureBuyPrices.push(p.perKwh);
        }
      }
      if (p.type === 'ForecastInterval' && p.tariffInformation?.demandWindow && nextDemandMin === null) {
        const diffMs = new Date(p.startTime) - Date.now();
        if (diffMs > 0) nextDemandMin = diffMs / 60000;
      }
    }
    return {
      buyPrice, feedInPrice, spotPrice,
      clPrice, clDescriptor, clTariffPeriod,
      demandWindow, nemTime, descriptor, tariffPeriod,
      renewables, nextDemandMin,
      futureBuyPrices,
    };
  } catch { return null; }
}

// ── 逆变器写操作 ──────────────────────────────────────────────
async function updateChargeKw(kw, reason = 'charge') {
  const ok = await essApi.setChargeKw(kw, reason, 'plan-executor-v3');
  console.log(`[功率] 充电功率 → ${kw}kW ${ok?'✅':'❌'} (${reason})`);
  return ok;
}

async function updateSellKw(kw, reason = 'sell') {
  const ok = await essApi.setSellKw(kw, reason, 'plan-executor-v3');
  console.log(`[功率] 放电功率 → ${kw}kW ${ok?'✅':'❌'} (${reason})`);
  return ok;
}

async function switchToSelfUse(reason = 'self-use') {
  if (global._manualOverrideActive) {
    console.log(`[LOCK] switchToSelfUse blocked (manual override) — reason: ${reason}`);
    return false;
  }
  // 切 Self-use 前先清充放电时间窗口，防止残留 Timed 设置
  await essApi.setParam('0xC0BA', 0, reason, 'plan-executor-v3');
  await essApi.setParam('0xC0BC', 0, reason, 'plan-executor-v3');
  await essApi.setParam('0xC014', 0, reason, 'plan-executor-v3');
  await essApi.setParam('0xC016', 0, reason, 'plan-executor-v3');
  await essApi.setParam('0xC018', 0, reason, 'plan-executor-v3');
  await essApi.setParam('0xC01A', 0, reason, 'plan-executor-v3');
  const ok = await essApi.switchToSelfUse(reason, 'plan-executor-v3');
  console.log(`[模式] 切回 Self-use ${ok?'✅':'❌'} 已清充放电窗口 (${reason})`);
  return ok;
}

async function restoreTimedMode(chargeWindows, reason = 'restore-timed') {
  if (global._manualOverrideActive) {
    console.log(`[LOCK] restoreTimedMode blocked (manual override) — reason: ${reason}`);
    return;
  }
  const w = chargeWindows?.[0];
  const startHHMM = w ? w.startHour * 100 : 900;
  const endHHMM   = w ? (w.endHour - 1) * 100 + 30 : 1430;
  await essApi.restoreTimedMode({ startHHMM, endHHMM, chargeKw: MAX_CHARGE_KW }, reason, 'plan-executor-v3');
  console.log(`[模式] 切回 Timed ✅ 充电窗口: ${String(startHHMM).padStart(4,'0')}–${String(endHHMM).padStart(4,'0')} chargeKw=${MAX_CHARGE_KW} (${reason})`);
}

async function emergencyStop(reason) {
  console.log(`[紧急] 停止充放电: ${reason}`);
  await essApi.emergencyStop(`emergencyStop: ${reason}`, 'plan-executor-v3');
}

const calcSafeChargeKw = essApi.calcSafeChargeKw;

// ── 解析计划策略信息 ──────────────────────────────────────────
function parsePlanStrategy(planRow) {
  const source = planRow?.source ?? 'v2-rules';
  let notes = {};
  try { notes = JSON.parse(planRow?.notes ?? '{}'); } catch {}

  const isV3 = source === 'v3-sell' || source === 'manual' || notes.strategy === 'v3-sell' || notes.strategy === 'manual';

  return {
    isV3,
    source,
    // 过夜保留 SOC：v3=35%, v2=50%
    overnightReservePct: isV3
      ? (notes.overnightReservePct ?? SOC_OVERNIGHT_V3)
      : SOC_OVERNIGHT_V2,
    // 充电目标
    chargeTargetPct: isV3
      ? (notes.chargeTargetPct ?? 80)
      : (notes.gridChargeTarget ?? parseFloat(process.env.CHARGE_TARGET_PCT || '85')),
    // 卖电最低价（v3 不需要利润检查，但保留 plan 里的值作参考）
    sellMinC: isV3
      ? (notes.sellMinC ?? 5.0)
      : (notes.sellMinC ?? 9.9),
    // v2 的买入价上限（v3 不用）
    buyMaxC: isV3 ? Infinity : parseFloat(process.env.BUY_MAX_C || '25'),
    // 原始 notes
    notes,
  };
}

// ── 记录数据到 energy_log ─────────────────────────────────────
function logData(db, ess, amber, slot, action, extra = {}) {
  const now = new Date().toISOString();

  let meterBuyDelta = null, meterSellDelta = null;
  try {
    const prev = db.prepare(
      "SELECT meter_buy_total, meter_sell_total, ts FROM energy_log WHERE meter_buy_total IS NOT NULL ORDER BY ts DESC LIMIT 1"
    ).get();
    if (prev && ess.meterBuy != null) {
      const delta = parseFloat((ess.meterBuy - prev.meter_buy_total).toFixed(4));
      if (delta >= 0 && delta < 2.0) meterBuyDelta = delta;
    }
    if (prev && ess.meterSell != null) {
      const delta = parseFloat((ess.meterSell - prev.meter_sell_total).toFixed(4));
      if (delta >= 0 && delta < 2.0) meterSellDelta = delta;
    }
  } catch {}

  const modeMap = { charge:1, 'charge+hw':1, sell:6, 'self-use':0, standby:0, hotwater:0 };
  const modeNum = slot ? (modeMap[slot.action] ?? 0) : null;
  const modeChanged = (extra.modeFrom != null || extra.modeTo != null) ? 1 : 0;

  try {
    db.prepare(`
      INSERT OR REPLACE INTO energy_log (
        ts, nem_time,
        soc, batt_power, home_load, pv_power, grid_power,
        batt_voltage, batt_current,
        buy_price, feedin_price, spot_price, demand_window,
        renewables, amber_descriptor, amber_tariff_period,
        amber_cl_price, amber_cl_descriptor, amber_cl_tariff_period,
        amber_feedin_price, amber_spot_price,
        next_demand_min,
        mode, mode_changed, mode_reason, mode_from, mode_to,
        meter_buy_total, meter_sell_total,
        meter_buy_delta, meter_sell_delta,
        today_charge_kwh, today_discharge_kwh, today_pv_kwh,
        today_grid_buy_kwh, today_grid_sell_kwh, today_home_kwh,
        flow_pv, flow_grid, flow_battery, flow_load,
        reported_mode, record_trigger,
        charge_kw, discharge_kw,
        solar_wm2, cloud_cover_pct,
        alert
      ) VALUES (
        ?,?,
        ?,?,?,?,?,
        ?,?,
        ?,?,?,?,
        ?,?,?,
        ?,?,?,
        ?,?,
        ?,
        ?,?,?,?,?,
        ?,?,
        ?,?,
        ?,?,?,
        ?,?,?,
        ?,?,?,?,
        ?,?,
        ?,?,
        ?,?,
        ?
      )
    `).run(
      now, amber?.nemTime ?? null,
      ess.soc, ess.battPower, ess.homeLoad, ess.pvPower, ess.gridPower,
      ess.battVoltage ?? null, ess.battCurrent ?? null,
      amber?.buyPrice ?? null, amber?.feedInPrice ?? null, amber?.spotPrice ?? null,
      amber?.demandWindow ? 1 : 0,
      amber?.renewables ?? null, amber?.descriptor ?? null, amber?.tariffPeriod ?? null,
      amber?.clPrice ?? null, amber?.clDescriptor ?? null, amber?.clTariffPeriod ?? null,
      amber?.feedInPrice ?? null, amber?.spotPrice ?? null,
      amber?.nextDemandMin ?? null,
      modeNum, modeChanged, action ?? slot?.action ?? 'unknown',
      extra.modeFrom ?? null, extra.modeTo ?? null,
      ess.meterBuy ?? null, ess.meterSell ?? null,
      meterBuyDelta, meterSellDelta,
      ess.todayChargeKwh ?? null, ess.todayDischargeKwh ?? null, ess.todayPvKwh ?? null,
      ess.todayGridBuyKwh ?? null, ess.todayGridSellKwh ?? null, ess.todayHomeKwh ?? null,
      ess.flowPv ?? null, ess.flowGrid ?? null, ess.flowBattery ?? null, ess.flowLoad ?? null,
      ess.reportedMode ?? null, 'executor-v3',
      extra.chargeKw ?? slot?.chargeKw ?? null,
      extra.sellKw   ?? slot?.sellKw   ?? null,
      null, null,
      extra.alert ?? null,
    );
  } catch(e) {
    console.warn('[DB] 写入失败:', e.message);
  }
}

// ── 热水器控制（自建 Tuya API）────────────────────────────────
const HW_MAIN_ID = 'bf160bbe78f4f1ce6dpkdp';
const HW_GF_ID   = 'bf3c28e8181e5e980eoobm';
const tuya = require('./tuya-api');

async function tuyaControl(deviceId, on) {
  if (process.env.TUYA_DISABLED === '1') {
    console.log(`[tuyaControl] Tuya 已禁用（定时器控制），跳过 ${deviceId} → ${on ? 'ON' : 'OFF'}`);
    return true;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await tuya.switchDevice(deviceId, on);
    } catch (e) {
      console.warn(`[tuyaControl] attempt ${attempt} switch failed: ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    await new Promise(r => setTimeout(r, 3000));
    try {
      const status = await tuya.getDeviceStatus(deviceId);
      const actualSwitch = status['switch'];
      if (actualSwitch === on) {
        console.log(`[tuyaControl] ${deviceId} confirmed ${on ? 'ON' : 'OFF'} (attempt ${attempt})`);
        return true;
      }
      console.warn(`[tuyaControl] attempt ${attempt} state mismatch: expected ${on}, got ${actualSwitch}`);
    } catch (e) {
      console.warn(`[tuyaControl] attempt ${attempt} status check failed: ${e.message}`);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
  }

  console.error(`[tuyaControl] FAILED to confirm ${deviceId} → ${on ? 'ON' : 'OFF'} after 3 attempts`);
  return false;
}

/**
 * 开热水器并设置 Tuya 云定时自动关机（保底）
 * @param {string} deviceId
 * @param {boolean} on
 * @param {number} autoOffMin - 自动关机分钟数（仅 on=true 时有效）
 */
async function tuyaControlWithTimer(deviceId, on, autoOffMin = 120) {
  if (on) {
    try {
      const ok = await tuya.turnOnWithAutoOff(deviceId, autoOffMin);
      if (ok) {
        console.log(`[tuyaControl] ${deviceId} ON + timer auto-OFF in ${autoOffMin}min ✅`);
        return true;
      }
    } catch (e) {
      console.warn(`[tuyaControl] turnOnWithAutoOff failed: ${e.message}, falling back to basic switch`);
      // 降级：至少把开关打开
      return await tuyaControl(deviceId, true);
    }
  } else {
    // 关机时也清除定时任务
    try { await tuya.clearTimers(deviceId); } catch (e) {
      console.warn(`[tuyaControl] clear timers on OFF failed: ${e.message}`);
    }
    return await tuyaControl(deviceId, false);
  }
}

function nowLocal() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Australia/Sydney' }).replace(' ', 'T');
}

function logHwAction(db, deviceId, deviceName, on, opts = {}) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS hw_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, device_id TEXT, device_name TEXT,
      online INTEGER, switch_on INTEGER, duration_min REAL,
      voltage_v REAL, current_a REAL, power_w REAL, total_kwh REAL,
      action TEXT, triggered_by TEXT, source TEXT, plan_window TEXT
    )`);
    ['action','triggered_by','source','plan_window'].forEach(col => {
      try { db.prepare(`ALTER TABLE hw_log ADD COLUMN ${col} TEXT`).run(); } catch {}
    });
    db.prepare(`
      INSERT INTO hw_log (ts, device_id, device_name, switch_on, action, triggered_by, source, plan_window)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowLocal(), deviceId, deviceName,
      on ? 1 : 0, on ? 'on' : 'off',
      opts.triggeredBy ?? 'executor-v3',
      opts.source ?? null, opts.planWindow ?? null,
    );
  } catch(e) { console.warn('[hw_log] 写入失败:', e.message); }
}

async function controlHotWater(on, autoOffMin = 120) {
  if (process.env.TUYA_DISABLED === '1') {
    console.log(`[主热水器] Tuya 已禁用（定时器控制），跳过 ${on ? '开' : '关'} 操作`);
    return true; // 假装成功，不影响后续逻辑
  }
  const ok = on
    ? await tuyaControlWithTimer(HW_MAIN_ID, true, autoOffMin)
    : await tuyaControlWithTimer(HW_MAIN_ID, false);
  console.log(`[主热水器] ${on ? '开' : '关'} ${ok ? '✅' : '❌'}${on ? ` (timer: ${autoOffMin}min)` : ''}`);
  return ok;
}

async function handleHotWaterWindow(planRow, db, syd) {
  const today = syd.date;
  const nowMins = syd.hh * 60 + syd.mi;

  const onKey  = `hw_main:${today}:on`;
  const offKey = `hw_main:${today}:off`;
  const isOn  = !!db.prepare("SELECT 1 FROM kv_store WHERE key=?").get(onKey);
  const isOff = !!db.prepare("SELECT 1 FROM kv_store WHERE key=?").get(offKey);
  const MAX_HW_MINS = 150;

  if (isOn && !isOff) {
    const hwOpenRow = db.prepare("SELECT value FROM kv_store WHERE key=?").get(`hw_main:${today}:open_time`);
    const openMins = hwOpenRow ? parseInt(hwOpenRow.value) : null;
    if (openMins !== null && nowMins - openMins >= MAX_HW_MINS) {
      console.warn(`[主热水器] ⚠️ 已开 ${nowMins - openMins}min，超过最大 ${MAX_HW_MINS}min，强制关闭`);
      const ok = await controlHotWater(false);
      if (ok) {
        logHwAction(db, HW_MAIN_ID, '主热水器', false, { triggeredBy: 'executor-v3-timeout' });
        db.prepare("INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)").run(offKey, '1');
        await sendAlert(`⚠️ 主热水器已超时自动关闭（开了${Math.round((nowMins-openMins)/60*10)/10}h）`);
      }
      return;
    }
  }

  if (!planRow?.notes) return;
  let notes;
  try { notes = JSON.parse(planRow.notes); } catch { return; }
  const tasks = notes?.hardwareTasks?.filter(t => t.device === 'main_hw') ?? [];
  if (tasks.length === 0) return;

  for (const task of tasks) {
    const [th, tm] = task.time.split(':').map(Number);
    const taskMins = th * 60 + tm;

    if (nowMins >= taskMins && nowMins < taskMins + 30) {
      const isOnTask = task.action === 'on';
      const key = isOnTask ? onKey : offKey;
      if (!db.prepare("SELECT 1 FROM kv_store WHERE key=?").get(key)) {
        // 开机时计算运行时长（从 on task 到 off task 的分钟数）
        let autoOffMin = 120; // 默认 2h
        if (isOnTask) {
          const offTask = tasks.find(t => t.action === 'off');
          if (offTask) {
            const [oh, om] = offTask.time.split(':').map(Number);
            autoOffMin = (oh * 60 + om) - taskMins;
            if (autoOffMin <= 0) autoOffMin = 120;
          }
        }
        const ok = await controlHotWater(isOnTask, autoOffMin);
        if (ok) {
          logHwAction(db, HW_MAIN_ID, '主热水器', isOnTask, { triggeredBy: 'executor-v3', planWindow: task.time });
          db.prepare("INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)").run(key, '1');
          if (isOnTask) {
            db.prepare("INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)").run(`hw_main:${today}:open_time`, String(nowMins));
          }
          await sendAlert(`${isOnTask ? '🚿' : '🔴'} 主热水器已${isOnTask ? '开' : '关'}（${task.time}，plan-today 计划）`);
        }
      }
    }
  }
}

async function handleGfHotWater(db, syd) {
  const nowMins = syd.hh * 60 + syd.mi;
  const today = syd.date;
  const MAX_GF_MINS = 150;

  const gfOpenRow = db.prepare("SELECT value FROM kv_store WHERE key=?").get(`hw_gf:${today}:open_time`);
  const gfOffDone = !!db.prepare("SELECT 1 FROM kv_store WHERE key LIKE ? AND key LIKE '%off%'")
    .get(`hw_gf:${today}:%`);
  if (gfOpenRow && !gfOffDone) {
    const openMins = parseInt(gfOpenRow.value);
    if (nowMins - openMins >= MAX_GF_MINS) {
      console.warn(`[GF热水器] ⚠️ 已开 ${nowMins - openMins}min，超过最大 ${MAX_GF_MINS}min，强制关闭`);
      const ok = await tuyaControl(HW_GF_ID, false);
      if (ok) {
        logHwAction(db, HW_GF_ID, 'GF热水器', false, { triggeredBy: 'executor-v3-timeout' });
        await sendAlert(`⚠️ GF热水器已超时自动关闭（开了${Math.round((nowMins-openMins)/60*10)/10}h）`);
      } else {
        await sendAlert(`🚨 GF热水器超时关闭失败！已开 ${nowMins - openMins}min，请手动关闭！`);
      }
    }
  }

  // 状态回查
  const lastOffTask = db.prepare(
    "SELECT value FROM kv_store WHERE key LIKE ? AND key LIKE '%:off'"
  ).get(`hw_gf:${today}:%`);
  if (lastOffTask) {
    try {
      const status = await tuya.getDeviceStatus(HW_GF_ID);
      if (status['switch'] === true) {
        console.warn(`[GF热水器] ⚠️ 状态回查：应该关但实际还开着！重新关闭...`);
        const ok = await tuyaControl(HW_GF_ID, false);
        if (ok) {
          console.log(`[GF热水器] 状态回查关闭成功 ✅`);
          await sendAlert(`⚠️ GF热水器状态回查：发现未关，已重新关闭`);
        } else {
          console.error(`[GF热水器] 状态回查关闭失败 ❌`);
          await sendAlert(`🚨 GF热水器状态回查关闭失败！请手动关闭！`);
        }
      }
    } catch (e) {
      console.warn(`[GF热水器] 状态回查异常: ${e.message}`);
    }
  }

  const planRow = db.prepare("SELECT notes FROM daily_plan WHERE date=? AND is_active=1 ORDER BY rowid DESC LIMIT 1").get(today);
  if (!planRow?.notes) return;

  let notes;
  try { notes = JSON.parse(planRow.notes); } catch { return; }
  const tasks = notes?.hardwareTasks?.filter(t => t.device === 'gf_hw') ?? [];
  if (tasks.length === 0) return;

  for (const task of tasks) {
    const [th, tm] = task.time.split(':').map(Number);
    const taskMins = th * 60 + tm;

    if (nowMins >= taskMins && nowMins < taskMins + 30) {
      const isOn = task.action === 'on';
      const key = `hw_gf:${today}:${task.time}:${task.action}`;
      if (!db.prepare("SELECT 1 FROM kv_store WHERE key=?").get(key)) {
        // GF 热水器也加 timer 保底
        let ok;
        if (isOn) {
          const offTask = tasks.find(t => t.action === 'off');
          let autoOffMin = 120;
          if (offTask) {
            const [oh, om] = offTask.time.split(':').map(Number);
            autoOffMin = (oh * 60 + om) - taskMins;
            if (autoOffMin <= 0) autoOffMin = 120;
          }
          try {
            ok = await tuya.turnOnWithAutoOff(HW_GF_ID, autoOffMin);
          } catch (e) {
            console.warn(`[GF热水器] turnOnWithAutoOff failed: ${e.message}, fallback`);
            ok = await tuyaControl(HW_GF_ID, true);
          }
        } else {
          try { await tuya.clearTimers(HW_GF_ID); } catch (e) { console.warn(`[GF热水器] clear timers: ${e.message}`); }
          ok = await tuyaControl(HW_GF_ID, false);
        }
        console.log(`[GF热水器] ${isOn ? '开' : '关'} ${task.time} ${ok ? '✅' : '❌'}`);
        if (ok) {
          logHwAction(db, HW_GF_ID, 'GF热水器', isOn, { triggeredBy: 'executor-v3', planWindow: task.time });
          db.prepare("INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)").run(key, '1');
          if (isOn) {
            db.prepare("INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)").run(`hw_gf:${today}:open_time`, String(nowMins));
          }
          await sendAlert(`${isOn ? '🛁' : '🔴'} GF热水器已${isOn ? '开' : '关'}（${task.time}，plan-today 计划）`);
        } else if (!isOn) {
          await sendAlert(`🚨 GF热水器关闭失败（${task.time}），将在下次重试`);
        }
      }
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  // Manual override check from DB (no lock file needed)

  const syd = sydneyTime();
  const now = new Date();
  console.log(`\n[${syd.date} ${syd.hh}:${String(syd.mi).padStart(2,'0')}] === plan-executor v3 ===`);

  const db = new Database(DB_PATH);
  essApi.init({ db, mac: ESS_MAC_HEX, token: ESS_TOKEN });

  db.exec("CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)");

  // 1. 读今日计划
  const planRow = db.prepare(
    "SELECT * FROM daily_plan WHERE date=? AND is_active=1 ORDER BY rowid DESC LIMIT 1"
  ).get(syd.date);

  if (!planRow) {
    console.log('[计划] 今天没有计划，仅记录数据');
  }

  // Check manual override from DB
  if (planRow?.manual_override_until) {
    const overrideUntil = new Date(planRow.manual_override_until);
    if (overrideUntil > new Date()) {
      global._manualOverrideActive = true;
      console.log(`[LOCK] Manual override active until ${planRow.manual_override_until} — skipping mode changes`);
    } else {
      // Override just expired — trigger replan
      console.log(`[LOCK] Manual override expired, triggering replan...`);
      db.prepare('UPDATE daily_plan SET manual_override_until=NULL WHERE id=?').run(planRow.id);
      try {
        const { execSync } = require('child_process');
        execSync('node v2/plan-today-v3.js', { cwd: path.join(__dirname, '..'), timeout: 60000, stdio: 'pipe' });
        console.log(`[LOCK] Replan completed ✅`);
      } catch (e) {
        console.log(`[LOCK] Replan failed: ${e.message}`);
      }
      db.close();
      return; // Let next cron cycle pick up the new plan
    }
  }

  // 解析策略（v3 vs v2 兼容）
  const strategy = parsePlanStrategy(planRow);
  console.log(`[策略] source=${strategy.source} isV3=${strategy.isV3} overnight=${strategy.overnightReservePct}% chargeTarget=${strategy.chargeTargetPct}%`);

  const intervals = planRow ? JSON.parse(planRow.intervals_json) : [];

  // 找当前半小时时段
  const nowMins = syd.hh * 60 + syd.mi;
  const slot = intervals.find(s => {
    const k = s.key || '';
    const h = parseInt(k.substring(0,2) || s.nemTime?.substring(11,13) || '0');
    const m = parseInt(k.substring(3,5) || s.nemTime?.substring(14,16) || '0');
    return nowMins >= h*60+m && nowMins < h*60+m+30;
  });

  console.log(`[时段] ${slot ? `${slot.key} action=${slot.action} chargeKw=${slot.chargeKw} sellKw=${slot.sellKw}` : '无匹配时段'}`);

  // 2. 并行读取 ESS + Amber
  const [ess, amber] = await Promise.all([ readEss(), readAmber() ]);

  console.log(`[ESS] SOC:${ess.soc}% batt:${ess.battPower}kW home:${ess.homeLoad}kW pv:${ess.pvPower}kW grid:${ess.gridPower}kW mode:${ess.reportedMode}`);

  if (ess.soc === null) {
    await sendAlertOnce(db, 'ess-offline', '⚠️ ESS 逆变器数据获取失败（SOC=null），可能 token 过期，请检查！');
  }
  if (amber) {
    console.log(`[Amber] buy:${amber.buyPrice?.toFixed(2)}¢ feedIn:${amber.feedInPrice?.toFixed(2)}¢ DW:${amber.demandWindow} ${amber.descriptor??''}`);
  } else {
    console.log('[Amber] API blip — 继续按计划执行');
    await sendAlertOnce(db, 'amber-offline', '⚠️ Amber API 连续获取失败，请检查网络或 API token！');
  }

  // 3. DW 检查
  const isDW = amber?.demandWindow ?? false;
  const slotIsDW = slot?.dw ?? false;
  if (isDW && !slotIsDW) {
    console.warn(`[告警] 实时 DW=true 但计划未标注 DW`);
  }

  // 4. 安全检查：总功率超断路器
  const homeLoad   = ess.homeLoad  ?? 0;
  const pvPower    = ess.pvPower   ?? 0;
  const gridImport = Math.abs(Math.min(ess.gridPower ?? 0, 0)); // 负值=买入，取绝对值
  let extraChargeKw = null, extraSellKw = null;

  if (gridImport > BREAKER_KW - BREAKER_BUFFER) {
    const safeKw = calcSafeChargeKw(homeLoad, pvPower, ess.gridPower, ess.battPower);
    console.log(`[安全] 电网进口 ${gridImport.toFixed(2)}kW 超断路器上限，降充电至 ${safeKw}kW`);
    await updateChargeKw(safeKw, `breaker-throttle: gridImport=${gridImport.toFixed(2)}kW home=${homeLoad.toFixed(2)}kW`);
    extraChargeKw = safeKw;
    logData(db, ess, amber, slot, 'throttled', { chargeKw: safeKw });
    db.close();
    return;
  }

  // 5. 执行计划
  let action = 'monitor';
  const overnightReserve = strategy.overnightReservePct;
  const chargeTargetPct  = strategy.chargeTargetPct;

  if (!slot) {
    action = 'no-slot';

  } else if (slot.action === 'charge' || slot.action === 'charge+hw') {
    const realBuyPrice = amber?.buyPrice ?? null;

    // SOC 达标检查：到目标后的处理
    // 关键：热水器时段（homeLoad>3kW）绝不能切 Self-use，否则电池会放电供热水器
    if (ess.soc !== null && ess.soc >= chargeTargetPct) {
      const hwRunning = ess.homeLoad != null && ess.homeLoad > 3; // 热水器大概率在跑
      const cheapEnough = realBuyPrice != null && realBuyPrice < 10; // <10¢ 算便宜

      if (hwRunning || cheapEnough) {
        // 热水器运行中 或 电价便宜：保持 Timed 模式，低功率充电（0.1kW），让电网供热水器/家用
        const maintainKw = 0.1;
        console.log(`[充电] SOC ${ess.soc}% >= 目标 ${chargeTargetPct}%，${hwRunning ? '热水器运行中' : '电价便宜'}，维持 Timed 充电 ${maintainKw}kW（电网供家用）`);
        await essApi.setChargeKw(maintainKw, `maintain-charge: ${hwRunning ? 'hw-running' : 'cheap'}`, 'plan-executor-v3');
        logData(db, ess, amber, slot, 'charge-maintain', { soc: ess.soc, target: chargeTargetPct, chargeKw: maintainKw, buyPrice: realBuyPrice, hwRunning });
        action = 'charge-maintain';
      } else {
        console.log(`[充电] SOC ${ess.soc}% >= 目标 ${chargeTargetPct}%，电价 ${realBuyPrice?.toFixed(1) ?? '?'}¢ 不便宜，停止充电`);
        await switchToSelfUse(`charge-done: SOC ${ess.soc}% >= target ${chargeTargetPct}%`);
        logData(db, ess, amber, slot, 'charge-complete', { soc: ess.soc, target: chargeTargetPct });
        action = 'charge-complete';
      }
    } else if (!strategy.isV3 && realBuyPrice != null && realBuyPrice > strategy.buyMaxC) {
      // v2 兼容：极端高价 abort
      console.log(`[充电] v2模式 实际电价 ${realBuyPrice.toFixed(1)}¢ > ${strategy.buyMaxC}¢，暂停充电`);
      await switchToSelfUse(`charge-skip: realBuy=${realBuyPrice.toFixed(1)}c > buyMax=${strategy.buyMaxC}c`);
      logData(db, ess, amber, slot, 'charge-skip-price', { buyPrice: realBuyPrice });
      action = 'charge-skip';
    } else if (strategy.isV3 && realBuyPrice != null && realBuyPrice > 50) {
      // v3：只在极端高价（>50¢）才 abort，因为 v3 不设硬性价格上限
      // 50¢ 是安全阀，正常不应触发（plan-today 已选了便宜时段）
      console.log(`[充电] v3模式 电价 ${realBuyPrice.toFixed(1)}¢ 极端高价（>50¢），暂停充电`);
      await switchToSelfUse(`charge-skip: realBuy=${realBuyPrice.toFixed(1)}c extreme`);
      logData(db, ess, amber, slot, 'charge-skip-price', { buyPrice: realBuyPrice });
      action = 'charge-skip';
    } else {
      // 正常充电 — 设完整充电时间窗口
      const chargeSlots = intervals.filter(s => s.action === 'charge' || s.action === 'charge+hw');
      const lastCharge = chargeSlots[chargeSlots.length - 1];
      const lastChargeKey = lastCharge?.key || lastCharge?.nemTime?.substring(11,16) || '';
      const lastChargeH = parseInt(lastChargeKey.substring(0,2) || '15');
      const lastChargeM = parseInt(lastChargeKey.substring(3,5) || '0');
      // +30分钟，正确处理分钟进位（如 12:30 + 30min = 13:00 = 1300，不是 1260）
      const endMin = lastChargeM + 30;
      const chargeEndHHMM = Math.min((lastChargeH + Math.floor(endMin / 60)) * 100 + (endMin % 60), 2359);

      const chargeWindows = planRow ? JSON.parse(planRow.charge_windows_json || '[]') : [];
      const w = chargeWindows?.[0];
      const chargeStartHHMM = w ? w.startHour * 100 : 800;

      if (ess.reportedMode !== 1) {
        // 不在 Timed 模式，需要切换并设时间窗口
        console.log(`[模式] charge时段但mode=${ess.reportedMode}，切回 Timed`);
        await essApi.restoreTimedMode({
          startHHMM: chargeStartHHMM,
          endHHMM: chargeEndHHMM,
          chargeKw: MAX_CHARGE_KW,
          sellKw: 0,
          sellStartHHMM: 0,
          sellEndHHMM: 0
        }, `charge-timed: window ${String(chargeStartHHMM).padStart(4,'0')}-${String(chargeEndHHMM).padStart(4,'0')}`, 'plan-executor-v3');
        logData(db, ess, amber, slot, 'mode-switch-timed', { modeFrom: ess.reportedMode, modeTo: 1 });
      }
      const safeChargeKw = calcSafeChargeKw(homeLoad, pvPower, ess.gridPower, ess.battPower);
      const targetKw = safeChargeKw;
      if (targetKw < MAX_CHARGE_KW - 0.2) {
        console.log(`[功率] homeLoad=${homeLoad.toFixed(2)}kW，充电 ${targetKw}kW（断路器上限）`);
      }
      await updateChargeKw(targetKw, `charge-slot: home=${homeLoad.toFixed(2)}kW safe=${safeChargeKw}kW`);
      action = 'charge';
    }

  } else if (slot.action === 'sell') {
    // 卖电时段
    if (ess.soc !== null && ess.soc <= overnightReserve) {
      // SOC 触底过夜保留线
      await switchToSelfUse('self-use-slot');
      await essApi.setParam('0xC0BC', 0, 'clear-sell', 'plan-executor-v3');
      await essApi.setParam('0xC018', 0, 'clear-sell', 'plan-executor-v3');
      await essApi.setParam('0xC01A', 0, 'clear-sell', 'plan-executor-v3');
      extraSellKw = 0;
      console.log(`[卖电] SOC=${ess.soc}% ≤ ${overnightReserve}%，停止卖电，清卖电窗口`);
      action = 'sell-soc-floor';
      logData(db, ess, amber, slot, 'mode-switch-selfuse', { modeFrom: ess.reportedMode, modeTo: 0, sellKw: 0 });
    } else if (strategy.isV3) {
      // ── v3 卖电逻辑：实时检查 feedIn vs 当前买价 ──
      const feedIn = amber?.feedInPrice ?? null;
      const buyPrice = amber?.buyPrice ?? null;
      
      // 只有 feedIn 极低（< 5¢）才 abort 卖电；feedIn < buyPrice 是正常的（网费差），不能用来阻止卖电
      const SELL_FLOOR_C = 5;
      if (feedIn !== null && feedIn < SELL_FLOOR_C) {
        console.log(`[卖电] ❌ feedIn=${feedIn.toFixed(1)}¢ < ${SELL_FLOOR_C}¢ 地板价，不卖`);
        await switchToSelfUse('sell-abort: feedIn below floor');
        action = 'sell-abort-low-feedin';
      } else {
      // 找最后一个 sell 槽的结束时间，设放电时间窗口
      const sellSlots = intervals.filter(s => s.action === 'sell');
      const lastSell = sellSlots[sellSlots.length - 1];
      const lastSellKey = lastSell?.key || lastSell?.nemTime?.substring(11,16) || '';
      const lastSellH = parseInt(lastSellKey.substring(0,2) || '23');
      const lastSellM = parseInt(lastSellKey.substring(3,5) || '30');
      // 半小时后结束，正确处理分钟溢出（如 20:30 + 30min = 21:00，不是 20:60）
      const endTotalMin = lastSellH * 60 + lastSellM + 30;
      const sellEndHHMM = Math.floor(endTotalMin / 60) * 100 + (endTotalMin % 60);

      const curKey = slot.key || slot.nemTime?.substring(11,16) || '';
      const curH = parseInt(curKey.substring(0,2) || '0');
      const curM = parseInt(curKey.substring(3,5) || '0');
      const sellStartHHMM = curH * 100 + curM;

      // 确保逆变器在 Timed 模式，同时设好放电时间窗口
      await essApi.restoreTimedMode({
        chargeKw: 0,
        sellStartHHMM,
        sellEndHHMM: Math.min(sellEndHHMM, 2359),
        sellKw: null  // sellKw 单独设
      }, 'sell-timed-v3', 'plan-executor-v3');
      if (ess.reportedMode !== 1) {
        console.log(`[卖电] 模式 ${ess.reportedMode} → Timed(1)，放电窗口 ${String(sellStartHHMM).padStart(4,'0')}–${String(Math.min(sellEndHHMM,2359)).padStart(4,'0')}`);
      }
      const plannedSellKw = slot.sellKw > 0 ? slot.sellKw : MAX_SELL_KW;
      const actualSellKw = parseFloat(Math.max(0.5, Math.min(MAX_SELL_KW, plannedSellKw)).toFixed(2));
      await updateSellKw(actualSellKw, `sell-slot-v3: feedIn=${amber?.feedInPrice?.toFixed(1) ?? '?'}c`);
      extraSellKw = actualSellKw;
      console.log(`[卖电] v3模式 feedIn=${feedIn?.toFixed(1) ?? '?'}¢，卖电 ${actualSellKw}kW，窗口到 ${String(Math.min(sellEndHHMM,2359)).padStart(4,'0')}`);
      action = 'sell';
      } // end feedIn check
    } else {
      // ── v2 兼容卖电逻辑：检查最低卖电价 ──
      if (amber && amber.feedInPrice != null) {
        if (amber.feedInPrice >= strategy.sellMinC) {
          if (ess.reportedMode !== 1) {
            await essApi.setParam('0x300C', 1, 'sell-restore-timed', 'plan-executor-v3');
            console.log(`[卖电] 模式 ${ess.reportedMode} → Timed(1)`);
          }
          const plannedSellKw = slot.sellKw > 0 ? slot.sellKw : MAX_SELL_KW;
          const actualSellKw = parseFloat(Math.max(0.5, Math.min(MAX_SELL_KW, plannedSellKw)).toFixed(2));
          await updateSellKw(actualSellKw, `sell-slot: feedIn=${amber.feedInPrice.toFixed(1)}c`);
          extraSellKw = actualSellKw;
          console.log(`[卖电] v2模式 feedIn=${amber.feedInPrice.toFixed(1)}¢ ≥ ${strategy.sellMinC}¢，卖电 ${actualSellKw}kW`);
          action = 'sell';
        } else {
          await updateSellKw(0, `sell-skip: feedIn-too-low`);
          await switchToSelfUse('sell-skip-self-use');
          extraSellKw = 0;
          console.log(`[卖电] v2模式 feedIn=${amber.feedInPrice.toFixed(1)}¢ < ${strategy.sellMinC}¢，停止卖电`);
          action = 'sell-skip';
        }
      } else {
        // Amber blip
        if (ess.soc !== null && ess.soc <= overnightReserve) {
          await switchToSelfUse('self-use-slot');
          await essApi.setParam('0xC0BC', 0, 'clear-sell', 'plan-executor-v3');
          await essApi.setParam('0xC018', 0, 'clear-sell', 'plan-executor-v3');
          await essApi.setParam('0xC01A', 0, 'clear-sell', 'plan-executor-v3');
          extraSellKw = 0;
          console.log(`[卖电] Amber blip 但 SOC=${ess.soc}% ≤ ${overnightReserve}%，强制停止卖电`);
          action = 'sell-soc-floor';
          logData(db, ess, amber, slot, 'mode-switch-selfuse', { modeFrom: ess.reportedMode, modeTo: 0, sellKw: 0 });
        } else {
          console.log('[卖电] Amber blip，维持当前逆变器窗口');
          action = 'sell-blip';
        }
      }
    }

  } else if (slot.action === 'hotwater') {
    await controlHotWater(true);
    action = 'hotwater';

  } else if (slot.action === 'standby' || slot.action === 'self-use') {
    // self-use/standby 时段：电池放电供家用（包括热水器）是正确行为，不干预
    if (ess.reportedMode === 1) {
    } else if (ess.reportedMode === 1) {
      const hasFutureSell = intervals.some(s => {
        if (s.action !== 'sell') return false;
        const h = parseInt(s.nemTime?.substring(11,13) ?? s.key?.substring(0,2) ?? '0');
        const m = parseInt(s.nemTime?.substring(14,16) ?? s.key?.substring(3,5) ?? '0');
        return h*60+m > nowMins;
      });
      if (hasFutureSell) {
        console.log(`[模式] self-use 时段但后续有 sell 窗口，保留 Timed 模式`);
      } else {
        await switchToSelfUse('self-use-slot');
        logData(db, ess, amber, slot, 'mode-switch-selfuse', { modeFrom: 1, modeTo: 0 });
      }
    }
    action = action || slot.action;
  }

  // 6. SOC 低电量记录
  if (ess.soc !== null && ess.soc <= SOC_FLOOR) {
    console.log(`[SOC] ${ess.soc}% 接近底线 ${SOC_FLOOR}%，逆变器固件会自动保护`);
    action = action === 'monitor' ? 'soc-low' : action;
  }

  // 7. 记录数据
  logData(db, ess, amber, slot, action, {
    chargeKw: extraChargeKw,
    sellKw:   extraSellKw,
    alert:    (isDW && !slotIsDW) ? 'unexpected-DW' : null,
  });

  // 7b. cost_log
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS cost_log (
      ts TEXT PRIMARY KEY,
      buy_kwh REAL, buy_price_c REAL, buy_cost_c REAL,
      sell_kwh REAL, sell_price_c REAL, sell_revenue_c REAL,
      cl_price_c REAL
    )`);
    const lastLog = db.prepare(
      "SELECT meter_buy_delta, meter_sell_delta FROM energy_log ORDER BY ts DESC LIMIT 1"
    ).get();
    if (lastLog && amber) {
      const buyCost = (lastLog.meter_buy_delta ?? 0) * (amber.buyPrice ?? 0);
      const sellRev = (lastLog.meter_sell_delta ?? 0) * (amber.feedInPrice ?? 0);
      db.prepare(`INSERT OR REPLACE INTO cost_log (ts, buy_kwh, buy_price_c, buy_cost_c, sell_kwh, sell_price_c, sell_revenue_c, cl_price_c)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        new Date().toISOString(),
        lastLog.meter_buy_delta ?? 0, amber.buyPrice ?? 0, parseFloat(buyCost.toFixed(4)),
        lastLog.meter_sell_delta ?? 0, amber.feedInPrice ?? 0, parseFloat(sellRev.toFixed(4)),
        amber.clPrice ?? null
      );
    }
  } catch(e) { console.warn('[cost_log] 写入失败:', e.message); }

  // 7c. daily_summary upsert
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS daily_summary (
      date TEXT PRIMARY KEY,
      intervals INTEGER DEFAULT 0,
      home_kwh REAL DEFAULT 0,
      grid_buy_kwh REAL DEFAULT 0,
      grid_sell_kwh REAL DEFAULT 0,
      cost_aud REAL DEFAULT 0,
      earnings_aud REAL DEFAULT 0,
      demand_peak_kw REAL DEFAULT 0,
      demand_charge_est REAL DEFAULT 0,
      avg_soc REAL DEFAULT 0,
      min_soc REAL DEFAULT 100,
      max_soc REAL DEFAULT 0,
      meter_buy_start REAL,
      meter_buy_end REAL,
      meter_sell_start REAL,
      meter_sell_end REAL,
      pv_kwh REAL DEFAULT 0,
      charge_grid_kwh REAL DEFAULT 0,
      discharge_kwh REAL DEFAULT 0,
      mode_changes INTEGER DEFAULT 0,
      sell_sessions INTEGER DEFAULT 0,
      charge_sessions INTEGER DEFAULT 0
    )`);
    const today = `${syd.y}-${String(syd.mo).padStart(2,'0')}-${String(syd.d).padStart(2,'0')}`;
    const meterBuyDelta  = ess.meterBuy != null ? (() => {
      try {
        const prev = db.prepare("SELECT meter_buy_total FROM energy_log WHERE meter_buy_total IS NOT NULL ORDER BY ts DESC LIMIT 1 OFFSET 1").get();
        if (prev) { const d = parseFloat((ess.meterBuy - prev.meter_buy_total).toFixed(4)); return (d >= 0 && d < 2) ? d : 0; }
      } catch {} return 0;
    })() : 0;
    const meterSellDelta = ess.meterSell != null ? (() => {
      try {
        const prev = db.prepare("SELECT meter_sell_total FROM energy_log WHERE meter_sell_total IS NOT NULL ORDER BY ts DESC LIMIT 1 OFFSET 1").get();
        if (prev) { const d = parseFloat((ess.meterSell - prev.meter_sell_total).toFixed(4)); return (d >= 0 && d < 2) ? d : 0; }
      } catch {} return 0;
    })() : 0;
    const intervalCostAud = meterBuyDelta * (amber?.buyPrice ?? 0) / 100;
    const intervalEarnAud = meterSellDelta * (amber?.feedInPrice ?? 0) / 100;
    const modeChanged = (action.includes('mode-switch') || action.includes('switch')) ? 1 : 0;
    const isSelling = (action === 'sell' || (slot && slot.action === 'sell')) ? 1 : 0;
    const isCharging = (action.includes('charge') || (slot && String(slot.action).includes('charge'))) ? 1 : 0;
    const demandPeak = (amber?.demandWindow && ess.gridPower < 0) ? Math.abs(ess.gridPower) : 0;

    db.prepare(`
      INSERT INTO daily_summary (date, intervals, home_kwh, grid_buy_kwh, grid_sell_kwh,
        cost_aud, earnings_aud, demand_peak_kw, demand_charge_est,
        avg_soc, min_soc, max_soc,
        meter_buy_start, meter_buy_end, meter_sell_start, meter_sell_end,
        pv_kwh, charge_grid_kwh, discharge_kwh,
        mode_changes, sell_sessions, charge_sessions)
      VALUES (@date, 1, @homeKwh, @buyKwh, @sellKwh,
        @cost, @earn, @peak, @peakCharge,
        @soc, @soc, @soc,
        @meterBuy, @meterBuy, @meterSell, @meterSell,
        @pvKwh, @chargeKwh, @dischargeKwh,
        @modeChg, @sellSess, @chargeSess)
      ON CONFLICT(date) DO UPDATE SET
        intervals        = intervals + 1,
        home_kwh         = COALESCE(@homeKwh, home_kwh),
        grid_buy_kwh     = CASE WHEN @meterBuy IS NOT NULL AND meter_buy_start IS NOT NULL
                           THEN ROUND(@meterBuy - meter_buy_start, 3) ELSE grid_buy_kwh END,
        grid_sell_kwh    = CASE WHEN @meterSell IS NOT NULL AND meter_sell_start IS NOT NULL
                           THEN ROUND(@meterSell - meter_sell_start, 3) ELSE grid_sell_kwh END,
        cost_aud         = cost_aud + @cost,
        earnings_aud     = earnings_aud + @earn,
        demand_peak_kw   = MAX(demand_peak_kw, @peak),
        demand_charge_est = MAX(demand_peak_kw, @peak) * 0.6104,
        avg_soc          = (avg_soc * intervals + @soc) / (intervals + 1),
        min_soc          = MIN(min_soc, @soc),
        max_soc          = MAX(max_soc, @soc),
        meter_buy_end    = COALESCE(@meterBuy, meter_buy_end),
        meter_sell_end   = COALESCE(@meterSell, meter_sell_end),
        meter_buy_start  = COALESCE(meter_buy_start, @meterBuy),
        meter_sell_start = COALESCE(meter_sell_start, @meterSell),
        pv_kwh           = COALESCE(@pvKwh, pv_kwh),
        charge_grid_kwh  = COALESCE(@chargeKwh, charge_grid_kwh),
        discharge_kwh    = COALESCE(@dischargeKwh, discharge_kwh),
        mode_changes     = mode_changes + @modeChg,
        sell_sessions    = sell_sessions + @sellSess,
        charge_sessions  = charge_sessions + @chargeSess
    `).run({
      date: today,
      homeKwh:       ess.todayHomeKwh ?? null,
      buyKwh:        meterBuyDelta,
      sellKwh:       meterSellDelta,
      cost:          intervalCostAud,
      earn:          intervalEarnAud,
      peak:          demandPeak,
      peakCharge:    demandPeak * 0.6104,
      soc:           ess.soc ?? 0,
      meterBuy:      ess.meterBuy ?? null,
      meterSell:     ess.meterSell ?? null,
      pvKwh:         ess.todayPvKwh ?? null,
      chargeKwh:     ess.todayChargeKwh ?? null,
      dischargeKwh:  ess.todayDischargeKwh ?? null,
      modeChg:       modeChanged,
      sellSess:      isSelling,
      chargeSess:    isCharging,
    });
  } catch(e) { console.warn('[daily_summary] 写入失败:', e.message); }

  // 8. 热水器
  await handleHotWaterWindow(planRow, db, syd);
  await handleGfHotWater(db, syd);

  // 9. 每小时整点打印今日汇总
  if (syd.mi === 0) {
    console.log(`[今日] 买电:${ess.todayGridBuyKwh?.toFixed(2)}kWh 卖电:${ess.todayGridSellKwh?.toFixed(2)}kWh PV:${ess.todayPvKwh?.toFixed(2)}kWh 充电:${ess.todayChargeKwh?.toFixed(2)}kWh 放电:${ess.todayDischargeKwh?.toFixed(2)}kWh`);
  }

  db.close();

  // Turso 同步
  try {
    const { execSync } = require('child_process');
    execSync('node scripts/turso-sync.js', {
      cwd: require('path').join(__dirname, '..'),
      timeout: 30000,
      stdio: 'ignore',
    });
  } catch(e) {
    console.warn('[turso-sync] 同步失败:', e.message);
  }

  console.log(`[完成] action=${action} strategy=${strategy.source} overnight=${overnightReserve}%`);
}

main().catch(async e => {
  console.error('[ERROR]', e.message, e.stack?.split('\n')[1]);
  await sendAlert(`⚠️ plan-executor-v3 崩溃: ${e.message}`);
  process.exit(1);
});
