#!/usr/bin/env node
/**
 * v2/plan-executor.js — 每5分钟执行计划 + 记录数据
 *
 * 职责（仅此三件，不做其他决策）：
 *   1. 读当前 ESS 状态 + Amber 价格 → 记录到 energy_log
 *   2. 对照 daily_plan 当前时段：
 *      - charge / sell 窗口已由 plan-today 写入逆变器，executor 只调功率
 *      - standby / self-use：确保逆变器不在充放电
 *      - DW 时段：紧急停止充放电
 *   3. 安全检查：总功率不超断路器（BREAKER_KW）
 *
 * 不做的事：
 *   - 不重新决定充不充电（那是 plan-today 的事）
 *   - 不因 Amber blip 切模式（已有时间窗口保障）
 *   - 不覆盖逆变器时间窗口
 *
 * 热水器预留：
 *   plan 里 action='hotwater' 时段，executor 会通过 Tuya MCP 发开关指令（待实现）
 */
'use strict';

process.env.TZ = 'Australia/Sydney'; // 统一用Sydney本地时间
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https    = require('https');
const http     = require('http');
const path     = require('path');
const Database = require('better-sqlite3');
const essApi   = require('./ess-api');

// ── 环境变量（全部从 .env，绝不硬编码）────────────────────────
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
const BREAKER_BUFFER  = 0.3;   // kW 安全余量，不撞到断路器上限
const MAX_CHARGE_KW   = 5.0;
const MAX_SELL_KW     = 5.0;
const SOC_FLOOR       = 10;    // % 绝对底线，不往下放
const SOC_OVERNIGHT   = 50;    // % 过夜保留底线，卖电不低于此值（热水器+夜间家用约需50%）
const DB_PATH         = path.join(__dirname, '..', 'data', 'energy.db');

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
    const http = require('http');
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

