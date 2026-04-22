#!/usr/bin/env node
/**
 * v2/plan-today.js — Clean-room daily planner
 *
 * 输入：
 *   1. Amber API 价格预测（24h，含 demandWindow）
 *   2. Open-Meteo 太阳辐射预测（solar_forecast 表）
 *   3. 过去14天实际 vs 预测 PV 校准系数
 *   4. 当前 SOC（energy_log 最新记录）
 *
 * 输出：
 *   daily_plan 表（v2 格式）
 *   逆变器充电/卖电时间窗口直接写入
 *   控制台打印计划供人工确认
 *
 * 所有 token 均从环境变量读取，无硬编码。
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https    = require('https');
const path     = require('path');
const Database = require('better-sqlite3');

// ── 环境变量（全部从 .env 读取，绝不硬编码）─────────────────────
const AMBER_TOKEN   = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID;
const ESS_TOKEN     = process.env.ESS_TOKEN;
const ESS_MAC_HEX   = process.env.ESS_MAC_HEX;
const ESS_STATION   = process.env.ESS_STATION_SN;
const GW_PORT       = process.env.OPENCLAW_GATEWAY_PORT || '18789';

if (!AMBER_TOKEN || !AMBER_SITE_ID) throw new Error('Missing AMBER_API_TOKEN or AMBER_SITE_ID in .env');
if (!ESS_TOKEN   || !ESS_MAC_HEX)   throw new Error('Missing ESS_TOKEN or ESS_MAC_HEX in .env');

// ── 系统常量 ──────────────────────────────────────────────────
const BATT_KWH       = 42;      // 电池总容量 kWh
const SOC_MIN        = 0.10;    // 最低 SOC 底线（不放电到这以下）
const SOC_OVERNIGHT  = 0.35;    // 21:00 过夜保留目标（不卖电到这以下）
const SOC_TARGET     = 0.85;    // 充电目标 SOC
// SOC_TARGET_BY 不再硬编码，由运行时动态计算：有DW取DW前1小时，无DW取低电价结束时间
const MAX_CHARGE_KW  = 5.0;     // 逆变器最大充电功率
const MAX_SELL_KW    = 5.0;     // 逆变器最大放电功率
const BREAKER_KW     = 7.7;     // 主断路器限制
const PANEL_KWP      = 4.3;     // 系统峰值功率
const MAX_DAILY_KWH  = 22.0;    // 晴天理论上限（4.3kWp × ~5h 有效日照）
const CHARGE_BUFFER  = 0.5;     // 充电安全余量 kW
const BUY_MAX_C      = 12.0;    // 买电上限（超过不充）
const BUY_MIN_C      = parseFloat(process.env.BUY_THRESHOLD_C || '8.0'); // 买电阈值下限（.env 可覆盖）
const SELL_MIN_MARGIN_C = parseFloat(process.env.SELL_MIN_MARGIN_C || '3.0'); // 卖电最低利润（¢/kWh，相对买入均价）
const SELL_FLOOR_C   = parseFloat(process.env.SELL_FLOOR_C || '9.9');   // 卖电绝对下限（再便宜不卖）
const DB_PATH        = path.join(__dirname, '..', 'data', 'energy.db');

// ── 工具函数 ──────────────────────────────────────────────────
function sydneyNow() {
  const s = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  // "dd/mm/yyyy, hh:mm:ss"
  const [datePart, timePart] = s.split(', ');
  const [dd, mm, yyyy] = datePart.split('/');
  const [hh, mi, ss]   = timePart.split(':').map(Number);
  return { yyyy, mm, dd, hh, mi, ss,
    date: `${yyyy}-${mm}-${dd}`,
    hhmm: `${String(hh).padStart(2,'0')}${String(mi).padStart(2,'0')}` };
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Step 1: 获取 Amber 价格预测 ───────────────────────────────
async function fetchAmberPrices() {
  const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=288`;
  const data = await httpsGet(url, { Authorization: `Bearer ${AMBER_TOKEN}` });
  if (!Array.isArray(data)) throw new Error('Amber API error: ' + JSON.stringify(data).slice(0, 200));
  return data;
}

// 把5分钟 Amber 数据聚合成30分钟槽
function aggregateAmberTo30min(raw, today) {
  const slots = {};
  for (const p of raw) {
    // 只要今天的（Sydney 日期）
    const nemDate = p.nemTime?.substring(0, 10); // "2026-04-20"
    if (nemDate !== today) continue;

    // 取半小时 key：nemTime "2026-04-20T09:30:00+10:00" → "09:30"
    const hh = p.nemTime.substring(11, 13);
    const mm = parseInt(p.nemTime.substring(14, 16)) < 30 ? '00' : '30';
    const key = `${hh}:${mm}`;

    if (!slots[key]) slots[key] = { buySum: 0, feedInSum: 0, count: 0, demandWindow: false, nemTime: p.nemTime };
    if (p.channelType === 'general') { slots[key].buySum += p.perKwh; slots[key].count++; }
    if (p.channelType === 'feedIn')  slots[key].feedInSum += Math.abs(p.perKwh);
    if (p.tariffInformation?.demandWindow) slots[key].demandWindow = true;
  }

  return Object.entries(slots)
    .map(([key, v]) => ({
      key,
      nemTime: v.nemTime,
      buyC:    v.count > 0 ? parseFloat((v.buySum    / v.count).toFixed(2)) : 0,
      feedInC: v.count > 0 ? parseFloat((v.feedInSum / v.count).toFixed(2)) : 0,
      dw:      v.demandWindow,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ── Step 2: 计算 PV 校准系数（过去14天实际/预测比值）────────────
function calcPvCalibration(db) {
  // 从 solar_forecast 取预测，从 energy_log 取实际
  const forecasts = db.prepare(`
    SELECT date, today_kwh_est
    FROM solar_forecast
    WHERE date >= date('now', '-15 days')
    ORDER BY date
  `).all();

  // 用每小时平均值×1h 计算实际发电量（避免5分钟积分的重复计算误差）
  const actuals = db.prepare(`
    WITH hourly AS (
      SELECT 
        date(ts, '+11 hours') as day,
        CAST(strftime('%H', ts, '+11 hours') AS INTEGER) as hour,
        AVG(pv_power) as avg_kw
      FROM energy_log
      WHERE ts >= datetime('now', '-15 days')
        AND pv_power IS NOT NULL
      GROUP BY date(ts, '+11 hours'), CAST(strftime('%H', ts, '+11 hours') AS INTEGER)
    )
    SELECT day, SUM(avg_kw) as actual_kwh
    FROM hourly
    GROUP BY day
  `).all();

  const actualMap = {};
  for (const r of actuals) actualMap[r.day] = r.actual_kwh;

  let ratioSum = 0, ratioCount = 0;
  const calibLog = [];
  for (const f of forecasts) {
    const actual = actualMap[f.date];
    if (actual != null && f.today_kwh_est > 2 && actual > 0.5) {
      const ratio = actual / f.today_kwh_est;
      // 过滤异常值（比值在 0.1–2.0 之间）
      if (ratio >= 0.1 && ratio <= 2.0) {
        ratioSum += ratio;
        ratioCount++;
        calibLog.push(`  ${f.date}: forecast=${f.today_kwh_est.toFixed(1)}kWh actual=${actual.toFixed(1)}kWh ratio=${ratio.toFixed(2)}`);
      }
    }
  }

  const calibFactor = ratioCount > 0 ? ratioSum / ratioCount : 0.6;
  console.log(`\n[PV校准] 过去${ratioCount}天有效数据，校准系数: ${calibFactor.toFixed(3)}`);
  calibLog.forEach(l => console.log(l));
  return Math.min(1.0, Math.max(0.6, calibFactor)); // 限制在 0.6–1.0（下限调高，保守估算）
}

// ── Step 3: 从 solar_forecast 获取今天逐小时 PV 预测 ───────────
function getPvForecast(db, today, calibFactor) {
  const row = db.prepare(`
    SELECT forecast_json FROM solar_forecast WHERE date=? ORDER BY fetched_at DESC LIMIT 1
  `).get(today);

  if (!row) {
    console.log('[PV预测] 无今日预测数据，使用默认值');
    return {};
  }

  const fc = JSON.parse(row.forecast_json);
  const pvByHour = {};

  for (let i = 0; i < fc.time.length; i++) {
    const t = fc.time[i];
    if (!t.startsWith(today)) continue;
    const h = parseInt(t.substring(11, 13));
    const swRad = fc.sw[i] ?? 0;      // W/m²
    const cloud = fc.cloud[i] ?? 0;   // %

    // PV 估算：系统峰值 4.3kWp，辐射转换 + 云量折减
    const cloudFactor = 1 - (cloud / 100) * 0.7;  // 100%云 = 30%辐射
    const pvKw = (swRad / 1000) * 4.3 * cloudFactor * calibFactor;
    pvByHour[h] = parseFloat(Math.max(0, pvKw).toFixed(2));
  }

  return pvByHour;
}

// 把小时 PV 插值成30分钟
function pvAt30min(pvByHour, hh) {
  const h = parseInt(hh);
  return pvByHour[h] ?? 0;
}

// ── Step 4: 估算家庭负载 ──────────────────────────────────────
function homeLoadKw(hour) {
  if (hour >= 6  && hour < 10) return 1.2;   // 早晨（无热水器——单独处理）
  if (hour >= 17 && hour < 21) return 1.5;   // 傍晚高峰
  if (hour >= 21 || hour < 6)  return 0.35;  // 夜间待机
  return 0.6;                                 // 白天普通
}

// ── Step 5: 生成半小时充放电计划 ─────────────────────────────
function buildPlan(slots, pvByHour, currentSoc, hasDW, avgBuyC = 6.5) {
  const targetKwh  = SOC_TARGET * BATT_KWH;               // 目标 kWh（85%）
  const currentKwh = currentSoc / 100 * BATT_KWH;

  // 动态卖电门槛：买入均价 + 利润margin，但不低于绝对下限
  const sellMinC = Math.max(SELL_FLOOR_C, avgBuyC + SELL_MIN_MARGIN_C);
  console.log(`[卖电] 买入均价: ${avgBuyC.toFixed(2)}¢, 卖电门槛: ${sellMinC.toFixed(2)}¢ (margin=${SELL_MIN_MARGIN_C}¢, floor=${SELL_FLOOR_C}¢)`);

  // ── 动态计算充电截止时间 ──────────────────────────────────
  // 有 DW：在 DW 开始前 1 小时停止充电（避免 DW 时段还在充）
  // 无 DW：取今天最后一个低电价时段结束时间（买价 < BUY_MAX_C 的最后一槽）
  let chargeTargetBy; // Sydney 小时（exclusive）
  if (hasDW) {
    const dwSlot = slots.find(s => s.dw);
    const dwHour = dwSlot ? parseInt(dwSlot.key.split(':')[0]) : 17;
    chargeTargetBy = Math.max(9, dwHour - 1); // DW前1小时，最早9点
    console.log(`[充电截止] DW模式，截止 ${chargeTargetBy}:00（DW开始 ${dwHour}:00）`);
  } else {
    // 找今天价格低于 BUY_MAX_C 的最后一个时段
    const cheapSlots = slots.filter(s => s.buyC > 0 && s.buyC < BUY_MAX_C && !s.dw);
    const lastCheap = cheapSlots.length ? cheapSlots[cheapSlots.length - 1] : null;
    const lastH = lastCheap ? parseInt(lastCheap.key.split(':')[0]) + 1 : 15;
    chargeTargetBy = Math.min(lastH, 17); // 最晚17点
    console.log(`[充电截止] 无DW，按低电价截止 ${chargeTargetBy}:00（最后低价槽 ${lastCheap?.key ?? 'none'}）`);
  }

  // ── Phase 1: 倒推需要充多少，选最便宜的槽 ──────────────────
  // 只考虑 chargeTargetBy 前、非 DW 的候选槽，算出每槽可充 kWh
  const nowHour = parseInt(slots[0]?.key?.split(':')[0] ?? '0');  // 当前时间近似（取第一个槽）

  // 估算从现在到第一个候选充电槽之间的电池消耗（防止 SOC 跌到底线）
  const waitSlots = slots.filter(s => {
    const h = parseInt(s.key.split(':')[0]);
    return h < chargeTargetBy && !s.dw && s.buyC > 0 && s.buyC >= BUY_MAX_C;
  });
  // 等待期消耗：每个非充电半小时槽，电池需要供 homeLoad - pv
  const waitConsumptionKwh = waitSlots.reduce((sum, s) => {
    const h  = parseInt(s.key.split(':')[0]);
    const pv = pvAt30min(pvByHour, h);
    const hl = homeLoadKw(h);
    const net = Math.max(0, hl - pv); // 需要电池供的净负荷
    return sum + net * 0.5 * (1 / 0.85); // 放电效率折算
  }, 0);

  const candidateSlots = slots
    .map(s => {
      const h  = parseInt(s.key.split(':')[0]);
      const pv = pvAt30min(pvByHour, h);
      const hl = homeLoadKw(h);
      const gridHeadroom = BREAKER_KW - Math.max(0, hl - pv) - CHARGE_BUFFER;
      const maxChargeKw  = parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom)).toFixed(2));
      const chargeKwhPer = maxChargeKw * 0.5 * 0.95; // 半小时可充入 kWh（含效率）
      return { ...s, h, pv, hl, maxChargeKw, chargeKwhPer };
    })
    .filter(s => s.h < chargeTargetBy && !s.dw && s.maxChargeKw >= 0.5 && s.buyC > 0);

  // 按电价从低到高排，贪心选槽直到充够
  const sortedByPrice = [...candidateSlots].sort((a, b) => a.buyC - b.buyC);
  const chargeKeys = new Set();

  // neededKwh = 目标 - 当前 + 等待期消耗（防止跌底）
  let neededKwh = Math.max(0, targetKwh - currentKwh + waitConsumptionKwh);

  // 还要扣掉 PV 预计贡献（候选槽期间 PV 总发电 × 自用比例）
  const pvContrib = candidateSlots.reduce((s, x) => s + x.pv * 0.5 * 0.9, 0);
  neededKwh = Math.max(0, neededKwh - pvContrib);

  console.log(`[计划] 等待期消耗估算: ${waitConsumptionKwh.toFixed(1)}kWh, PV贡献: ${pvContrib.toFixed(1)}kWh`);

  const buyThreshold_auto = sortedByPrice.length ? sortedByPrice[0].buyC : BUY_MIN_C;
  let accumulated = 0;
  for (const s of sortedByPrice) {
    if (accumulated >= neededKwh) break;
    chargeKeys.add(s.key);
    accumulated += s.chargeKwhPer;
  }

  // ── 补充：把买价 < BUY_MAX_C 且在充电时间窗口内的"早期低价槽"也纳入 ──
  // 防止贪心算法因为"够了"就跳过早上可充的廉价时段，导致 SOC 白白消耗
  // 逻辑：如果一个槽 buyC <= 已选最贵的槽，但时间早（在第一个已选槽之前），也加进来
  const firstChargeKey = [...chargeKeys].sort()[0];
  for (const s of candidateSlots) {
    if (chargeKeys.has(s.key)) continue;
    if (firstChargeKey && s.key < firstChargeKey && s.buyC <= BUY_MAX_C) {
      chargeKeys.add(s.key);
    }
  }

  // 实际买电阈值 = 选中槽里最贵的那个（加保底 BUY_MIN_C）
  const selectedPrices = sortedByPrice.filter(s => chargeKeys.has(s.key)).map(s => s.buyC);
  const buyThreshold = Math.max(BUY_MIN_C, selectedPrices.length ? Math.max(...selectedPrices) : BUY_MIN_C);

  console.log(`\n[计划] 目标: SOC ${currentSoc}% → ${Math.round(SOC_TARGET*100)}% (需充 ${neededKwh.toFixed(1)}kWh, PV贡献 ~${pvContrib.toFixed(1)}kWh)`);
  console.log(`[计划] 选中 ${chargeKeys.size} 个充电槽 | 买电阈值: ${buyThreshold.toFixed(1)}¢ | 卖电门槛: ${sellMinC.toFixed(1)}¢ | DW: ${hasDW}`);

  // ── Phase 2: 顺序扫描生成计划 ──────────────────────────────
  let socKwh = currentKwh;
  const plan = [];

  for (const s of slots) {
    const h   = parseInt(s.key.split(':')[0]);
    const pv  = pvAt30min(pvByHour, h);
    const hl  = homeLoadKw(h);
    const net = hl - pv;

    const gridHeadroom = BREAKER_KW - Math.max(0, net) - CHARGE_BUFFER;
    const maxChargeKw  = parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom)).toFixed(2));

    const usableKwh = Math.max(0, socKwh - SOC_MIN * BATT_KWH);
    // 始终保留过夜电量（35% SOC），限制可卖电量
    const sellableKwh = Math.max(0, socKwh - SOC_OVERNIGHT * BATT_KWH);
    const maxSellKw = parseFloat(Math.min(MAX_SELL_KW, sellableKwh / 0.5).toFixed(2));

    let action = 'self-use', chargeKw = 0, sellKw = 0, reason = '';

    if (s.dw) {
      action = 'standby';
      reason = 'DW';
    } else if (chargeKeys.has(s.key) && socKwh < targetKwh && maxChargeKw >= 0.5) {
      // 选中的充电槽
      action   = 'charge';
      chargeKw = maxChargeKw;
      reason   = `buy=${s.buyC}¢ selected(cheapest)`;
    } else if (s.feedInC >= sellMinC && maxSellKw >= 0.5) {
      // 高价卖电：feedIn > 买入均价+margin，且当前SOC高于过夜底线
      action = 'sell';
      sellKw = maxSellKw;
      reason = `feedIn=${s.feedInC}¢ ≥ ${sellMinC.toFixed(1)}¢`;
    } else {
      action = 'self-use';
      reason = `buy=${s.buyC}¢ feedIn=${s.feedInC}¢`;
    }

    const deltaKwh = action === 'charge'
      ? chargeKw * 0.5 * 0.95
      : action === 'sell'
        ? -sellKw * 0.5
        : (net < 0 ? (-net) * 0.5 * 0.9 : -net * 0.5 * 0.85);

    socKwh = Math.min(BATT_KWH, Math.max(SOC_MIN * BATT_KWH, socKwh + deltaKwh));

    plan.push({
      key:      s.key,
      nemTime:  s.nemTime,
      hour:     h,
      buyC:     s.buyC,
      feedInC:  s.feedInC,
      pvKw:     pv,
      homeLoad: hl,
      dw:       s.dw,
      action,
      chargeKw: parseFloat(chargeKw.toFixed(2)),
      sellKw:   parseFloat(sellKw.toFixed(2)),
      socPct:   Math.round(socKwh / BATT_KWH * 100),
      reason,
    });
  }

  return { plan, buyThreshold, chargeTargetBy, sellMinC };
}

// ── 21:00 过夜电量检阅 ────────────────────────────────────────
function reviewOvernightReserve(plan, db) {
  // 计划中 21:00 的预计 SOC
  const slot21 = plan.find(s => s.key === '21:00') ?? plan.find(s => s.hour === 21);
  const plannedSoc21 = slot21?.socPct ?? null;
  const plannedKwh21 = plannedSoc21 != null ? (plannedSoc21 / 100 * BATT_KWH) : null;

  // 从过去7天 energy_log 里统计 21:00–次日07:00 的实际用电（夜间消耗）
  // ts 字段是 ISO 字符串，用 JS 处理避免 SQLite 版本差异
  let avgNightKwh = null;
  try {
    const cutoff = new Date(Date.now() - 8*86400*1000).toISOString();
    const nightRows = db.prepare(
      'SELECT ts, home_load FROM energy_log WHERE ts > ? AND home_load IS NOT NULL AND home_load > 0'
    ).all(cutoff);
    const nightByDay = {};
    for (const r of nightRows) {
      const d = new Date(r.ts);
      const sydHour = (d.getUTCHours() + 11) % 24;
      const sydDate = new Date(d.getTime() + 11*3600*1000).toISOString().slice(0,10);
      if (sydHour >= 21 || sydHour < 7) {
        nightByDay[sydDate] = (nightByDay[sydDate] || 0) + r.home_load * (5/60);
      }
    }
    // 只取数据充分的天（>5kWh，排除记录不全的天）
    const validNights = Object.values(nightByDay).filter(v => v > 5);
    if (validNights.length > 0) {
      avgNightKwh = parseFloat((validNights.reduce((a,b)=>a+b,0) / validNights.length).toFixed(1));
    }
  } catch {}

  const minNeeded = avgNightKwh ?? (SOC_OVERNIGHT * BATT_KWH);
  const reserve35pct = SOC_OVERNIGHT * BATT_KWH; // 14.7kWh

  let warning = null;
  if (plannedKwh21 != null && avgNightKwh != null) {
    if (plannedKwh21 < avgNightKwh * 1.1) {
      warning = `⚠️ 21:00 预计 ${plannedSoc21}% (${plannedKwh21.toFixed(1)}kWh)，低于近7天夜间用电均值 ${avgNightKwh}kWh × 1.1 = ${(avgNightKwh*1.1).toFixed(1)}kWh，过夜可能不够！`;
    }
  }

  return { plannedSoc21, plannedKwh21, avgNightKwh, reserve35pct, warning };
}

// ── Step 6: 逆变器控制 ────────────────────────────────────────
const ESS_HEADERS = {
  Authorization: ESS_TOKEN,
  lang: 'en', showloading: 'false',
  Referer: 'https://eu.ess-link.com/appViews/appHome',
  'User-Agent': 'Mozilla/5.0',
};

async function setParam(index, data) {
  const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceParam',
    { macHex: ESS_MAC_HEX, index, data }, ESS_HEADERS).catch(() => ({}));
  return r.code === 200;
}
async function setWeekParam(index, data) {
  const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceWeekParam',
    { macHex: ESS_MAC_HEX, index, data }, ESS_HEADERS).catch(() => ({}));
  return r.code === 200;
}
async function setDateParam(index, data) {
  const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceDateOrTimeParam',
    { macHex: ESS_MAC_HEX, index, data }, ESS_HEADERS).catch(() => ({}));
  return r.code === 200;
}

function fmt2(n) { return String(n).padStart(2, '0'); }
function hhmm(h, m = 0) { return fmt2(h) + fmt2(m); }

async function applyToInverter(plan, today) {
  console.log('\n[逆变器] 写入充放电窗口...');

  const chargeSlots = plan.filter(s => s.action === 'charge' && s.key.startsWith(today.substring(0,5) || ''));
  // 修正：用 nemTime 前10位匹配今天
  const todaySlots  = plan.filter(s => s.nemTime?.substring(0,10) === today);
  const chargePlan  = todaySlots.filter(s => s.action === 'charge');
  const sellPlan    = todaySlots.filter(s => s.action === 'sell');

  // 充电窗口
  let chargeStartHHMM = '0000', chargeEndHHMM = '0000', chargeKw = 0;
  if (chargePlan.length > 0) {
    const fh = parseInt(chargePlan[0].nemTime.substring(11,13));
    const fm = parseInt(chargePlan[0].nemTime.substring(14,16));
    const lh = parseInt(chargePlan[chargePlan.length-1].nemTime.substring(11,13));
    const lm = parseInt(chargePlan[chargePlan.length-1].nemTime.substring(14,16));
    const endMins = lh*60+lm+30;
    chargeStartHHMM = hhmm(fh, fm);
    chargeEndHHMM   = hhmm(Math.floor(endMins/60), endMins%60);
    chargeKw = MAX_CHARGE_KW; // 写满功率上限，由 executor 实时动态降速
    console.log(`[逆变器] 充电: ${chargeStartHHMM}–${chargeEndHHMM}, ${chargeKw}kW`);
  } else {
    console.log('[逆变器] 今天无充电计划');
  }

  // 卖电窗口：取充电结束后的第一段卖电，结束时间由可卖电量动态推算
  let sellStartHHMM = '0000', sellEndHHMM = '0000', sellKw = 5;
  if (sellPlan.length > 0) {
    const chargeEndMins = chargeEndHHMM === '0000' ? 0
      : parseInt(chargeEndHHMM.substring(0,2))*60 + parseInt(chargeEndHHMM.substring(2,4));
    const eveningSell = sellPlan.find(s => {
      const sh = parseInt(s.nemTime.substring(11,13));
      const sm = parseInt(s.nemTime.substring(14,16));
      return sh*60+sm >= chargeEndMins;
    }) ?? sellPlan[0];
    const fh = parseInt(eveningSell.nemTime.substring(11,13));
    const fm = parseInt(eveningSell.nemTime.substring(14,16));
    sellStartHHMM = hhmm(fh, fm);

    // 动态推算卖电结束时间：峰值SOC - 过夜保留35% = 可卖电量
    const peakSocKwh = Math.max(...sellPlan.map(s => {
      // 找卖电开始前的最高 SOC
      const idx = todaySlots.findIndex(x => x.key === s.key);
      return idx > 0 ? (todaySlots[idx-1].socPct / 100 * BATT_KWH) : 0;
    }));
    const sellableKwh = Math.max(0, peakSocKwh - SOC_OVERNIGHT * BATT_KWH);
    const sellDurationHours = sellableKwh / MAX_SELL_KW;
    const sellStartMins = fh * 60 + fm;
    const sellEndMins = Math.min(sellStartMins + Math.round(sellDurationHours * 60), 21 * 60); // 最晚21:00
    const sellEndH = Math.floor(sellEndMins / 60);
    const sellEndM = sellEndMins % 60;
    sellEndHHMM = hhmm(sellEndH, sellEndM);

    console.log(`[逆变器] 卖电: ${sellStartHHMM}–${sellEndHHMM}, ${sellKw}kW (可卖${sellableKwh.toFixed(1)}kWh, ${sellDurationHours.toFixed(1)}h)`);
  } else {
    console.log('[逆变器] 今天无卖电计划');
  }

  const yd = new Date(); yd.setDate(yd.getDate()-1);
  const td = new Date(); td.setDate(td.getDate()+1);
  const yesterday = yd.toISOString().substring(0,10);
  const tomorrow  = td.toISOString().substring(0,10);

  const steps = [
    ['mode=Timed(1)',                  () => setParam('0x300C', 1)],
    [`chargeStart=${chargeStartHHMM}`, () => setParam('0xC014', chargeStartHHMM)],
    [`chargeEnd=${chargeEndHHMM}`,     () => setParam('0xC016', chargeEndHHMM)],
    [`chargeKw=${chargeKw}`,           () => setParam('0xC0BA', chargeKw)],
    [`sellStart=${sellStartHHMM}`,     () => setParam('0xC018', sellStartHHMM)],
    [`sellEnd=${sellEndHHMM}`,         () => setParam('0xC01A', sellEndHHMM)],
    [`sellKw=${sellKw}`,               () => setParam('0xC0BC', sellKw)],
    ['discharge=0 (initial)',          () => setParam('0xC0BC', chargePlan.length > 0 ? 0 : sellKw)],
    ['otherMode=0',                    () => setParam('0x314E', 0)],
    ['weekdays=all',                   () => setWeekParam('0xC0B4', [1,2,3,4,5,6,0])],
    [`startDate=${yesterday}`,         () => setDateParam('0xC0B6', yesterday)],
    [`endDate=${tomorrow}`,            () => setDateParam('0xC0B8', tomorrow)],
  ];

  let allOk = true;
  for (const [label, fn] of steps) {
    const ok = await fn();
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) allOk = false;
    await new Promise(r => setTimeout(r, 350));
  }
  return allOk;
}

// ── Step 7: 保存到 DB ─────────────────────────────────────────
function savePlan(db, today, plan, meta) {
  db.prepare('UPDATE daily_plan SET is_active=0 WHERE date=? AND is_active=1').run(today);
  const lastVer = db.prepare('SELECT MAX(version) as v FROM daily_plan WHERE date=?').get(today);
  const version = (lastVer?.v ?? 0) + 1;

  // 找充电窗口摘要
  const chargeSlots = plan.filter(s => s.action === 'charge');
  const chargeWindows = chargeSlots.length > 0 ? [{
    startHour: parseInt(chargeSlots[0].key),
    endHour:   parseInt(chargeSlots[chargeSlots.length-1].key) + 1,
    avgBuyC:   parseFloat((chargeSlots.reduce((s,x)=>s+x.buyC,0)/chargeSlots.length).toFixed(1)),
  }] : [];

  db.prepare(`
    INSERT INTO daily_plan
      (date, version, generated_at, source, created_by, soc_at_gen,
       has_demand_window, charge_cutoff_hour,
       pv_forecast_kwh, pv_peak_kw,
       charge_windows_json, intervals_json, notes,
       buy_threshold_c, sell_min_c, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    today, version, new Date().toISOString(), 'v2-rules', 'v2/plan-today.js',
    meta.currentSocPct,
    meta.hasDW ? 1 : 0,
    meta.chargeTargetBy,
    parseFloat(meta.pvForecastKwh.toFixed(2)),
    parseFloat(meta.pvPeakKw.toFixed(2)),
    JSON.stringify(chargeWindows),
    JSON.stringify(plan),
    JSON.stringify({ buyThreshold: meta.buyThreshold, sellMinC: meta.sellMinC, calibFactor: meta.calibFactor }),
    parseFloat(meta.buyThreshold.toFixed(2)),
    meta.sellMinC,
  );

  console.log(`\n✅ 计划 v${version} 已存入 DB (source=v2-rules)`);
  return version;
}

// ── Step 8: 打印计划 ──────────────────────────────────────────
function printPlan(plan, currentSocPct, today) {
  const lines = [
    `\n🔋 充放电计划（v2）— ${today}  当前SOC: ${currentSocPct}%`,
    `时间   动作       充电  卖电   买¢    卖¢   SOC   PV`,
    `${'─'.repeat(60)}`,
  ];

  let prevAction = null;
  for (const s of plan) {
    const action = {
      'charge':   '⚡充电',
      'sell':     '💰卖电',
      'self-use': '🔋自用',
      'standby':  '⏸待机',
    }[s.action] ?? s.action;

    const chKw = s.chargeKw > 0 ? `${s.chargeKw.toFixed(1)}kW` : '    -';
    const slKw = s.sellKw   > 0 ? `${s.sellKw.toFixed(1)}kW`   : '    -';
    const dw   = s.dw ? '⚠️' : '';

    if (prevAction && prevAction !== s.action) lines.push('');
    lines.push(
      `${s.key}  ${action.padEnd(6)} ${chKw.padStart(6)} ${slKw.padStart(6)}  ${String(s.buyC.toFixed(1)).padStart(5)}¢ ${String(s.feedInC.toFixed(1)).padStart(5)}¢  ${String(s.socPct).padStart(3)}%  ${s.pvKw.toFixed(1)}kW ${dw}`
    );
    prevAction = s.action;
  }

  const last = plan[plan.length-1];
  lines.push(`${'─'.repeat(60)}`);
  lines.push(`收盘预计: SOC ${last?.socPct ?? '?'}% (${((last?.socPct??0)/100*BATT_KWH).toFixed(1)}kWh)`);

  return lines.join('\n');
}

// ── 发送 WhatsApp ─────────────────────────────────────────────
async function sendWhatsApp(message) {
  try {
    const body = JSON.stringify({ message });
    await new Promise((resolve) => {
      const http = require('http');
      const req = http.request({
        hostname: 'localhost', port: GW_PORT, path: '/send', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(); });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
  } catch { /* silent */ }
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  const syd   = sydneyNow();
  const today = syd.date;
  console.log(`\n===== v2/plan-today.js  ${today} ${syd.hh}:${String(syd.mi).padStart(2,'0')} Sydney =====`);

  const db = new Database(DB_PATH);

  // 1. 当前 SOC
  const latest = db.prepare('SELECT soc FROM energy_log ORDER BY ts DESC LIMIT 1').get();
  const currentSocPct = latest?.soc ?? 50;
  console.log(`[SOC] 当前: ${currentSocPct}%`);

  // 2. PV 校准系数
  const calibFactor = calcPvCalibration(db);

  // 3. 今日 PV 预测（按小时）
  const pvByHour = getPvForecast(db, today, calibFactor);
  const pvForecastKwh = Math.min(MAX_DAILY_KWH, Object.values(pvByHour).reduce((s, v) => s + v, 0));
  const pvPeakKw = Math.max(...Object.values(pvByHour), 0);
  console.log(`[PV预测] 今日预计: ${pvForecastKwh.toFixed(1)}kWh, 峰值: ${pvPeakKw.toFixed(2)}kW`);

  // 4. Amber 价格预测
  console.log('\n[Amber] 拉取价格预测...');
  const rawAmber = await fetchAmberPrices();
  const slots    = aggregateAmberTo30min(rawAmber, today);
  const hasDW    = slots.some(s => s.dw);
  console.log(`[Amber] ${slots.length} 个半小时槽, DW: ${hasDW}`);

  // 5. 生成计划（先用默认avgBuyC预估，生成后用实际充电槽均价重算卖电门槛）
  // 先做一次 dry-run 算充电槽 → 得到真实买入均价 → 正式生成
  const dryRun = buildPlan(slots, pvByHour, currentSocPct, hasDW, BUY_MIN_C + 1);
  const dryChargeSlots = dryRun.plan.filter(s => s.action === 'charge');
  const realAvgBuyC = dryChargeSlots.length > 0
    ? dryChargeSlots.reduce((s, x) => s + x.buyC, 0) / dryChargeSlots.length
    : BUY_MIN_C + 1;
  console.log(`[买入均价] 充电槽均价: ${realAvgBuyC.toFixed(2)}¢ (${dryChargeSlots.length}槽)`);

  const { plan, buyThreshold, chargeTargetBy, sellMinC } = buildPlan(slots, pvByHour, currentSocPct, hasDW, realAvgBuyC);

  // 6. 打印
  const report = printPlan(plan, currentSocPct, today);
  console.log(report);

  // 6b. 21:00 过夜电量检阅
  const overnight = reviewOvernightReserve(plan, db);
  const overnightLine = overnight.warning
    ? overnight.warning
    : `✅ 21:00 预计 ${overnight.plannedSoc21}% (${overnight.plannedKwh21?.toFixed(1)}kWh)，近7天夜间均耗 ${overnight.avgNightKwh ?? '?'}kWh，过夜充足`;
  console.log('\n[过夜检阅] ' + overnightLine);

  // 7. 存 DB
  const version = savePlan(db, today, plan, {
    currentSocPct, hasDW, pvForecastKwh, pvPeakKw, calibFactor, buyThreshold, chargeTargetBy, sellMinC
  });
  db.close();

  // 8. 写逆变器
  await applyToInverter(plan, today);

  // 9. 发 WhatsApp
  await sendWhatsApp(report + '\n\n' + overnightLine);
  console.log('\n[完成] 计划已发送到 WhatsApp');
}

main().catch(async e => {
  console.error('[ERROR]', e.message);
  try {
    const http = require('http');
    const msg = `⚠️ v2/plan-today.js 失败：${e.message}`;
    const body = JSON.stringify({ message: msg });
    await new Promise(resolve => {
      const req = http.request({ hostname:'localhost', port:GW_PORT, path:'/send', method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} },
        res=>{res.resume();resolve();});
      req.on('error',()=>resolve()); req.write(body); req.end();
    });
  } catch {}
  process.exit(1);
});
