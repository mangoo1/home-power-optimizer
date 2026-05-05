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
  const ok = await essApi.switchToSelfUse(reason, 'plan-executor-v3');
  console.log(`[模式] 切回 Self-use ${ok?'✅':'❌'} (${reason})`);
  return ok;
}

async function restoreTimedMode(chargeWindows, reason = 'restore-timed') {
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

  const isV3 = source === 'v3-sell' || notes.strategy === 'v3-sell';

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

// ── 热水器控制（Tuya MCP）────────────────────────────────────
const HW_MAIN_ID = 'bf160bbe78f4f1ce6dpkdp';
const HW_GF_ID   = 'bf3c28e8181e5e980eoobm';
const HW_TUYA_CWD = '/home/deven/.openclaw/workspace';

async function tuyaControl(deviceId, on) {
  const cmd = on ? 'tuya_turn_on_device' : 'tuya_turn_off_device';
  const { execSync } = require('child_process');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = execSync(
        `npx mcporter call tuya ${cmd} ${deviceId} switch`,
        { cwd: HW_TUYA_CWD, timeout: 15000, encoding: 'utf8' }
      );
      const r = JSON.parse(result);
      if (!r.success) { console.warn(`[tuyaControl] attempt ${attempt} API returned success=false`); continue; }
    } catch (e) {
      console.warn(`[tuyaControl] attempt ${attempt} command failed: ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    await new Promise(r => setTimeout(r, 3000));
    try {
      const statusRaw = execSync(
        `npx mcporter call tuya tuya_get_device_status ${deviceId}`,
        { cwd: HW_TUYA_CWD, timeout: 15000, encoding: 'utf8' }
      );
      const s = JSON.parse(statusRaw);
      const actualSwitch = s?.data?.switch;
      if (actualSwitch === on) {
        console.log(`[tuyaControl] ${deviceId} confirmed ${on ? 'ON' : 'OFF'} (attempt ${attempt})`);
        return true;
      }
      console.warn(`[tuyaControl] attempt ${attempt} state mismatch: expected ${on}, got ${actualSwitch} — retrying...`);
    } catch (e) {
      console.warn(`[tuyaControl] attempt ${attempt} status check failed: ${e.message}`);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
  }

  console.error(`[tuyaControl] FAILED to confirm ${deviceId} → ${on ? 'ON' : 'OFF'} after 3 attempts`);
  return false;
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

async function controlHotWater(on) {
  const ok = await tuyaControl(HW_MAIN_ID, on);
  console.log(`[主热水器] ${on ? '开' : '关'} ${ok ? '✅' : '❌'}`);
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
        const ok = await controlHotWater(isOnTask);
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
      const { execSync } = require('child_process');
      const statusRaw = execSync(
        `npx mcporter call tuya tuya_get_device_status ${HW_GF_ID}`,
        { cwd: HW_TUYA_CWD, timeout: 15000, encoding: 'utf8' }
      );
      const s = JSON.parse(statusRaw);
      if (s?.data?.switch === true) {
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
        const ok = await tuyaControl(HW_GF_ID, isOn);
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
  const gridImport = ess.gridPower ?? 0;
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

    if (ess.soc !== null && ess.soc >= chargeTargetPct) {
      // SOC 已达目标：只消纳 PV
      const pvAbsorb = parseFloat(Math.max(0, (pvPower ?? 0) - (homeLoad ?? 0.6)).toFixed(2));
      if (pvAbsorb >= 0.2) {
        await updateChargeKw(pvAbsorb, `pv-absorb: soc=${ess.soc}% pv=${pvPower}kW home=${homeLoad}kW`);
        console.log(`[充电] SOC ${ess.soc}% ≥ ${chargeTargetPct}%，PV消纳 ${pvAbsorb}kW`);
        action = 'charge-pv-only';
      } else {
        await switchToSelfUse(`charge-done: soc=${ess.soc}% >= target=${chargeTargetPct}%`);
        console.log(`[充电] SOC ${ess.soc}% ≥ ${chargeTargetPct}%，已达标，切self-use`);
        action = 'charge-done';
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
      // 正常充电
      if (ess.reportedMode !== 1) {
        console.log(`[模式] charge时段但mode=${ess.reportedMode}，切回 Timed`);
        const chargeWindows = planRow ? JSON.parse(planRow.charge_windows_json || '[]') : [];
        await restoreTimedMode(chargeWindows, `restore-timed: mode-was-${ess.reportedMode}`);
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
      // ── v3 卖电逻辑：action=sell 就卖，不做利润检查 ──
      // 确保逆变器在 Timed 模式
      if (ess.reportedMode !== 1) {
        await essApi.setParam('0x300C', 1, 'sell-restore-timed', 'plan-executor-v3');
        console.log(`[卖电] 模式 ${ess.reportedMode} → Timed(1)`);
      }
      const plannedSellKw = slot.sellKw > 0 ? slot.sellKw : MAX_SELL_KW;
      const actualSellKw = parseFloat(Math.max(0.5, Math.min(MAX_SELL_KW, plannedSellKw)).toFixed(2));
      await updateSellKw(actualSellKw, `sell-slot-v3: feedIn=${amber?.feedInPrice?.toFixed(1) ?? '?'}c`);
      extraSellKw = actualSellKw;
      console.log(`[卖电] v3模式 feedIn=${amber?.feedInPrice?.toFixed(1) ?? '?'}¢，直接卖电 ${actualSellKw}kW`);
      action = 'sell';
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
    if (ess.reportedMode === 1) {
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
    action = slot.action;
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