// 告警限频：同一类告警当天最多发 MAX_ALERTS_PER_DAY 次，用 kv_store 持久化
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
  // 优先用 value，但有时 value=0 而 valueStr 有正确数值（ESS API 解码 bug）
  // 如果 value 为 0 但 valueStr 非零，用 valueStr
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

  // 核心数据
  const soc          = findVal(batt, '0x1212') ?? findVal(batt, '0xB106') ?? null;
  const battPower    = findVal(batt, '0x1210') ?? null;   // kW positive=charging
  const battVoltage  = findVal(batt, '0x120C') ?? null;   // V
  const battCurrent  = findVal(batt, '0x120E') ?? null;   // A
  const homeLoad     = findVal(load, '0x1274') ?? null;   // kW
  const gridPower    = findVal(meter,'0xA112') ?? null;   // kW positive=import
  const pvPower      = findVal(pv,   '0x1270') ?? null;   // kW Total PV power
  const meterBuy     = findVal(meter,'0x1240') ?? null;   // kWh cumulative bought
  const meterSell    = findVal(meter,'0x1242') ?? null;   // kWh cumulative sold
  const reportedMode = runInfo?.x300C ?? null;

  // 今日汇总（来自 runInfo xc3xx 字段）
  const todayChargeKwh    = runInfo?.x126A ?? null;  // 今日电池充电（x126A，与App吻合）
  const todayDischargeKwh = runInfo?.x126C ?? null;  // 今日电池放电（x126C）
  const todayPvKwh        = runInfo?.x1264 ?? null;  // 今日PV发电（x1264，与App吻合）
  const todayGridBuyKwh   = runInfo?.x1266 ?? null;  // 今日买电（x1266，与App吻合）
  const todayGridSellKwh  = runInfo?.x1268 ?? null;  // 今日卖电（x1268）
  const todayHomeKwh      = runInfo?.x126E ?? null;  // 今日用电（x126E）

  // 流量图（flow）
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
    // 拿当前 + 今天剩余所有时段的预测（next=48 覆盖24h）
    const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=48`;
    const raw = await httpsGet(url, { Authorization:`Bearer ${AMBER_TOKEN}` });
    if (!Array.isArray(raw)) return null;

    let buyPrice = null, feedInPrice = null, spotPrice = null;
    let clPrice = null, clDescriptor = null, clTariffPeriod = null;
    let demandWindow = false, nemTime = null, descriptor = null, tariffPeriod = null;
    let renewables = null, nextDemandMin = null;

    // 收集今天剩余时段的买价预测（用于相对判断）
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
      // 收集今天的 general 预测价格
      if ((p.type === 'CurrentInterval' || p.type === 'ForecastInterval') && p.channelType === 'general') {
        const pDate = p.startTime ? new Date(new Date(p.startTime).getTime() + 10*3600*1000).toISOString().slice(0,10) : null;
        if (pDate === todayDate && p.perKwh != null) {
          futureBuyPrices.push(p.perKwh);
        }
      }
      // 找最近的 DW 开始时间
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
      futureBuyPrices, // 今天剩余时段的买价列表
    };
  } catch { return null; }
}

// ── 逆变器写操作：全部委托给 ess-api.js（单一接口）────────────
// 本地包装，保持日志输出格式一致

async function updateChargeKw(kw, reason = 'charge') {
  const ok = await essApi.setChargeKw(kw, reason, 'plan-executor');
  console.log(`[功率] 充电功率 → ${kw}kW ${ok?'✅':'❌'} (${reason})`);
  return ok;
}

async function updateSellKw(kw, reason = 'sell') {
  const ok = await essApi.setSellKw(kw, reason, 'plan-executor');
  console.log(`[功率] 放电功率 → ${kw}kW ${ok?'✅':'❌'} (${reason})`);
  return ok;
}

async function switchToSelfUse(reason = 'self-use') {
  const ok = await essApi.switchToSelfUse(reason, 'plan-executor');
  console.log(`[模式] 切回 Self-use ${ok?'✅':'❌'} (${reason})`);
  return ok;
}

async function restoreTimedMode(chargeWindows, reason = 'restore-timed') {
  const w = chargeWindows?.[0];
  const startHHMM = w ? w.startHour * 100 : 900;
  const endHHMM   = w ? (w.endHour - 1) * 100 + 30 : 1430;
  await essApi.restoreTimedMode({ startHHMM, endHHMM, chargeKw: MAX_CHARGE_KW }, reason, 'plan-executor');
  console.log(`[模式] 切回 Timed ✅ 充电窗口: ${String(startHHMM).padStart(4,'0')}–${String(endHHMM).padStart(4,'0')} chargeKw=${MAX_CHARGE_KW} (${reason})`);
}

async function emergencyStop(reason) {
  console.log(`[紧急] 停止充放电: ${reason}`);
  await essApi.emergencyStop(`emergencyStop: ${reason}`, 'plan-executor');
}

// ── 计算动态充电功率（不超断路器）────────────────────────────
const calcSafeChargeKw = essApi.calcSafeChargeKw;

// ── 动态充电中止判断（相对电价逻辑）───────────────────────────
// 原则：电池是蓄水池，只在"今天相对便宜"的时段充电。
// "便宜"不用绝对值，而是看：当前价格在今天剩余时段里排第几？
//
// 逻辑：
// 1. 拿到今天剩余所有时段的实时/预测价格，排序
// 2. 计算充到目标需要几个槽（neededSlots）
// 3. 当前价格 ≤ 第 neededSlots 便宜的价格 → 充（属于最便宜的那批）
// 4. 当前价格 > 第 neededSlots 便宜的价格 → 等更便宜的
// 5. 但如果：剩余时间 ≤ neededSlots → 不管价格，必须充（时间不够挑了）
//
function shouldAbortCharge(realBuyPrice, buyThreshold, ess, planRow, amber) {
  const BUY_MAX_C = parseFloat(process.env.BUY_MAX_C || '25');
  // 极端高价保护
  if (realBuyPrice >= BUY_MAX_C) return true;

  const soc = ess.soc ?? 50;
  const BATT_KWH = 42;
  const MAX_CHARGE_KW = 5;
  const chargeTargetPct = JSON.parse(planRow?.notes ?? '{}').gridChargeTarget ?? 65;
  const targetKwh = chargeTargetPct / 100 * BATT_KWH;
  const currentKwh = soc / 100 * BATT_KWH;
  const neededKwh = Math.max(0, targetKwh - currentKwh);

  // 已达目标，不需要充
  if (neededKwh <= 0) return false; // 不 abort（让上层的 SOC>=target 逻辑处理）

  // 计算需要几个半小时槽才能充到目标
  const kwhPerSlot = MAX_CHARGE_KW * 0.5 * 0.95; // ~2.375kWh/slot
  const neededSlots = Math.ceil(neededKwh / kwhPerSlot);

  // 从 Amber 拿今天剩余时段的价格
  const futurePrices = amber?.futureBuyPrices ?? [];

  if (futurePrices.length === 0) {
    // 没有预测数据，信任计划不 abort
    return false;
  }

  // 剩余时段不够选 → 必须充，不挑了
  if (futurePrices.length <= neededSlots) {
    return false;
  }

  // 排序，取第 neededSlots 便宜的价格作为门槛
  const sorted = [...futurePrices].sort((a, b) => a - b);
  const cutoffPrice = sorted[Math.min(neededSlots - 1, sorted.length - 1)];

  // 当前价格在最便宜的 N 个之内 → 充
  // 加 1¢ 容差（预测可能有小偏差）
  if (realBuyPrice <= cutoffPrice + 1) {
    return false; // 不 abort，充
  }

  // 当前价格太贵，等更便宜的
  console.log(`[充电判断] ${realBuyPrice.toFixed(1)}¢ > 门槛${cutoffPrice.toFixed(1)}¢+1（需${neededSlots}槽/${futurePrices.length}剩余），等便宜时段`);
  return true;
}

// ── 记录数据到 energy_log ─────────────────────────────────────
function logData(db, ess, amber, slot, action, extra = {}) {
  const now = new Date().toISOString();

  // 计算本次与上次 meter 的增量（用于精确买卖电量统计）
  let meterBuyDelta = null, meterSellDelta = null;
  try {
    const prev = db.prepare(
      "SELECT meter_buy_total, meter_sell_total, ts FROM energy_log WHERE meter_buy_total IS NOT NULL ORDER BY ts DESC LIMIT 1"
    ).get();
    if (prev && ess.meterBuy != null) {
      const delta = parseFloat((ess.meterBuy - prev.meter_buy_total).toFixed(4));
      // 合理范围：0 ~ 5分钟最大可能（7.7kW × 10min / 60 ≈ 1.3kWh，留余量到2kWh）
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
      // ESS core
      ess.soc, ess.battPower, ess.homeLoad, ess.pvPower, ess.gridPower,
      ess.battVoltage ?? null, ess.battCurrent ?? null,
      // Amber prices
      amber?.buyPrice ?? null, amber?.feedInPrice ?? null, amber?.spotPrice ?? null,
      amber?.demandWindow ? 1 : 0,
      amber?.renewables ?? null, amber?.descriptor ?? null, amber?.tariffPeriod ?? null,
      amber?.clPrice ?? null, amber?.clDescriptor ?? null, amber?.clTariffPeriod ?? null,
      amber?.feedInPrice ?? null, amber?.spotPrice ?? null,
      amber?.nextDemandMin ?? null,
      // mode
      modeNum, modeChanged, action ?? slot?.action ?? 'unknown',
      extra.modeFrom ?? null, extra.modeTo ?? null,
      // meter
      ess.meterBuy ?? null, ess.meterSell ?? null,
      meterBuyDelta, meterSellDelta,
      // today totals
      ess.todayChargeKwh ?? null, ess.todayDischargeKwh ?? null, ess.todayPvKwh ?? null,
      ess.todayGridBuyKwh ?? null, ess.todayGridSellKwh ?? null, ess.todayHomeKwh ?? null,
      // flow
      ess.flowPv ?? null, ess.flowGrid ?? null, ess.flowBattery ?? null, ess.flowLoad ?? null,
      // meta
      ess.reportedMode ?? null, 'executor-v2',
      extra.chargeKw ?? slot?.chargeKw ?? null,
      extra.sellKw   ?? slot?.sellKw   ?? null,
      // solar forecast (filled by solar-forecast.js separately)
      null, null,
      extra.alert ?? null,
    );
  } catch(e) {
    console.warn('[DB] 写入失败:', e.message);
  }
}

// ── 热水器控制（Tuya MCP）────────────────────────────────────
// ── 热水器设备 ID ──────────────────────────────────────────
const HW_MAIN_ID = 'bf160bbe78f4f1ce6dpkdp'; // 主热水器：plan-today hwWindow 控制
const HW_GF_ID   = 'bf3c28e8181e5e980eoobm';  // GF热水器（~3.5kW）：固定时间窗口控制
const HW_TUYA_CWD = '/home/deven/.openclaw/workspace';

// GF热水器固定兜底窗口：凌晨04:00电池供热（plan-today 不覆盖凌晨时段）
// 下午窗口由 plan-today 的 gf_window_json 动态计划

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

    // 验证设备实际状态（等3秒让设备响应）
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


// 本地时间字符串（TZ=Australia/Sydney 已在进程启动时设置）
function nowLocal() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Australia/Sydney' }).replace(' ', 'T');
}

// 热水器操作记录（写入 hw_log，供 dashboard 使用）
function logHwAction(db, deviceId, deviceName, on, opts = {}) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS hw_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, device_id TEXT, device_name TEXT,
      online INTEGER, switch_on INTEGER, duration_min REAL,
      voltage_v REAL, current_a REAL, power_w REAL, total_kwh REAL,
      action TEXT, triggered_by TEXT, source TEXT, plan_window TEXT
    )`);
    // 确保新列存在
    ['action','triggered_by','source','plan_window'].forEach(col => {
      try { db.prepare(`ALTER TABLE hw_log ADD COLUMN ${col} TEXT`).run(); } catch {}
    });
    db.prepare(`
      INSERT INTO hw_log (ts, device_id, device_name, switch_on, action, triggered_by, source, plan_window)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowLocal(),
      deviceId, deviceName,
      on ? 1 : 0,
      on ? 'on' : 'off',
      opts.triggeredBy ?? 'executor',
      opts.source ?? null,
      opts.planWindow ?? null,
    );
  } catch(e) { console.warn('[hw_log] 写入失败:', e.message); }
}

async function controlHotWater(on) {
  const ok = await tuyaControl(HW_MAIN_ID, on);
  console.log(`[主热水器] ${on ? '开' : '关'} ${ok ? '✅' : '❌'}`);
  return ok;
}

// 主热水器：由 plan-today hardware_tasks 驱动（notes.hardwareTasks 中 device='main_hw'）
async function handleHotWaterWindow(planRow, db, syd) {
  const today = syd.date;
  const nowMins = syd.hh * 60 + syd.mi;

  // ── 兜底保护：热水器已开但窗口丢失时，超过最大运行时间自动关闭 ──
  const onKey  = `hw_main:${today}:on`;
  const offKey = `hw_main:${today}:off`;
  const isOn  = !!db.prepare("SELECT 1 FROM kv_store WHERE key=?").get(onKey);
  const isOff = !!db.prepare("SELECT 1 FROM kv_store WHERE key=?").get(offKey);
  const MAX_HW_MINS = 150; // 最大运行2.5小时，超过强制关

  if (isOn && !isOff) {
    const hwOpenRow = db.prepare("SELECT value FROM kv_store WHERE key=?").get(`hw_main:${today}:open_time`);
    const openMins = hwOpenRow ? parseInt(hwOpenRow.value) : null;
    if (openMins !== null && nowMins - openMins >= MAX_HW_MINS) {
      console.warn(`[主热水器] ⚠️ 已开 ${nowMins - openMins}min，超过最大 ${MAX_HW_MINS}min，强制关闭`);
      const ok = await controlHotWater(false);
      if (ok) {
        logHwAction(db, HW_MAIN_ID, '主热水器', false, { triggeredBy: 'executor-timeout' });
        db.prepare("INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)").run(offKey, '1');
        await sendAlert(`⚠️ 主热水器已超时自动关闭（开了${Math.round((nowMins-openMins)/60*10)/10}h）`);
      }
      return;
    }
  }

  // Read hardware_tasks from plan notes
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
          logHwAction(db, HW_MAIN_ID, '主热水器', isOnTask, { triggeredBy: 'executor', planWindow: task.time });
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

// GF热水器：所有窗口由 plan-today hardware_tasks 动态生成，executor 只读取执行
// 不再有凌晨04:00的硬编码兜底窗口

async function handleGfHotWater(db, syd) {
  const nowMins = syd.hh * 60 + syd.mi;
  const today = syd.date;
  const MAX_GF_MINS = 150; // 最大运行2.5小时

  // ── 兜底保护：GF热水器超时强制关闭 ──
  const gfOpenRow = db.prepare("SELECT value FROM kv_store WHERE key=?").get(`hw_gf:${today}:open_time`);
  const gfOffDone = !!db.prepare("SELECT 1 FROM kv_store WHERE key LIKE ? AND key LIKE '%off%'")
    .get(`hw_gf:${today}:%`);
  if (gfOpenRow && !gfOffDone) {
    const openMins = parseInt(gfOpenRow.value);
    if (nowMins - openMins >= MAX_GF_MINS) {
      console.warn(`[GF热水器] ⚠️ 已开 ${nowMins - openMins}min，超过最大 ${MAX_GF_MINS}min，强制关闭`);
      const ok = await tuyaControl(HW_GF_ID, false);
      if (ok) {
        logHwAction(db, HW_GF_ID, 'GF热水器', false, { triggeredBy: 'executor-timeout' });
        await sendAlert(`⚠️ GF热水器已超时自动关闭（开了${Math.round((nowMins-openMins)/60*10)/10}h）`);
      } else {
        await sendAlert(`🚨 GF热水器超时关闭失败！已开 ${nowMins - openMins}min，请手动关闭！`);
      }
      // 无论成功与否都标记，避免每5分钟重复告警（但下面的状态回查会继续重试）
    }
  }

  // ── 状态回查：每次 executor 跑都检查 GF 热水器是否该关但还开着 ──
  const lastOffTask = db.prepare(
    "SELECT value FROM kv_store WHERE key LIKE ? AND key LIKE '%:off'"
  ).get(`hw_gf:${today}:%`);
  if (lastOffTask) {
    // 已经执行过关闭任务，验证设备实际状态
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

  // 读 plan-today 生成的 hardware_tasks（在 notes JSON 里）
  const planRow = db.prepare("SELECT notes FROM daily_plan WHERE date=? AND is_active=1 ORDER BY rowid DESC LIMIT 1").get(today);
  if (!planRow?.notes) return;

  let notes;
  try { notes = JSON.parse(planRow.notes); } catch { return; }
  const tasks = notes?.hardwareTasks?.filter(t => t.device === 'gf_hw') ?? [];
  if (tasks.length === 0) return;

  for (const task of tasks) {
    const [th, tm] = task.time.split(':').map(Number);
    const taskMins = th * 60 + tm;

    // Execute within a 30-minute window of the scheduled time
    if (nowMins >= taskMins && nowMins < taskMins + 30) {
      const isOn = task.action === 'on';
      const key = `hw_gf:${today}:${task.time}:${task.action}`;
      if (!db.prepare("SELECT 1 FROM kv_store WHERE key=?").get(key)) {
        const ok = await tuyaControl(HW_GF_ID, isOn);
        console.log(`[GF热水器] ${isOn ? '开' : '关'} ${task.time} ${ok ? '✅' : '❌'}`);
        if (ok) {
          logHwAction(db, HW_GF_ID, 'GF热水器', isOn, { triggeredBy: 'executor', planWindow: task.time });
          db.prepare("INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)").run(key, '1');
          if (isOn) {
            db.prepare("INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)").run(`hw_gf:${today}:open_time`, String(nowMins));
          }
          await sendAlert(`${isOn ? '🛁' : '🔴'} GF热水器已${isOn ? '开' : '关'}（${task.time}，plan-today 计划）`);
        } else if (!isOn) {
          // 关闭失败！不标记 key，下次 executor 跑时重试
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
  console.log(`\n[${syd.date} ${syd.hh}:${String(syd.mi).padStart(2,'0')}] === plan-executor v2 ===`);

  const db = new Database(DB_PATH);
  essApi.init({ db, mac: ESS_MAC_HEX, token: ESS_TOKEN });

  // 确保 kv_store 表存在（用于热水器状态追踪）
  db.exec("CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)");

  // 1. 读今日计划
  const planRow = db.prepare(
    "SELECT * FROM daily_plan WHERE date=? AND is_active=1 ORDER BY rowid DESC LIMIT 1"
  ).get(syd.date);

  if (!planRow) {
    console.log('[计划] 今天没有计划，仅记录数据');
  }

  const intervals = planRow ? JSON.parse(planRow.intervals_json) : [];

  // 找当前半小时时段 — 优先用 key（"HH:MM" 标准槽），fallback nemTime
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

  // ESS 连接失败告警（SOC 为 null 说明 API 没返回数据，可能是 token 过期）
  if (ess.soc === null) {
    await sendAlertOnce(db, 'ess-offline', '⚠️ ESS 逆变器数据获取失败（SOC=null），可能 token 过期，请检查！');
  }
  if (amber) {
    console.log(`[Amber] buy:${amber.buyPrice?.toFixed(2)}¢ feedIn:${amber.feedInPrice?.toFixed(2)}¢ DW:${amber.demandWindow} ${amber.descriptor??''}`);
  } else {
    console.log('[Amber] API blip — 继续按计划执行（时间窗口已设好）');
    await sendAlertOnce(db, 'amber-offline', '⚠️ Amber API 连续获取失败，充放电按固定窗口运行，请检查网络或 API token！');
  }

  // 3. DW 检查：plan-today 已在计划里处理 DW，只需检查计划外的突发 DW
  const isDW = amber?.demandWindow ?? false;
  const slotIsDW = slot?.dw ?? false;
  if (isDW && !slotIsDW) {
    // 计划外的 DW 告警（不叫停，但发告警并记录）
    console.warn(`[告警] 实时 DW=true 但计划未标注 DW，请检查 plan-today 是否需要重跑`);
  }

  // 4. 安全检查：总功率超断路器 → 降低充电功率
  const homeLoad   = ess.homeLoad  ?? 0;
  const pvPower    = ess.pvPower   ?? 0;
  const gridImport = ess.gridPower ?? 0; // 正=买电(import)
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
  let action = 'monitor'; // 默认只监控，不动逆变器

  if (!slot) {
    // 无计划时段：什么都不做，逆变器按已设时间窗口运行
    action = 'no-slot';

  } else if (slot.action === 'charge' || slot.action === 'charge+hw') {
    const buyThreshold = JSON.parse(planRow?.notes ?? '{}').buyThreshold ?? planRow?.buy_threshold_c ?? 10;
    const realBuyPrice = amber?.buyPrice ?? null;
    // 从 plan notes 读今日充电目标（plan-today 按PV预测动态设定：晴天85%，阴天93%）
    const planNotes = JSON.parse(planRow?.notes ?? '{}');
    const chargeTargetPct = planNotes.gridChargeTarget ?? parseFloat(process.env.CHARGE_TARGET_PCT || '85');

    if (ess.soc !== null && ess.soc >= chargeTargetPct) {
      // SOC 已达目标：只消纳 PV，不从电网充电
      const pvAbsorb = parseFloat(Math.max(0, (pvPower ?? 0) - (homeLoad ?? 0.6)).toFixed(2));
      if (pvAbsorb >= 0.2) {
        await updateChargeKw(pvAbsorb, `pv-absorb: soc=${ess.soc}% pv=${pvPower}kW home=${homeLoad}kW`);
        console.log(`[充电] SOC ${ess.soc}% ≥ ${chargeTargetPct}%，PV消纳 ${pvAbsorb}kW`);
        action = 'charge-pv-only';
      } else {
        // 无 PV 可消纳 + SOC 已达标 → 切 self-use，不花钱充电
        await switchToSelfUse(`charge-done: soc=${ess.soc}% >= target=${chargeTargetPct}%`);
        console.log(`[充电] SOC ${ess.soc}% ≥ ${chargeTargetPct}%，已达标，切self-use`);
        action = 'charge-done';
      }
    } else if (realBuyPrice != null && realBuyPrice > 25) {
      // 极端高价（>25¢）才 abort 充电——信任计划，不自作主张跳过
      console.log(`[充电] 实际电价 ${realBuyPrice.toFixed(1)}¢ 极端高价（>25¢），暂停充电`);
      await switchToSelfUse(`charge-skip: realBuy=${realBuyPrice.toFixed(1)}c extreme-price`);
      logData(db, ess, amber, slot, 'charge-skip-price', { buyPrice: realBuyPrice, threshold: buyThreshold });
      action = 'charge-skip';
    } else {
      // 电价合理，正常充电
      if (ess.reportedMode !== 1) {
        console.log(`[模式] charge时段但mode=${ess.reportedMode}，切回 Timed`);
        const chargeWindows = planRow ? JSON.parse(planRow.charge_windows_json || '[]') : [];
        await restoreTimedMode(chargeWindows, `restore-timed: mode-was-${ess.reportedMode}`);
        logData(db, ess, amber, slot, 'mode-switch-timed', { modeFrom: ess.reportedMode, modeTo: 1 });
      }
      const safeChargeKw = calcSafeChargeKw(homeLoad, pvPower, ess.gridPower, ess.battPower);
      // 始终用断路器计算的最大安全功率充电，不受 plan 里预设 chargeKw 的限制
      // plan 的 chargeKw 是静态估算，executor 实时知道 homeLoad，应该用实时值
      const targetKw = safeChargeKw;
      if (targetKw < MAX_CHARGE_KW - 0.2) {
        console.log(`[功率] homeLoad=${homeLoad.toFixed(2)}kW，充电 ${targetKw}kW（断路器上限）`);
      }
      await updateChargeKw(targetKw, `charge-slot: home=${homeLoad.toFixed(2)}kW safe=${safeChargeKw}kW`);
      action = 'charge';
    }

  } else if (slot.action === 'sell') {
    // 卖电时段：实时检查 SOC 底线 + feedIn 价格
    if (ess.soc !== null && ess.soc <= SOC_OVERNIGHT) {
      // SOC 触底过夜保留线：切 Self-use + 清卖电功率 + 清卖电窗口，防止逆变器自动恢复
      await switchToSelfUse('self-use-slot');
      await essApi.setParam('0xC0BC', 0, 'clear-sell', 'plan-executor');   // 卖电功率清零
      await essApi.setParam('0xC018', 0, 'clear-sell', 'plan-executor');   // 卖电开始时间清零
      await essApi.setParam('0xC01A', 0, 'clear-sell', 'plan-executor');   // 卖电结束时间清零
      extraSellKw = 0;
      console.log(`[卖电] SOC=${ess.soc}% ≤ ${SOC_OVERNIGHT}%，停止卖电，清卖电窗口`);
      action = 'sell-soc-floor';
      logData(db, ess, amber, slot, 'mode-switch-selfuse', { modeFrom: ess.reportedMode, modeTo: 0, sellKw: 0 });
    } else if (amber && amber.feedInPrice != null) {
      const planSellMinC = JSON.parse(planRow?.notes ?? '{}').sellMinC ?? 9.9;
      if (amber.feedInPrice >= planSellMinC) {
        // 确保逆变器在 Timed 模式（Self-use 下不会按窗口放电）
        if (ess.reportedMode !== 1) {
          await essApi.setParam('0x300C', 1, 'sell-restore-timed', 'plan-executor');
          console.log(`[卖电] 模式 ${ess.reportedMode} → Timed(1)`);
        }
        // 用计划里该槽的 sellKw，fallback 到 MAX_SELL_KW
        const plannedSellKw = slot.sellKw > 0 ? slot.sellKw : MAX_SELL_KW;
        const actualSellKw = parseFloat(Math.max(0.5, Math.min(MAX_SELL_KW, plannedSellKw)).toFixed(2));
        await updateSellKw(actualSellKw, `sell-slot: feedIn=${amber.feedInPrice.toFixed(1)}c`);
        extraSellKw = actualSellKw;
        console.log(`[卖电] feedIn=${amber.feedInPrice.toFixed(1)}¢ ≥ ${planSellMinC}¢，卖电 ${actualSellKw}kW`);
        action = 'sell';
      } else {
        await updateSellKw(0, `sell-skip: feedIn-too-low`);
        await switchToSelfUse('sell-skip-self-use');  // 切回Self-use，避免Timed模式+放电0的异常状态
        extraSellKw = 0;
        console.log(`[卖电] feedIn=${amber.feedInPrice.toFixed(1)}¢ < ${planSellMinC}¢，停止卖电，切Self-use`);
        action = 'sell-skip';
      }
    } else {
      // Amber blip：无法获取价格，但仍需检查 SOC 底线
      if (ess.soc !== null && ess.soc <= SOC_OVERNIGHT) {
        await switchToSelfUse('self-use-slot');
        await essApi.setParam('0xC0BC', 0, 'clear-sell', 'plan-executor');
        await essApi.setParam('0xC018', 0, 'clear-sell', 'plan-executor');
        await essApi.setParam('0xC01A', 0, 'clear-sell', 'plan-executor');
        extraSellKw = 0;
        console.log(`[卖电] Amber blip 但 SOC=${ess.soc}% ≤ ${SOC_OVERNIGHT}%，强制停止卖电`);
        action = 'sell-soc-floor';
      logData(db, ess, amber, slot, 'mode-switch-selfuse', { modeFrom: ess.reportedMode, modeTo: 0, sellKw: 0 });
      } else {
        console.log('[卖电] Amber blip，维持当前逆变器窗口');
        action = 'sell-blip';
      }
    }

  } else if (slot.action === 'hotwater') {
    // 热水器时段（预留）
    await controlHotWater(true);
    action = 'hotwater';

  } else if (slot.action === 'standby' || slot.action === 'self-use') {
    // 自用/待机：充电窗口由 plan-today 决定，executor 不做机会充电
    // 若逆变器还在 Timed 模式，检查后续是否有 sell 时段——有的话保留 Timed
    {
      if (ess.reportedMode === 1) {
        const nowMins = syd.hh * 60 + syd.mi;
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

  }

  // 6. SOC 低电量记录（不强制停止——逆变器固件有自己的底线保护）
  if (ess.soc !== null && ess.soc <= SOC_FLOOR) {
    console.log(`[SOC] ${ess.soc}% 接近底线 ${SOC_FLOOR}%，逆变器固件会自动保护`);
    action = action === 'monitor' ? 'soc-low' : action;
  }

  // 7. 记录数据（所有字段）
  logData(db, ess, amber, slot, action, {
    chargeKw: extraChargeKw,
    sellKw:   extraSellKw,
    alert:    (isDW && !slotIsDW) ? 'unexpected-DW' : null,
  });

  // 7b. 记录本次5分钟电费到 cost_log
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS cost_log (
      ts TEXT PRIMARY KEY,
      buy_kwh REAL, buy_price_c REAL, buy_cost_c REAL,
      sell_kwh REAL, sell_price_c REAL, sell_revenue_c REAL,
      cl_price_c REAL
    )`);
    // 从 energy_log 取最近一条的 meter delta
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

  // 8. 热水器窗口控制
  await handleHotWaterWindow(planRow, db, syd);  // 主热水器：plan-today hwWindow
  await handleGfHotWater(db, syd);               // GF热水器：固定 04:00+14:00

  // 9. 每小时整点打印今日汇总（用 ESS 自带的今日累计，最准确）
  if (syd.mi === 0) {
    console.log(`[今日] 买电:${ess.todayGridBuyKwh?.toFixed(2)}kWh 卖电:${ess.todayGridSellKwh?.toFixed(2)}kWh PV:${ess.todayPvKwh?.toFixed(2)}kWh 充电:${ess.todayChargeKwh?.toFixed(2)}kWh 放电:${ess.todayDischargeKwh?.toFixed(2)}kWh`);
  }

  db.close();

  // Turso 云同步（fire-and-forget，失败不影响主流程）
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

  console.log(`[完成] action=${action}`);
}

main().catch(async e => {
  console.error('[ERROR]', e.message, e.stack?.split('\n')[1]);
  await sendAlert(`⚠️ plan-executor 崩溃: ${e.message}`);
  process.exit(1);
});
