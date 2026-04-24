#!/usr/bin/env node
/**
 * v2/plan-today.js — Clean-room daily planner
 *
 * 输入：
 *   1. Amber API 价格预测（24h，含 demandWindow）
 *   2. Open-Meteo 太阳辐射预测（内嵌 fetchSolarForecast，自动更新 solar_forecast 表）
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
const SOC_OVERNIGHT  = 0.35;    // 电池绝对底线（逆变器保护，不放电到这以下）
const SOC_SELL_FLOOR = 0.50;    // 卖电保守底线（21:00保留50%=21kWh，数据积累后再调整）
// 充电目标：电网必须充到 85%，保证晚上有足够电量
// 下午 PV 是额外收益（继续充或卖电），不依赖 PV 来补缺口
const SOC_TARGET     = 0.85;    // 电网充电目标（必须达到）
const GRID_CHARGE_TARGET = 0.85; // 与 SOC_TARGET 一致，电网负责充满
const MAX_CHARGE_KW  = 5.0;     // 逆变器最大充电功率
const MAX_SELL_KW    = 5.0;     // 逆变器最大放电功率
const BREAKER_KW     = 7.7;     // 主断路器限制
const PANEL_KWP      = 4.3;     // 系统峰值功率
const MAX_DAILY_KWH  = 20.0;    // 晴天实际上限（实测约15kWh）
const CHARGE_BUFFER  = 0.5;     // 充电安全余量 kW
const HW_LOAD_KW     = 5.0;     // 主热水器运行时附加负荷（单台约5kW）
const PV_SCALE       = 0.0032;  // 实测换算系数：kW per W/m²（97样本均值，校准后直接用）
const BUY_MAX_C      = 14.0;    // 买电上限（超过不充）
const BUY_MIN_C      = parseFloat(process.env.BUY_THRESHOLD_C || '8.0');
const SELL_MIN_MARGIN_C = parseFloat(process.env.SELL_MIN_MARGIN_C || '3.0');
const SELL_FLOOR_C   = parseFloat(process.env.SELL_FLOOR_C || '9.9');
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

// ── Step 1b: 获取 Solar Forecast（内嵌，自动写 solar_forecast 表）──
const SOLAR_LATITUDE  = -33.87;
const SOLAR_LONGITUDE = 151.21;
const SOLAR_TIMEZONE  = 'Australia/Sydney';

async function fetchSolarForecast(db, today) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${SOLAR_LATITUDE}&longitude=${SOLAR_LONGITUDE}` +
      `&hourly=shortwave_radiation,cloud_cover` +
      `&timezone=${encodeURIComponent(SOLAR_TIMEZONE)}&forecast_days=3&models=best_match`;

    const data = await httpsGet(url);
    if (!data?.hourly?.time) throw new Error('Invalid Open-Meteo response');
    const hourly = data.hourly;

    // 存入 solar_forecast 表（ON CONFLICT 更新）
    try { db.prepare('ALTER TABLE solar_forecast ADD COLUMN forecast_json TEXT').run(); } catch {}
    db.prepare(`
      INSERT INTO solar_forecast (date, fetched_at, forecast_json, today_kwh_est, tomorrow_kwh_est, today_peak_wm2, tomorrow_peak_wm2, today_cloud_avg, tomorrow_cloud_avg)
      VALUES (@date, @fetchedAt, @json, 0, 0, 0, 0, 0, 0)
      ON CONFLICT(date) DO UPDATE SET fetched_at=@fetchedAt, forecast_json=@json
    `).run({
      date: today,
      fetchedAt: new Date().toISOString(),
      json: JSON.stringify({ time: hourly.time, sw: hourly.shortwave_radiation, cloud: hourly.cloud_cover }),
    });

    // 统计今天峰值和云量用于日志
    let peakWm2 = 0, cloudSum = 0, cloudCount = 0;
    hourly.time.forEach((t, i) => {
      if (!t.startsWith(today)) return;
      const h = parseInt(t.substring(11, 13));
      if (h < 6 || h > 20) return;
      peakWm2 = Math.max(peakWm2, hourly.shortwave_radiation[i] ?? 0);
      cloudSum += hourly.cloud_cover[i] ?? 0;
      cloudCount++;
    });
    console.log(`[solar-forecast] 已更新 DB ✓ 峰值辐射: ${peakWm2}W/m²，云量均值: ${cloudCount > 0 ? (cloudSum/cloudCount).toFixed(0) : '?'}%`);
  } catch(e) {
    console.warn(`[solar-forecast] 获取失败: ${e.message}，使用 DB 缓存`);
  }
}

// ── Step 1: 获取 Amber 价格预测（含重试，最多3次）────────────────
async function fetchAmberPrices() {
  const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=288`;
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const data = await httpsGet(url, { Authorization: `Bearer ${AMBER_TOKEN}` });
    if (Array.isArray(data)) return data;
    const msg = JSON.stringify(data).slice(0, 200);
    if (attempt < MAX_RETRIES) {
      const wait = attempt * 30000; // 30s, 60s
      console.warn(`[Amber] 第${attempt}次失败（${msg}），${wait/1000}s 后重试...`);
      await new Promise(r => setTimeout(r, wait));
    } else {
      throw new Error('Amber API error: ' + msg);
    }
  }
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
  return Math.min(1.0, Math.max(0.25, calibFactor)); // 限制在 0.25–1.0（实测历史均值约0.3）
}

// ── Step 3: 从 solar_forecast 获取今天逐小时 PV 预测 ───────────
// 使用实测换算系数 PV_SCALE（0.0032 kW per W/m²），不再需要 calibFactor 双重折减
function getPvForecast(db, today) {
  const row = db.prepare(`
    SELECT forecast_json FROM solar_forecast WHERE date=? ORDER BY fetched_at DESC LIMIT 1
  `).get(today);

  if (!row) {
    console.log('[PV预测] 无今日预测数据，PV按0处理');
    return {};
  }

  const fc = JSON.parse(row.forecast_json);
  const pvByHour = {};

  for (let i = 0; i < fc.time.length; i++) {
    const t = fc.time[i];
    if (!t.startsWith(today)) continue;
    const h = parseInt(t.substring(11, 13));
    const swRad = fc.sw[i] ?? 0;
    const cloud = fc.cloud[i] ?? 0;
    const cloudFactor = 1 - (cloud / 100) * 0.7;
    const pvKw = swRad * PV_SCALE * cloudFactor;
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
function buildPlan(slots, pvByHour, currentSoc, hasDW, avgBuyC = 6.5, nightReserveKwh = null, hwWindow = null) {
  const targetKwh  = SOC_TARGET * BATT_KWH;               // 目标 kWh（85%）
  const currentKwh = currentSoc / 100 * BATT_KWH;

  // 热水器运行时段 set（key格式 "HH:MM"）
  const hwKeys = new Set();
  if (hwWindow) {
    const [sh, sm] = hwWindow.startKey.split(':').map(Number);
    const [eh, em] = hwWindow.endKey.split(':').map(Number);
    let mins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    while (mins < endMins) {
      hwKeys.add(`${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`);
      mins += 30;
    }
  }

  // ── 卖电门槛 ──
  const sellMinC = Math.max(SELL_FLOOR_C, avgBuyC + SELL_MIN_MARGIN_C);
  console.log(`[卖电门槛] 买入均价: ${avgBuyC.toFixed(2)}¢ + ${SELL_MIN_MARGIN_C}¢ = ${sellMinC.toFixed(2)}¢ (floor=${SELL_FLOOR_C}¢)`);

  // ── 充电截止时间 ──
  // 有 DW：DW 开始前 1 小时；无 DW：PV 峰值前结束（给下午 PV 充电留空间）
  let gridChargeEndHour;
  if (hasDW) {
    const dwSlot = slots.find(s => s.dw);
    const dwHour = dwSlot ? parseInt(dwSlot.key.split(':')[0]) : 17;
    gridChargeEndHour = Math.max(9, dwHour - 1);
    console.log(`[充电截止] DW模式，截止 ${gridChargeEndHour}:00`);
  } else {
    // 电网充电在 PV 峰值前结束（一般 12:00 前），让下午 PV 自然充满
    // 取 08:00–12:00 里最后的低价槽 +30min
    // 无 DW：低价时段充电，上限到 17:00 前（让出晚高峰卖电）
    const cheapSlots = slots.filter(s => {
      const h = parseInt(s.key.split(':')[0]);
      return h >= 7 && h < 17 && !s.dw && s.buyC > 0 && s.buyC < BUY_MAX_C;
    });
    const lastCheap = cheapSlots.length ? cheapSlots[cheapSlots.length - 1] : null;
    const lastH = lastCheap ? parseInt(lastCheap.key.split(':')[0]) + 1 : 15;
    gridChargeEndHour = Math.min(lastH, 17); // 最晚 17:00（晚高峰前停止充电）
    console.log(`[充电截止] 无DW，电网充电截止 ${gridChargeEndHour}:00（最后低价槽 ${lastCheap?.key ?? 'none'}）`);
  }

  // 电网充电目标 = 85%，必须由电网保证，PV 是额外收益
  const gridTargetKwh = GRID_CHARGE_TARGET * BATT_KWH;  // 35.7kWh
  console.log(`[电网目标] ${Math.round(GRID_CHARGE_TARGET*100)}% (${gridTargetKwh.toFixed(1)}kWh) — 电网必须达到，PV另算`);

  // ── Phase 2: 选最便宜的槽充到 gridTargetKwh ────────────────
  const candidateSlots = slots
    .map(s => {
      const h  = parseInt(s.key.split(':')[0]);
      const pv = pvAt30min(pvByHour, h);
      const hl = homeLoadKw(h);
      const effectiveLoad = hwKeys.has(s.key) ? hl + HW_LOAD_KW : hl;
      const gridHeadroom = BREAKER_KW - Math.max(0, effectiveLoad - pv) - CHARGE_BUFFER;
      const maxChargeKw  = parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom)).toFixed(2));
      const chargeKwhPer = maxChargeKw * 0.5 * 0.95;
      return { ...s, h, pv, hl, maxChargeKw, chargeKwhPer };
    })
    .filter(s => s.h < gridChargeEndHour && !s.dw && s.maxChargeKw >= 0.5 && s.buyC > 0 && s.buyC < BUY_MAX_C);

  // 早晨消耗估算（等待第一个充电槽期间的自放）
  const nowHour = parseInt(slots[0]?.key?.split(':')[0] ?? '0');
  const waitConsumptionKwh = slots.filter(s => {
    const h = parseInt(s.key.split(':')[0]);
    return h < gridChargeEndHour && !s.dw && s.buyC >= BUY_MAX_C;
  }).reduce((sum, s) => {
    const h = parseInt(s.key.split(':')[0]);
    const net = Math.max(0, homeLoadKw(h) - pvAt30min(pvByHour, h));
    return sum + net * 0.5 * (1 / 0.85);
  }, 0);

  const neededKwh = Math.max(0, gridTargetKwh - currentKwh + waitConsumptionKwh);
  console.log(`[需充] ${neededKwh.toFixed(1)}kWh（目标${gridTargetKwh.toFixed(1)}kWh - 当前${currentKwh.toFixed(1)}kWh + 等待消耗${waitConsumptionKwh.toFixed(1)}kWh）`);

  const sortedByPrice = [...candidateSlots].sort((a, b) => a.buyC - b.buyC);
  const chargeKeys = new Set();
  let accumulated = 0;
  for (const s of sortedByPrice) {
    if (accumulated >= neededKwh) break;
    chargeKeys.add(s.key);
    accumulated += s.chargeKwhPer;
  }

  // 填满首尾充电槽之间的空隙（避免中间出现自用空洞）
  const sortedChargeKeys = [...chargeKeys].sort();
  const firstChargeKey = sortedChargeKeys[0];
  const lastChargeKey  = sortedChargeKeys[sortedChargeKeys.length - 1];
  for (const s of candidateSlots) {
    if (chargeKeys.has(s.key)) continue;
    if (firstChargeKey && lastChargeKey && s.key >= firstChargeKey && s.key <= lastChargeKey) {
      chargeKeys.add(s.key);
    }
  }

  // SOC 偏低时，把早晨所有低价槽也纳入（不能等到中午才开始充）
  // 逻辑：如果现在 SOC < 65%，7:00–12:00 之间 buyC < BUY_MAX_C 的候选槽全充
  if (currentSoc < 65) {
    for (const s of candidateSlots) {
      if (chargeKeys.has(s.key)) continue;
      if (s.h >= 7 && s.h < 12) chargeKeys.add(s.key);
    }
    const newFirst = [...chargeKeys].sort()[0];
    console.log(`[低SOC扩充] SOC=${currentSoc}% < 65%，早晨充电提前到 ${newFirst ?? '-'}`);
  }

  const selectedPrices = [...candidateSlots].filter(s => chargeKeys.has(s.key)).map(s => s.buyC);
  const buyThreshold = Math.max(BUY_MIN_C, selectedPrices.length ? Math.max(...selectedPrices) : BUY_MIN_C);

  console.log(`\n[电网充电] 选中 ${chargeKeys.size} 槽 (${firstChargeKey ?? '-'}–${lastChargeKey ?? '-'}) | 最贵: ${buyThreshold.toFixed(1)}¢ | 卖电门槛: ${sellMinC.toFixed(1)}¢`);

  // ── Phase 3: 顺序扫描生成完整计划（含卖电）──────────────────
  let socKwh = currentKwh;
  const plan = [];

  for (const s of slots) {
    const h   = parseInt(s.key.split(':')[0]);
    const pv  = pvAt30min(pvByHour, h);
    const hl  = homeLoadKw(h);
    const net = hl - pv;

    // 充电功率：热水器时段降低（避免超断路器）
    const hwExtra = hwKeys.has(s.key) ? HW_LOAD_KW : 0;
    const maxChargeKw = parseFloat(Math.min(MAX_CHARGE_KW,
      Math.max(0, BREAKER_KW - Math.max(0, net + hwExtra) - CHARGE_BUFFER)
    ).toFixed(2));

    // 卖电：动态可卖量 = 当前SOC - 过夜保留底线
    const overnightFloorKwh = nightReserveKwh
      ? Math.max(SOC_SELL_FLOOR * BATT_KWH, nightReserveKwh * 1.2)
      : SOC_SELL_FLOOR * BATT_KWH;
    const sellableKwh = Math.max(0, socKwh - overnightFloorKwh);
    const maxSellKw = parseFloat(Math.min(MAX_SELL_KW, sellableKwh / 0.5).toFixed(2));

    let action = 'self-use', chargeKw = 0, sellKw = 0, reason = '';

    if (s.dw) {
      action = 'standby';
      reason = 'DW';
    } else if (chargeKeys.has(s.key) && socKwh < gridTargetKwh && maxChargeKw >= 0.5) {
      // 电网充电槽（充到电网目标，剩余由PV填）
      action   = 'charge';
      chargeKw = maxChargeKw;
      const hwNote = hwKeys.has(s.key) ? ' +HW↓' : '';
      reason   = `buy=${s.buyC}¢ grid-charge${hwNote}`;
    } else if (s.feedInC >= sellMinC && maxSellKw >= 0.5 && h >= 16) {
      // 晚间高价卖电（16:00以后，feedIn够高，有足够SOC）
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
      key: s.key, nemTime: s.nemTime, hour: h,
      buyC: s.buyC, feedInC: s.feedInC, pvKw: pv, homeLoad: hl, dw: s.dw,
      action, chargeKw: parseFloat(chargeKw.toFixed(2)), sellKw: parseFloat(sellKw.toFixed(2)),
      socPct: Math.round(socKwh / BATT_KWH * 100), reason,
    });
  }

  return { plan, buyThreshold, chargeTargetBy: gridChargeEndHour, sellMinC };
}

// ── 21:00 过夜电量检阅 ────────────────────────────────────────
function calcAvgNightKwh(db) {
  // 过去7天 21:00–次日07:00 实际用电均值
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
    const validNights = Object.values(nightByDay).filter(v => v > 5);
    if (validNights.length > 0) {
      return parseFloat((validNights.reduce((a,b)=>a+b,0) / validNights.length).toFixed(1));
    }
  } catch {}
  return null;
}

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

  // 充电窗口（用槽 key "HH:MM" 而不是 nemTime，避免 5min 数据偏移导致时间不准）
  let chargeStartHHMM = '0000', chargeEndHHMM = '0000', chargeKw = 0;
  if (chargePlan.length > 0) {
    const fKey = chargePlan[0].key;                            // "08:30"
    const lKey = chargePlan[chargePlan.length-1].key;          // "16:30"
    const fh = parseInt(fKey.substring(0,2)), fm = parseInt(fKey.substring(3,5));
    const lh = parseInt(lKey.substring(0,2)), lm = parseInt(lKey.substring(3,5));
    // chargeEnd = 最后充电槽的结束时间（槽开始 + 30min）
    // 逆变器在 chargeEnd 时刻停止充电，所以最后一个槽能跑完整 30 分钟
    const endMins = lh*60+lm+30;
    chargeStartHHMM = hhmm(fh, fm);
    chargeEndHHMM   = hhmm(Math.floor(endMins/60), endMins%60);
    chargeKw = MAX_CHARGE_KW;
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
      const sh = parseInt(s.key.substring(0,2));
      const sm = parseInt(s.key.substring(3,5));
      return sh*60+sm >= chargeEndMins;
    }) ?? sellPlan[0];
    const fh = parseInt(eveningSell.key.substring(0,2));
    const fm = parseInt(eveningSell.key.substring(3,5));
    sellStartHHMM = hhmm(fh, fm);

    // 动态推算卖电结束时间：峰值SOC - 过夜保留35% = 可卖电量
    const peakSocKwh = Math.max(...sellPlan.map(s => {
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

  // 用 Sydney 日期计算（避免 UTC 偏差导致日期错位）
  const sydNowMs = Date.now() + 11*3600*1000; // UTC+11
  const ydMs = sydNowMs - 86400*1000;
  const tdMs = sydNowMs + 86400*1000;
  const yesterday = new Date(ydMs).toISOString().slice(0,10);
  const tomorrow  = new Date(tdMs).toISOString().slice(0,10);

  const steps = [
    ['mode=Timed(1)',                  () => setParam('0x300C', 1)],
    [`chargeStart=${chargeStartHHMM}`, () => setParam('0xC014', chargeStartHHMM)],
    [`chargeEnd=${chargeEndHHMM}`,     () => setParam('0xC016', chargeEndHHMM)],
    [`chargeKw=${chargeKw}`,           () => setParam('0xC0BA', chargeKw)],
    [`sellStart=${sellStartHHMM}`,     () => setParam('0xC018', sellStartHHMM)],
    [`sellEnd=${sellEndHHMM}`,         () => setParam('0xC01A', sellEndHHMM)],
    // 0xC0BC = 放电/卖电功率：始终写入计划的 sellKw（executor 会在充电时段保护，不会误放电）
    [`sellKw(0xC0BC)=${sellKw}`, () => setParam('0xC0BC', sellKw)],
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
  // 确保 hw_window_json 列存在（向后兼容旧表结构）
  try {
    db.prepare('ALTER TABLE daily_plan ADD COLUMN hw_window_json TEXT').run();
  } catch {}

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
       buy_threshold_c, sell_min_c, hw_window_json, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
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
    meta.hwWindow ? JSON.stringify(meta.hwWindow) : null,
  );

  console.log(`\n✅ 计划 v${version} 已存入 DB (source=v2-rules)`);
  return version;
}

// ── 热水器计划：找今天最便宜的连续2小时窗口 ───────────────────
// 主热水器每天必须在最低电价时段运行2小时（晚上要有热水用）
// 约束：只在 06:00–14:00 之间，非 DW 时段，连续4个半小时槽
function calcHotWaterWindow(slots) {
  // 只考虑 06:00–14:00 之间、非 DW 的候选槽
  const candidates = slots.filter(s => {
    const h = parseInt(s.key.split(':')[0]);
    return h >= 6 && h < 14 && !s.dw && s.buyC > 0;
  });

  if (candidates.length < 4) {
    // 候选不足4槽，退而求其次取最便宜的连续段
    if (candidates.length === 0) return null;
    const start = candidates[0];
    const end   = candidates[Math.min(3, candidates.length-1)];
    const avg   = candidates.slice(0, 4).reduce((s, x) => s + x.buyC, 0) / Math.min(4, candidates.length);
    return { startKey: start.key, endKey: end.key, avgBuyC: parseFloat(avg.toFixed(2)) };
  }

  // 滑动窗口：找连续4槽（2小时）平均电价最低的组合
  let bestAvg = Infinity, bestIdx = 0;
  for (let i = 0; i <= candidates.length - 4; i++) {
    const avg = (candidates[i].buyC + candidates[i+1].buyC + candidates[i+2].buyC + candidates[i+3].buyC) / 4;
    if (avg < bestAvg) { bestAvg = avg; bestIdx = i; }
  }

  const startKey = candidates[bestIdx].key;
  const endSlot  = candidates[bestIdx + 3];
  // 结束时间 = 最后一槽 + 30min
  const [eh, em] = endSlot.key.split(':').map(Number);
  const endMins  = eh * 60 + em + 30;
  const endKey   = `${String(Math.floor(endMins/60)).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`;

  return { startKey, endKey, avgBuyC: parseFloat(bestAvg.toFixed(2)) };
}

// ── Step 8: 打印计划 ──────────────────────────────────────────
function printPlan(plan, currentSocPct, today, hwWindow) {
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

  // 热水器计划
  if (hwWindow) {
    lines.push('');
    lines.push(`🚿 主热水器: ${hwWindow.startKey}–${hwWindow.endKey} 开2小时（均价 ${hwWindow.avgBuyC}¢）`);
  } else {
    lines.push('');
    lines.push('🚿 主热水器: 今日无合适低价窗口，请手动安排');
  }

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

  // 2. Solar forecast（先取，确保 DB 里有今日数据）
  await fetchSolarForecast(db, today);

  // 3. 今日 PV 预测（直接用实测换算系数 PV_SCALE=0.0032，不再需要校准）
  const pvByHour = getPvForecast(db, today);
  const pvForecastKwh = Math.min(MAX_DAILY_KWH, Object.values(pvByHour).reduce((s, v) => s + v, 0));
  const pvPeakKw = Math.max(...Object.values(pvByHour), 0);
  console.log(`[PV预测] 今日预计: ${pvForecastKwh.toFixed(1)}kWh, 峰值: ${pvPeakKw.toFixed(2)}kW (scale=${PV_SCALE})`);

  // 4. Amber 价格预测
  console.log('\n[Amber] 拉取价格预测...');
  const rawAmber = await fetchAmberPrices();
  const slots    = aggregateAmberTo30min(rawAmber, today);
  const hasDW    = slots.some(s => s.dw);
  console.log(`[Amber] ${slots.length} 个半小时槽, DW: ${hasDW}`);

  // 5a. 热水器计划（先算，buildPlan 需要知道热水器时段）
  const hwWindow = calcHotWaterWindow(slots);
  if (hwWindow) {
    console.log(`\n[热水器] 主热水器计划: ${hwWindow.startKey}–${hwWindow.endKey}，均价 ${hwWindow.avgBuyC}¢`);
  } else {
    console.log('[热水器] 无合适窗口');
  }

  // 5b. 生成计划（dry-run 先算买入均价，再正式生成含卖电）
  const dryRun = buildPlan(slots, pvByHour, currentSocPct, hasDW, BUY_MIN_C + 1, null, hwWindow);
  const dryChargeSlots = dryRun.plan.filter(s => s.action === 'charge');
  const realAvgBuyC = dryChargeSlots.length > 0
    ? dryChargeSlots.reduce((s, x) => s + x.buyC, 0) / dryChargeSlots.length
    : BUY_MIN_C + 1;
  console.log(`[买入均价] ${realAvgBuyC.toFixed(2)}¢ (${dryChargeSlots.length}槽) → 卖电门槛 = max(${SELL_FLOOR_C}¢, ${realAvgBuyC.toFixed(2)}+${SELL_MIN_MARGIN_C}¢)`);

  const avgNightKwh = calcAvgNightKwh(db);
  console.log(`[过夜用电] 近7天均值: ${avgNightKwh ?? '无数据'}kWh，保底: ${avgNightKwh ? (avgNightKwh*1.1).toFixed(1) : (SOC_OVERNIGHT*BATT_KWH).toFixed(1)}kWh`);

  const { plan, buyThreshold, chargeTargetBy, sellMinC } = buildPlan(slots, pvByHour, currentSocPct, hasDW, realAvgBuyC, avgNightKwh, hwWindow);

  // 6. 打印
  const report = printPlan(plan, currentSocPct, today, hwWindow);
  console.log(report);

  // 6b. 21:00 过夜电量检阅
  const overnight = reviewOvernightReserve(plan, db);
  const overnightLine = overnight.warning
    ? overnight.warning
    : `✅ 21:00 预计 ${overnight.plannedSoc21}% (${overnight.plannedKwh21?.toFixed(1)}kWh)，近7天夜间均耗 ${overnight.avgNightKwh ?? '?'}kWh，过夜充足`;
  console.log('\n[过夜检阅] ' + overnightLine);

  // 7. 存 DB（先拿旧计划的窗口用于对比）
  const prevPlan = db.prepare("SELECT charge_windows_json, intervals_json FROM daily_plan WHERE date=? AND is_active=1").get(today);
  const prevChargeW = prevPlan?.charge_windows_json ?? '[]';
  const prevSellSlots = prevPlan ? JSON.parse(prevPlan.intervals_json ?? '[]').filter(s=>s.action==='sell').map(s=>s.key).join(',') : '';
  const prevChargeSlots = prevPlan ? JSON.parse(prevPlan.intervals_json ?? '[]').filter(s=>s.action==='charge').map(s=>s.key).join(',') : '';

  const version = savePlan(db, today, plan, {
    currentSocPct, hasDW, pvForecastKwh, pvPeakKw, calibFactor: PV_SCALE, buyThreshold, chargeTargetBy, sellMinC, hwWindow
  });
  db.close();

  // 8. 写逆变器
  await applyToInverter(plan, today);

  // 9. 只在充电/卖电窗口有变化时才发 WhatsApp（避免每30分钟刷屏）
  const newChargeSlots = plan.filter(s=>s.action==='charge').map(s=>s.key).join(',');
  const newSellSlots   = plan.filter(s=>s.action==='sell').map(s=>s.key).join(',');
  const windowChanged  = newChargeSlots !== prevChargeSlots || newSellSlots !== prevSellSlots;

  if (windowChanged) {
    const hwLine = hwWindow
      ? `\n🚿 主热水器提醒: ${hwWindow.startKey} 开，${hwWindow.endKey} 关（均价 ${hwWindow.avgBuyC}¢）`
      : '';
    await sendWhatsApp(report + '\n\n' + overnightLine + hwLine);
    console.log('\n[完成] 计划已发送到 WhatsApp（窗口有变化）');
  } else {
    console.log('\n[完成] 计划无变化，静默跳过 WhatsApp');
  }
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
