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

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https    = require('https');
const http     = require('http');
const path     = require('path');
const Database = require('better-sqlite3');

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
const SOC_OVERNIGHT   = 35;    // % 过夜保留底线，卖电不低于此值
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
  return item?.value ?? null;
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
  const pvPower      = findVal(pv,   '0x1208') ?? null;   // kW
  const meterBuy     = findVal(meter,'0x1240') ?? null;   // kWh cumulative bought
  const meterSell    = findVal(meter,'0x1242') ?? null;   // kWh cumulative sold
  const reportedMode = runInfo?.x300C ?? null;

  // 今日汇总（来自 runInfo xc3xx 字段）
  const todayChargeKwh    = runInfo?.xc304 ?? null;
  const todayDischargeKwh = runInfo?.xc306 ?? null;
  const todayPvKwh        = runInfo?.xc308 ?? null;
  const todayGridBuyKwh   = runInfo?.xc30A ?? null;
  const todayGridSellKwh  = runInfo?.xc30C ?? null;
  const todayHomeKwh      = runInfo?.xc30E ?? null;

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
    const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=3`;
    const raw = await httpsGet(url, { Authorization:`Bearer ${AMBER_TOKEN}` });
    if (!Array.isArray(raw)) return null;

    let buyPrice = null, feedInPrice = null, spotPrice = null;
    let clPrice = null, clDescriptor = null, clTariffPeriod = null;
    let demandWindow = false, nemTime = null, descriptor = null, tariffPeriod = null;
    let renewables = null, nextDemandMin = null;

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
    };
  } catch { return null; }
}

// ── 逆变器参数写入 ────────────────────────────────────────────
async function setParam(index, data) {
  const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceParam',
    { macHex:ESS_MAC_HEX, index, data }, ESS_HEADERS).catch(() => ({}));
  return r.code === 200;
}

// 只调整充电功率（不动时间窗口）
async function updateChargeKw(kw) {
  const clamped = parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, kw)).toFixed(2));
  const ok = await setParam('0xC0BA', clamped);
  console.log(`[功率] 充电功率 → ${clamped}kW ${ok?'✅':'❌'}`);
  return ok;
}

// 只调整放电功率（不动时间窗口）
async function updateSellKw(kw) {
  const clamped = parseFloat(Math.min(MAX_SELL_KW, Math.max(0, kw)).toFixed(2));
  const ok = await setParam('0xC0BC', clamped);
  console.log(`[功率] 放电功率 → ${clamped}kW ${ok?'✅':'❌'}`);
  return ok;
}

// 切回 Self-use 模式（0x300C=0）
async function switchToSelfUse() {
  const ok = await setParam('0x300C', 0);
  console.log(`[模式] 切回 Self-use ${ok?'✅':'❌'}`);
  return ok;
}

// 恢复 Timed 模式并写入正确的充电时间窗口
async function restoreTimedMode(chargeWindows) {
  const w = chargeWindows?.[0];
  const startHHMM = w ? w.startHour * 100 : 900;
  const endHHMM   = w ? w.endHour * 100 - 30 : 1430; // endHour是exclusive，减30min
  await setParam('0x300C', 1);
  await setParam('0xC014', startHHMM);
  await setParam('0xC016', endHHMM);
  await setParam('0xC0BA', MAX_CHARGE_KW);  // 恢复 Timed 后必须重写充电功率
  console.log(`[模式] 切回 Timed ✅ 充电窗口: ${String(startHHMM).padStart(4,'0')}–${String(endHHMM).padStart(4,'0')} chargeKw=${MAX_CHARGE_KW}`);
}

// 紧急停止：清空充放电功率（DW 或超断路器）
async function emergencyStop(reason) {
  console.log(`[紧急] 停止充放电: ${reason}`);
  await setParam('0xC0BA', 0);
  await sleep(300);
  await setParam('0xC0BC', 0);
}

// ── 计算动态充电功率（不超断路器）────────────────────────────
function calcSafeChargeKw(homeLoad, pvPower) {
  // 总电网进口 = homeLoad - pvPower + chargeKw ≤ BREAKER_KW - buffer
  const netHouseFromGrid = (homeLoad ?? 0) - (pvPower ?? 0);
  const headroom = BREAKER_KW - BREAKER_BUFFER - Math.max(0, netHouseFromGrid);
  return parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, headroom)).toFixed(2));
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

// ── 热水器控制（预留，待 Tuya MCP 实现）─────────────────────
async function controlHotWater(on) {
  // TODO: 接入 Tuya MCP
  // 当 plan action='hotwater' 时调用
  console.log(`[热水器] ${on ? '开' : '关'}（待 Tuya MCP 实现）`);
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  const syd = sydneyTime();
  const now = new Date();
  console.log(`\n[${syd.date} ${syd.hh}:${String(syd.mi).padStart(2,'0')}] === plan-executor v2 ===`);

  const db = new Database(DB_PATH);

  // 1. 读今日计划
  const planRow = db.prepare(
    "SELECT * FROM daily_plan WHERE date=? AND is_active=1 ORDER BY rowid DESC LIMIT 1"
  ).get(syd.date);

  if (!planRow) {
    console.log('[计划] 今天没有计划，仅记录数据');
  }

  const intervals = planRow ? JSON.parse(planRow.intervals_json) : [];

  // 找当前半小时时段
  const nowMins = syd.hh * 60 + syd.mi;
  const slot = intervals.find(s => {
    const h = parseInt(s.nemTime?.substring(11,13) ?? s.key?.substring(0,2) ?? '0');
    const m = parseInt(s.nemTime?.substring(14,16) ?? s.key?.substring(3,5) ?? '0');
    return nowMins >= h*60+m && nowMins < h*60+m+30;
  });

  console.log(`[时段] ${slot ? `${slot.key} action=${slot.action} chargeKw=${slot.chargeKw} sellKw=${slot.sellKw}` : '无匹配时段'}`);

  // 2. 并行读取 ESS + Amber
  const [ess, amber] = await Promise.all([ readEss(), readAmber() ]);

  console.log(`[ESS] SOC:${ess.soc}% batt:${ess.battPower}kW home:${ess.homeLoad}kW pv:${ess.pvPower}kW grid:${ess.gridPower}kW mode:${ess.reportedMode}`);
  if (amber) {
    console.log(`[Amber] buy:${amber.buyPrice?.toFixed(2)}¢ feedIn:${amber.feedInPrice?.toFixed(2)}¢ DW:${amber.demandWindow} ${amber.descriptor??''}`);
  } else {
    console.log('[Amber] API blip — 继续按计划执行（时间窗口已设好）');
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
    const safeKw = calcSafeChargeKw(homeLoad, pvPower);
    console.log(`[安全] 电网进口 ${gridImport.toFixed(2)}kW 超断路器上限，降充电至 ${safeKw}kW`);
    await updateChargeKw(safeKw);
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

  } else if (slot.action === 'charge') {
    // 充电时段：确保 Timed 模式+正确窗口，动态调整功率
    if (ess.reportedMode !== 1) {
      console.log(`[模式] charge时段但mode=${ess.reportedMode}，切回 Timed`);
      const chargeWindows = planRow ? JSON.parse(planRow.charge_windows_json || '[]') : [];
      await restoreTimedMode(chargeWindows);
      logData(db, ess, amber, slot, 'mode-switch-timed', { modeFrom: ess.reportedMode, modeTo: 1 });
    }
    // 充电时段固定 5kW，不做动态降速
    // 断路器保护已在上方安全检查（gridImport > BREAKER_KW - BUFFER）处理
    const targetKw = slot.chargeKw || MAX_CHARGE_KW;
    await updateChargeKw(targetKw);
    action = 'charge';

  } else if (slot.action === 'sell') {
    // 卖电时段：实时检查 SOC 底线 + feedIn 价格
    if (ess.soc !== null && ess.soc <= SOC_OVERNIGHT) {
      // SOC 触底过夜保留线：切 Self-use + 清卖电功率 + 清卖电窗口，防止逆变器自动恢复
      await switchToSelfUse();
      await setParam('0xC0BC', 0);   // 卖电功率清零
      await setParam('0xC018', 0);   // 卖电开始时间清零
      await setParam('0xC01A', 0);   // 卖电结束时间清零
      extraSellKw = 0;
      console.log(`[卖电] SOC=${ess.soc}% ≤ ${SOC_OVERNIGHT}%，停止卖电，清卖电窗口`);
      action = 'sell-soc-floor';
      logData(db, ess, amber, slot, 'mode-switch-selfuse', { modeFrom: ess.reportedMode, modeTo: 0, sellKw: 0 });
    } else if (amber && amber.feedInPrice != null) {
      const planSellMinC = JSON.parse(planRow?.notes ?? '{}').sellMinC ?? 9.9;
      if (amber.feedInPrice >= planSellMinC) {
        // 用计划里该槽的 sellKw，fallback 到 MAX_SELL_KW
        const plannedSellKw = slot.sellKw > 0 ? slot.sellKw : MAX_SELL_KW;
        const actualSellKw = parseFloat(Math.max(0.5, Math.min(MAX_SELL_KW, plannedSellKw)).toFixed(2));
        await updateSellKw(actualSellKw);
        extraSellKw = actualSellKw;
        console.log(`[卖电] feedIn=${amber.feedInPrice.toFixed(1)}¢ ≥ ${planSellMinC}¢，卖电 ${actualSellKw}kW`);
        action = 'sell';
      } else {
        await updateSellKw(0);
        extraSellKw = 0;
        console.log(`[卖电] feedIn=${amber.feedInPrice.toFixed(1)}¢ < ${planSellMinC}¢，停止卖电`);
        action = 'sell-skip';
      }
    } else {
      // Amber blip：无法获取价格，但仍需检查 SOC 底线
      if (ess.soc !== null && ess.soc <= SOC_OVERNIGHT) {
        await switchToSelfUse();
        await setParam('0xC0BC', 0);
        await setParam('0xC018', 0);
        await setParam('0xC01A', 0);
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
    // 若逆变器还在 Timed 模式，切回 Self-use
    {
      if (ess.reportedMode === 1) {
        await switchToSelfUse();
        logData(db, ess, amber, slot, 'mode-switch-selfuse', { modeFrom: 1, modeTo: 0 });
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

  // 8. 每小时整点打印今日汇总（用 ESS 自带的今日累计，最准确）
  if (syd.mi === 0) {
    console.log(`[今日] 买电:${ess.todayGridBuyKwh?.toFixed(2)}kWh 卖电:${ess.todayGridSellKwh?.toFixed(2)}kWh PV:${ess.todayPvKwh?.toFixed(2)}kWh 充电:${ess.todayChargeKwh?.toFixed(2)}kWh 放电:${ess.todayDischargeKwh?.toFixed(2)}kWh`);
  }

  db.close();
  console.log(`[完成] action=${action}`);
}

main().catch(e => {
  console.error('[ERROR]', e.message, e.stack?.split('\n')[1]);
  process.exit(1);
});
