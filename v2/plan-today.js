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

process.env.TZ = 'Australia/Sydney'; // 统一用Sydney本地时间
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

// ── 系统常量（全部从 .env 读取，修改阈值请编辑 .env 文件）──────
const e = (key, def) => parseFloat(process.env[key] || def);
const BATT_KWH       = e('BATT_KWH',           42);
const SOC_MIN        = e('SOC_MIN_PCT',         10)  / 100;
const SOC_OVERNIGHT  = SOC_MIN;
const SOC_SELL_FLOOR = e('SOC_SELL_FLOOR_PCT',  50)  / 100;
const SOC_TARGET     = e('CHARGE_TARGET_PCT',   65)  / 100;  // 基础目标65%（够过夜），卖电有利润才扩到85%
const SOC_PV_LIMIT   = e('SOC_PV_LIMIT_PCT',    93)  / 100;  // 93%以上逆变器限流，PV无法充入
const GRID_CHARGE_TARGET = SOC_TARGET;
const MAX_CHARGE_KW  = e('MAX_CHARGE_KW',       5.0);
const MAX_SELL_KW    = e('MAX_SELL_KW',         5.0);
const BREAKER_KW     = e('BREAKER_KW',          7.7);
const MAX_DAILY_KWH  = 20.0;
const CHARGE_BUFFER  = e('CHARGE_BUFFER_KW',    0.5);
const HW_LOAD_KW     = e('HW_LOAD_KW',          5.0);
const PV_SCALE       = e('PV_SCALE',            0.0032);
const PV_PEAK_KW     = e('PV_PEAK_KW',          4.2);  // 实测峰值 4.2kW
const BUY_MAX_C      = e('BUY_MAX_C',           12.0);
const BUY_MIN_C      = e('BUY_THRESHOLD_C',      8.0);
const SELL_MIN_MARGIN_C = e('SELL_MIN_MARGIN_C', 3.0);
const SELL_FLOOR_C   = e('SELL_FLOOR_C',        10.0);
const HW_GRID_MAX_C  = e('HW_GRID_MAX_C',       10.0);
const HW_BATT_MIN_C  = e('HW_BATT_MIN_C',       12.0);
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
    // 用 startTime（UTC）转 Sydney 时间来确定时段
    // 注意：nemTime 是 NEM 结算时间（比实际开始晚30分钟），不能用来定位时段
    const sydStart = new Date(new Date(p.startTime).getTime() + 10 * 3600 * 1000);
    const sydDate  = sydStart.toISOString().substring(0, 10);
    if (sydDate !== today) continue;

    const hh  = sydStart.toISOString().substring(11, 13);
    const mm  = parseInt(sydStart.toISOString().substring(14, 16)) < 30 ? '00' : '30';
    const key = `${hh}:${mm}`;

    if (!slots[key]) slots[key] = { buySum: 0, feedInSum: 0, clSum: 0, clCount: 0, count: 0, demandWindow: false, nemTime: p.nemTime };
    if (p.channelType === 'general') { slots[key].buySum += p.perKwh; slots[key].count++; }
    if (p.channelType === 'feedIn')  slots[key].feedInSum += Math.abs(p.perKwh);
    if (p.channelType === 'controlledLoad') { slots[key].clSum += p.perKwh; slots[key].clCount++; }
    if (p.tariffInformation?.demandWindow) slots[key].demandWindow = true;
  }

  return Object.entries(slots)
    .map(([key, v]) => ({
      key,
      nemTime: v.nemTime,
      buyC:    v.count > 0 ? parseFloat((v.buySum    / v.count).toFixed(2)) : 0,
      feedInC: v.count > 0 ? parseFloat((v.feedInSum / v.count).toFixed(2)) : 0,
      clC:     v.clCount > 0 ? parseFloat((v.clSum   / v.clCount).toFixed(2)) : 0,
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
function buildPlan(slots, pvByHour, currentSoc, hasDW, avgBuyC = 6.5, nightReserveKwh = null, hwWindow = null, gridChargeTarget = SOC_TARGET) {
  const targetKwh  = gridChargeTarget * BATT_KWH;           // 动态目标 kWh
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

  // 电网充电目标：
  // - 今天 PV 预测充足（>= 5kWh）→ 充到 85%，留8%空间给 PV
  // - 今天 PV 预测不足（< 5kWh，阴天/多云）→ 直接充到 93%，不预留
  const gridTargetKwh = gridChargeTarget * BATT_KWH;
  console.log(`[电网目标] ${Math.round(gridChargeTarget*100)}% (${gridTargetKwh.toFixed(1)}kWh)`);

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
  // 但只填价格 <= 已选最贵槽价格 的空隙，防止把下午涨价时段也拉进来
  const sortedChargeKeys = [...chargeKeys].sort();
  const firstChargeKey = sortedChargeKeys[0];
  const lastChargeKey  = sortedChargeKeys[sortedChargeKeys.length - 1];
  const selectedPricesForGap = [...candidateSlots].filter(s => chargeKeys.has(s.key)).map(s => s.buyC);
  const gapPriceCeil = selectedPricesForGap.length ? Math.max(...selectedPricesForGap) : BUY_MAX_C;
  for (const s of candidateSlots) {
    if (chargeKeys.has(s.key)) continue;
    if (firstChargeKey && lastChargeKey && s.key >= firstChargeKey && s.key <= lastChargeKey) {
      // 只填价格不高于已选最贵槽的空隙
      if (s.buyC <= gapPriceCeil) chargeKeys.add(s.key);
    }
  }

  // SOC 偏低时，允许选择更早的便宜槽提前开始充电
  // 逻辑：如果 SOC < 65%，从 07:00 起按价格排序补选槽，直到 neededKwh 满足
  if (currentSoc < 65) {
    const earlySlots = candidateSlots
      .filter(s => !chargeKeys.has(s.key) && s.h >= 7)
      .sort((a, b) => a.buyC - b.buyC);
    let extra = 0;
    for (const s of earlySlots) {
      if (accumulated + extra >= neededKwh) break;
      chargeKeys.add(s.key);
      extra += s.chargeKwhPer;
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

  // 热水器时段：主热水器开着时的总消耗
  // hwKeys 包含主热水器时段，用于判断热水器是否在消纳PV
  const hwLoadMap = {}; // key → 热水器附加负荷
  if (hwWindow) {
    slots.forEach(s => {
      if (s.key >= hwWindow.startKey && s.key < hwWindow.endKey) hwLoadMap[s.key] = HW_LOAD_KW;
    });
  }

  for (const s of slots) {
    const h   = parseInt(s.key.split(':')[0]);
    const pv  = pvAt30min(pvByHour, h);
    const hl  = homeLoadKw(h);
    const hwExtra = hwLoadMap[s.key] ?? (hwKeys.has(s.key) ? HW_LOAD_KW : 0);
    const totalLoad = hl + hwExtra; // 家用 + 热水器
    const net = totalLoad - pv;     // 净需求（正=需要供电，负=PV有余）

    // ── 充电功率计算 ──────────────────────────────────────────
    // 断路器限制下最大可充功率
    const maxChargeKw = parseFloat(Math.min(MAX_CHARGE_KW,
      Math.max(0, BREAKER_KW - Math.max(0, net) - CHARGE_BUFFER)
    ).toFixed(2));

    // PV 消纳充电功率：PV 有余时，需要充电来消纳多余的PV
    // 消纳需要：pvKw > totalLoad，差额 = pvKw - totalLoad
    // 需要充电功率 = pvKw - totalLoad（让PV不溢出）
    const pvSurplus = Math.max(0, pv - totalLoad);
    const pvAbsorb  = parseFloat(Math.min(MAX_CHARGE_KW, pvSurplus).toFixed(2));

    // ── 卖电计算 ──────────────────────────────────────────────
    const overnightFloorKwh = nightReserveKwh
      ? Math.max(SOC_SELL_FLOOR * BATT_KWH, nightReserveKwh * 1.2)
      : SOC_SELL_FLOOR * BATT_KWH;
    const sellableKwh = Math.max(0, socKwh - overnightFloorKwh);
    const maxSellKw   = parseFloat(Math.min(MAX_SELL_KW, sellableKwh / 0.5).toFixed(2));

    // PV 时段判断：有实际 PV 出力
    const hasPv = pv > 0.2;
    // 电池是否还有空间接收PV（< 93% 才能充入）
    const battCanAbsorb = socKwh < SOC_PV_LIMIT * BATT_KWH;

    let action = 'self-use', chargeKw = 0, sellKw = 0, reason = '';

    if (s.dw) {
      // DW时段：绝对不充不卖，待机
      action = 'standby';
      reason = 'DW';

    } else if (chargeKeys.has(s.key) && socKwh < gridTargetKwh && maxChargeKw >= 0.5) {
      // 电网充电槽：充到85%目标
      action   = 'charge';
      chargeKw = maxChargeKw;
      const hwNote = hwKeys.has(s.key) ? ' +HW↓' : '';
      reason   = `buy=${s.buyC}¢ grid-charge${hwNote}`;

    } else if (socKwh < gridTargetKwh && h < gridChargeEndHour && !s.dw && maxChargeKw >= 0.5 && s.buyC < BUY_MAX_C) {
      // 兜底充电：SOC 未达标 + 截止前 + 非DW + 价格可接受 → 也充
      // 防止选槽不足时后面全是 self-use 导致电池放空
      action   = 'charge';
      chargeKw = maxChargeKw;
      reason   = `buy=${s.buyC}¢ fallback-charge (SOC ${Math.round(socKwh/BATT_KWH*100)}% < target)`;

    } else if (hasPv && battCanAbsorb && maxChargeKw >= 0.3) {
      // PV 时段（有阳光）且电池未满（<93%）：充电消纳PV
      // 关键约束：充电功率不超过 PV 出力（不让电网替PV付钱）
      // 如果电价便宜（< BUY_MAX_C），允许从电网补充；否则只消纳PV那部分
      const pvOnlyKw = parseFloat(Math.min(maxChargeKw, Math.max(0, pv - totalLoad)).toFixed(2));
      const gridAllowed = s.buyC < BUY_MAX_C;
      chargeKw = gridAllowed ? maxChargeKw : pvOnlyKw;
      if (chargeKw >= 0.2) {
        action = 'charge';
        reason = gridAllowed
          ? `pv+grid: pv=${pv.toFixed(1)}kW buy=${s.buyC}¢`
          : `pv-only: pv=${pv.toFixed(1)}kW buy=${s.buyC}¢>BUY_MAX(${BUY_MAX_C}¢)`;
      } else {
        action = 'self-use';
        reason = `pv-too-small: ${pv.toFixed(1)}kW`;
        chargeKw = 0;
      }

    } else if (!hasPv && s.feedInC >= sellMinC && maxSellKw >= 0.5 && h >= 16) {
      // 晚间卖电：PV已落山（无PV出力），电价够高，有足够SOC
      action = 'sell';
      sellKw = maxSellKw;
      reason = `feedIn=${s.feedInC}¢ ≥ ${sellMinC.toFixed(1)}¢`;

    } else {
      action = 'self-use';
      reason = `buy=${s.buyC}¢ feedIn=${s.feedInC}¢ pv=${pv.toFixed(1)}kW`;
    }

    // SOC 变化计算
    const effectiveCharge = chargeKw; // 已含热水器负荷影响（maxChargeKw已算进去）
    const deltaKwh = action === 'charge'
      ? effectiveCharge * 0.5 * 0.95
      : action === 'sell'
        ? -sellKw * 0.5
        : net > 0
          ? -net * 0.5 * 0.85   // 放电供负载（效率85%）
          : (-net) * 0.5 * 0.9; // PV充入电池（效率90%）

    socKwh = Math.min(BATT_KWH, Math.max(SOC_MIN * BATT_KWH, socKwh + deltaKwh));

    plan.push({
      key: s.key, nemTime: s.nemTime, hour: h,
      buyC: s.buyC, feedInC: s.feedInC, pvKw: pv, homeLoad: totalLoad, dw: s.dw,
      action, chargeKw: parseFloat(chargeKw.toFixed(2)), sellKw: parseFloat(sellKw.toFixed(2)),
      socPct: Math.round(socKwh / BATT_KWH * 100), reason,
    });
  }

  return { plan, buyThreshold, chargeTargetBy: gridChargeEndHour, sellMinC };
}

// ── 21:00 过夜电量检阅 ────────────────────────────────────────
function calcAvgNightKwh(db) {
  // 过去7天 21:00–次日10:00 实际用电均值（电池要供到次日便宜时段开始）
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
      if (sydHour >= 21 || sydHour < 10) {
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
  // 确保 hw_window_json / gf_window_json 列存在（向后兼容旧表结构）
  try { db.prepare('ALTER TABLE daily_plan ADD COLUMN hw_window_json TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE daily_plan ADD COLUMN gf_window_json TEXT').run(); } catch {}

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
       buy_threshold_c, sell_min_c, hw_window_json, gf_window_json, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    today, version, new Date().toISOString(), 'v2-rules', 'v2/plan-today.js',
    meta.currentSocPct,
    meta.hasDW ? 1 : 0,
    meta.chargeTargetBy,
    parseFloat(meta.pvForecastKwh.toFixed(2)),
    parseFloat(meta.pvPeakKw.toFixed(2)),
    JSON.stringify(chargeWindows),
    JSON.stringify(plan),
    (() => {
      // 动态计算过夜 SOC 底线：夜间家用 + GF凌晨热水器 + 10%保底（主热水器由电网直供不计）
      const nightKwh  = meta.avgNightKwh ?? 7;   // 近7天夜间家用均值
      const gfHwKwh   = 0;                        // GF热水器已改为白天2小时，不再凌晨运行
      const bufferKwh = BATT_KWH * 0.10;          // 10%保底
      const totalKwh  = nightKwh + gfHwKwh + bufferKwh;
      const overnightSocPct = Math.min(60, Math.ceil(totalKwh / BATT_KWH * 100));
      // 生成 hardwareTasks 供 executor 执行热水器开关
      const hardwareTasks = [];
      if (meta.mainWin) {
        hardwareTasks.push({ device: 'main_hw', action: 'on',  time: meta.mainWin.startKey });
        hardwareTasks.push({ device: 'main_hw', action: 'off', time: meta.mainWin.endKey });
      }
      if (meta.gfWin) {
        hardwareTasks.push({ device: 'gf_hw', action: 'on',  time: meta.gfWin.startKey });
        hardwareTasks.push({ device: 'gf_hw', action: 'off', time: meta.gfWin.endKey });
      }
      // 如果当前计算没产生热水器窗口（时间已过），保留之前的 tasks
      const finalTasks = hardwareTasks.length > 0 ? hardwareTasks : (meta.prevHardwareTasks ?? []);
      return JSON.stringify({ buyThreshold: meta.buyThreshold, sellMinC: meta.sellMinC, calibFactor: meta.calibFactor, gridChargeTarget: Math.round(meta.gridChargeTarget * 100), overnightSocPct, hardwareTasks: finalTasks });
    })(),
    parseFloat(meta.buyThreshold.toFixed(2)),
    meta.sellMinC,
    meta.mainWin ? JSON.stringify(meta.mainWin) : null,
    meta.gfWin   ? JSON.stringify(meta.gfWin)   : null,
  );

  console.log(`\n✅ 计划 v${version} 已存入 DB (source=v2-rules)`);
  return version;
}

// ── 热水器计划：找今天最便宜的连续2小时窗口 ───────────────────
// 主热水器每天必须在最低电价时段运行2小时（晚上要有热水用）
// 约束：只在 06:00–14:00 之间，非 DW 时段，连续4个半小时槽
// 电价门槛：低于此值用电网直供，高于此值用电池

// 根据电价决定热水器供电来源
// source='grid'  → Timed 模式 chargeKw=0.1（电网直供，电池几乎不动）
// source='batt'  → Self-use（电池放电供负载）
function hwSource(avgBuyC) {
  if (avgBuyC <= HW_GRID_MAX_C) return 'grid';
  if (avgBuyC >= HW_BATT_MIN_C) return 'batt';
  return 'grid'; // 10–12¢ 默认用电网（省电池）
}

// 找一个连续2小时（4槽）窗口，返回 { startKey, endKey, avgBuyC, source }
function findBestWindow(candidates) {
  if (candidates.length < 4) {
    if (candidates.length === 0) return null;
    const avg = candidates.slice(0,4).reduce((s,x)=>s+x.buyC,0) / Math.min(4,candidates.length);
    const endSlot = candidates[Math.min(3,candidates.length-1)];
    const [eh,em] = endSlot.key.split(':').map(Number);
    const endMins = eh*60+em+30;
    return {
      startKey: candidates[0].key,
      endKey: `${String(Math.floor(endMins/60)).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`,
      avgBuyC: parseFloat(avg.toFixed(2)),
      source: hwSource(avg),
    };
  }
  let bestAvg = Infinity, bestIdx = 0;
  for (let i = 0; i <= candidates.length - 4; i++) {
    const avg = (candidates[i].buyC + candidates[i+1].buyC + candidates[i+2].buyC + candidates[i+3].buyC) / 4;
    if (avg < bestAvg) { bestAvg = avg; bestIdx = i; }
  }
  const startKey = candidates[bestIdx].key;
  const endSlot  = candidates[bestIdx+3];
  const [eh,em]  = endSlot.key.split(':').map(Number);
  const endMins  = eh*60+em+30;
  return {
    startKey,
    endKey: `${String(Math.floor(endMins/60)).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`,
    avgBuyC: parseFloat(bestAvg.toFixed(2)),
    source: hwSource(bestAvg),
  };
}

function calcHotWaterWindows(slots, pvByHour) {
  // 原则：
  // 1. 热水器开在 PV 峰值，天然消纳太阳能
  // 2. 所有热水器必须在「危险截止时间」前结束：
  //    - DW 起点（如有）- 30分钟 缓冲
  //    - 高电价起点（>HW_GRID_MAX_C）- 30分钟 缓冲
  //    取两者中更早的
  // 3. 主热水器(2h) + GF(1h) 加起来3小时，要能排进 PV 时段

  // 找今天最早的危险起点（DW 或高电价，14:00 以后）
  let dangerStartMins = 17 * 60; // 默认 17:00
  for (const s of slots) {
    const [h, m] = s.key.split(':').map(Number);
    if ((s.buyC > HW_GRID_MAX_C || s.dw) && h >= 14) {
      dangerStartMins = h * 60 + m;
      break;
    }
  }
  // 热水器硬截止 = 危险起点 - 30分钟（GF 至少在危险前30分钟结束）
  // 主热水器截止 = 危险起点 - 30分钟 - 60分钟（GF需要1小时）= 危险前90分钟
  const allHwDeadlineMins = dangerStartMins - 30;     // 所有热水器必须在此前结束
  const mainDeadlineMins  = allHwDeadlineMins - 60;   // 主热水器必须在此前结束（留1h给GF）

  console.log(`[热水器截止] 危险起点=${Math.floor(dangerStartMins/60)}:${String(dangerStartMins%60).padStart(2,'0')} 主热水器截止=${Math.floor(mainDeadlineMins/60)}:${String(mainDeadlineMins%60).padStart(2,'0')} GF截止=${Math.floor(allHwDeadlineMins/60)}:${String(allHwDeadlineMins%60).padStart(2,'0')}`);

  // 候选槽：08:00 到主热水器截止前，非 DW
  // 主热水器接 controlled load，用 CL 价格排序（如有），否则回退 general 价格
  const useClPrice = slots.some(s => s.clC > 0);
  const mainCandidates = slots.filter(s => {
    const [h, m] = s.key.split(':').map(Number);
    const endMins = h*60+m+30; // 这个槽的结束时间
    const price = useClPrice ? s.clC : s.buyC;
    return h >= 8 && endMins <= mainDeadlineMins && !s.dw && price < BUY_MAX_C;
  });

  if (mainCandidates.length < 4) {
    console.log('[热水器] 主热水器候选槽不足4个，无法安排主热水器');
  }

  // GF 热水器：必须开！选全天（08:00到截止前）最便宜的连续4槽（2小时）
  // 不再依赖主热水器结束时间，独立选最低价窗口
  const gfCandidates = slots.filter(s => {
    const [h, m] = s.key.split(':').map(Number);
    const endMins = h*60+m+30;
    return h >= 8 && endMins <= allHwDeadlineMins && !s.dw && s.buyC < BUY_MAX_C;
  });

  let gfWin = null;
  if (gfCandidates.length >= 4) {
    // 找最便宜的连续4槽
    let bestGfIdx = -1;
    let bestGfPrice = Infinity;
    for (let i = 0; i <= gfCandidates.length - 4; i++) {
      const w = gfCandidates.slice(i, i+4);
      // 检查连续性（每槽间隔30分钟）
      let consecutive = true;
      for (let j = 0; j < 3; j++) {
        const [h1,m1] = w[j].key.split(':').map(Number);
        const [h2,m2] = w[j+1].key.split(':').map(Number);
        if ((h2*60+m2) - (h1*60+m1) !== 30) { consecutive = false; break; }
      }
      if (!consecutive) continue;
      const avgPrice = w.reduce((s, x) => s + x.buyC, 0) / 4;
      if (avgPrice < bestGfPrice) { bestGfPrice = avgPrice; bestGfIdx = i; }
    }
    if (bestGfIdx >= 0) {
      const gfSlots = gfCandidates.slice(bestGfIdx, bestGfIdx + 4);
      const [geh, gem] = gfSlots[3].key.split(':').map(Number);
      const gfEndMins = geh*60+gem+30;
      const gfAvgC = gfSlots.reduce((s,x) => s+x.buyC, 0) / 4;
      gfWin = {
        startKey: gfSlots[0].key,
        endKey:   `${String(Math.floor(gfEndMins/60)).padStart(2,'0')}:${String(gfEndMins%60).padStart(2,'0')}`,
        avgBuyC:  parseFloat(gfAvgC.toFixed(2)),
        source:   hwSource(gfAvgC),
      };
      console.log(`[GF热水器] ${gfWin.startKey}–${gfWin.endKey} avgPrice=${gfAvgC.toFixed(2)}¢（最便宜连续2小时）`);
    } else {
      // 无连续4槽——放宽到任意4槽按价格最低（不要求连续）
      const sorted = [...gfCandidates].sort((a,b) => a.buyC - b.buyC).slice(0, 4);
      sorted.sort((a,b) => a.key.localeCompare(b.key));
      const [geh, gem] = sorted[3].key.split(':').map(Number);
      const gfEndMins = geh*60+gem+30;
      const gfAvgC = sorted.reduce((s,x) => s+x.buyC, 0) / 4;
      gfWin = {
        startKey: sorted[0].key,
        endKey:   `${String(Math.floor(gfEndMins/60)).padStart(2,'0')}:${String(gfEndMins%60).padStart(2,'0')}`,
        avgBuyC:  parseFloat(gfAvgC.toFixed(2)),
        source:   hwSource(gfAvgC),
      };
      console.log(`[GF热水器] ${gfWin.startKey}–${gfWin.endKey} avgPrice=${gfAvgC.toFixed(2)}¢（非连续，最便宜4槽）`);
    }
  } else {
    // 候选槽不足4个也要开！用所有可用的槽
    const sorted = [...gfCandidates].sort((a,b) => a.buyC - b.buyC);
    if (sorted.length > 0) {
      const last = sorted[sorted.length - 1];
      const [geh, gem] = last.key.split(':').map(Number);
      const gfEndMins = geh*60+gem+30;
      const gfAvgC = sorted.reduce((s,x) => s+x.buyC, 0) / sorted.length;
      gfWin = {
        startKey: sorted[0].key,
        endKey:   `${String(Math.floor(gfEndMins/60)).padStart(2,'0')}:${String(gfEndMins%60).padStart(2,'0')}`,
        avgBuyC:  parseFloat(gfAvgC.toFixed(2)),
        source:   hwSource(gfAvgC),
      };
      console.log(`[GF热水器] ${gfWin.startKey}–${gfWin.endKey} avgPrice=${gfAvgC.toFixed(2)}¢（仅${sorted.length}槽可用，强制开）`);
    } else {
      console.log('[GF热水器] 无候选槽，使用默认 10:00–12:00');
      gfWin = { startKey: '10:00', endKey: '12:00', avgBuyC: 99, source: 'grid' };
    }
  }

  // 主热水器：紧邻 GF 前面或后面（CL 价格更低的那个），两台集中在低价时段
  // 不能与 GF 重叠，不能超出截止时间
  let mainWin = null;
  if (gfWin) {
    const gfStartMins = parseInt(gfWin.startKey.split(':')[0])*60 + parseInt(gfWin.startKey.split(':')[1]);
    const gfEndMins = parseInt(gfWin.endKey.split(':')[0])*60 + parseInt(gfWin.endKey.split(':')[1]);

    // 方案A：主热水器在 GF 前面（endKey = gfWin.startKey）
    const beforeStartMins = gfStartMins - 120; // 2小时前
    const beforeSlots = slots.filter(s => {
      const [h,m] = s.key.split(':').map(Number);
      const mins = h*60+m;
      return mins >= beforeStartMins && mins < gfStartMins && h >= 8 && !s.dw;
    });
    const beforeAvgCL = beforeSlots.length === 4
      ? beforeSlots.reduce((sum,s) => sum + (useClPrice ? s.clC : s.buyC), 0) / 4
      : Infinity;

    // 方案B：主热水器在 GF 后面（startKey = gfWin.endKey）
    const afterEndMins = gfEndMins + 120;
    const afterSlots = slots.filter(s => {
      const [h,m] = s.key.split(':').map(Number);
      const mins = h*60+m;
      return mins >= gfEndMins && mins < gfEndMins + 120 && (mins+30) <= mainDeadlineMins && !s.dw;
    });
    const afterAvgCL = afterSlots.length === 4
      ? afterSlots.reduce((sum,s) => sum + (useClPrice ? s.clC : s.buyC), 0) / 4
      : Infinity;

    let chosenSlots = null;
    if (beforeAvgCL <= afterAvgCL && beforeSlots.length === 4) {
      chosenSlots = beforeSlots;
      console.log(`[主热水器] 选GF前 ${beforeSlots[0].key}–${gfWin.startKey} CL均价=${beforeAvgCL.toFixed(2)}¢`);
    } else if (afterSlots.length === 4) {
      chosenSlots = afterSlots;
      const afterEndKey = `${String(Math.floor((gfEndMins+120)/60)).padStart(2,'0')}:${String((gfEndMins+120)%60).padStart(2,'0')}`;
      console.log(`[主热水器] 选GF后 ${gfWin.endKey}–${afterEndKey} CL均价=${afterAvgCL.toFixed(2)}¢`);
    } else if (beforeSlots.length === 4) {
      chosenSlots = beforeSlots;
      console.log(`[主热水器] 只能选GF前 ${beforeSlots[0].key}–${gfWin.startKey} CL均价=${beforeAvgCL.toFixed(2)}¢`);
    }

    if (chosenSlots && chosenSlots.length === 4) {
      const [meh, mem] = chosenSlots[3].key.split(':').map(Number);
      const mainEndMins = meh*60+mem+30;
      const mainEndKey = `${String(Math.floor(mainEndMins/60)).padStart(2,'0')}:${String(mainEndMins%60).padStart(2,'0')}`;
      const mainAvgC = chosenSlots.reduce((s,x) => s + (useClPrice ? x.clC : x.buyC), 0) / 4;
      mainWin = {
        startKey: chosenSlots[0].key,
        endKey:   mainEndKey,
        avgBuyC:  parseFloat(mainAvgC.toFixed(2)),
        source:   hwSource(mainAvgC),
        priceType: useClPrice ? 'CL' : 'general',
      };
      const mainAvgPv = chosenSlots.reduce((s,x)=>s+pvAt30min(pvByHour,parseInt(x.key)),0)/4;
      console.log(`[主热水器] ${mainWin.startKey}–${mainWin.endKey} avgPV=${mainAvgPv.toFixed(1)}kW avg${useClPrice?'CL':''}Price=${mainAvgC.toFixed(2)}¢`);
    } else {
      console.log('[主热水器] GF前后均无法安排连续2小时');
    }
  } else {
    console.log('[主热水器] 无GF计划，无法定位');
  }

  return { main: mainWin, gf: gfWin };
}

// ── Step 8: 打印计划 ──────────────────────────────────────────
function printPlan(plan, currentSocPct, today, mainWin, gfWin) {
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
    const isMain = mainWin && s.key >= mainWin.startKey && s.key < mainWin.endKey ? '🚿' : '';
    const isGf   = gfWin   && s.key >= gfWin.startKey   && s.key < gfWin.endKey   ? '🛁' : '';
    if (prevAction && prevAction !== s.action) lines.push('');
    lines.push(`${s.key} ${(isMain||isGf||' ')} ${action.padEnd(6)} ${chKw.padStart(6)} ${slKw.padStart(6)}  ${String(s.buyC.toFixed(1)).padStart(5)}¢ ${String(s.feedInC.toFixed(1)).padStart(5)}¢  ${String(s.socPct).padStart(3)}%  ${s.pvKw.toFixed(1)}kW ${dw}`);
    prevAction = s.action;
  }

  const last = plan[plan.length-1];
  lines.push(`${'─'.repeat(60)}`);
  lines.push(`收盘预计: SOC ${last?.socPct ?? '?'}% (${((last?.socPct??0)/100*BATT_KWH).toFixed(1)}kWh)`);
  lines.push('');
  if (mainWin) {
    const src = mainWin.source === 'grid' ? '电网直供' : '电池供电';
    lines.push(`🚿 主热水器: ${mainWin.startKey}–${mainWin.endKey}（均价${mainWin.avgBuyC}¢，${src}）`);
  }
  if (gfWin) {
    const src = gfWin.source === 'grid' ? '电网直供' : '电池供电';
    lines.push(`🛁 GF热水器: ${gfWin.startKey}–${gfWin.endKey}（均价${gfWin.avgBuyC}¢，${src}）`);
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
  // 充电目标：基础 65%（过夜够用）+ 如果卖电有利可图则扩展
  const PV_SUFFICIENT_KWH = parseFloat(process.env.PV_SUFFICIENT_KWH || '5');
  const nowHour = parseInt(syd.hh);
  const pvRemaining = Object.entries(pvByHour)
    .filter(([h]) => parseInt(h) >= nowHour)
    .reduce((s, [, v]) => s + v, 0);

  // 先用基础目标 65%
  let gridChargeTarget = SOC_TARGET; // 65%

  // 4. Amber 价格预测
  console.log('\n[Amber] 拉取价格预测...');
  const rawAmber = await fetchAmberPrices();
  const slots    = aggregateAmberTo30min(rawAmber, today);
  const hasDW    = slots.some(s => s.dw);
  console.log(`[Amber] ${slots.length} 个半小时槽, DW: ${hasDW}`);

  // 买入成本：优先用今天实际加权均价（cost_log），否则用预测便宜时段均价
  let estimatedBuyCost;
  try {
    const costRow = db.prepare(`
      SELECT SUM(buy_cost_c) as totalCost, SUM(buy_kwh) as totalKwh FROM cost_log
      WHERE DATE(ts, 'localtime') = DATE('now', 'localtime') AND buy_kwh > 0
    `).get();
    if (costRow?.totalKwh > 0.5) {
      estimatedBuyCost = costRow.totalCost / costRow.totalKwh;
    }
  } catch {}
  if (!estimatedBuyCost) {
    const cheapSlots = slots.filter(s => {
      const h = parseInt(s.key.split(':')[0]);
      return h >= 8 && h < 15 && !s.dw && s.buyC > 0;
    });
    estimatedBuyCost = cheapSlots.length > 0
      ? cheapSlots.reduce((sum, s) => sum + s.buyC, 0) / cheapSlots.length
      : 99;
  }

  // 看晚间卖电是否有利可图
  const eveningSlots = slots.filter(s => {
    const h = parseInt(s.key.split(':')[0]);
    return h >= 16 && h < 21 && !s.dw && s.feedInC > 0;
  });
  const profitableSlots = eveningSlots.filter(s => s.feedInC > estimatedBuyCost + SELL_MIN_MARGIN_C);

  if (profitableSlots.length > 0) {
    const sellableHours = profitableSlots.length * 0.5;
    const extraKwh = sellableHours * MAX_SELL_KW;
    gridChargeTarget = Math.min(0.90, SOC_TARGET + extraKwh / BATT_KWH);
    const avgFeedIn = profitableSlots.reduce((sum, s) => sum + s.feedInC, 0) / profitableSlots.length;
    const profit = avgFeedIn - estimatedBuyCost;
    console.log(`[充电目标] 卖电有利: ${profitableSlots.length}槽 feedIn均价=${avgFeedIn.toFixed(1)}¢ > 买入=${estimatedBuyCost.toFixed(1)}¢+${SELL_MIN_MARGIN_C}¢, 净利=${profit.toFixed(1)}¢/kWh`);
    console.log(`[充电目标] 扩展到 ${Math.round(gridChargeTarget*100)}%（多充 ${extraKwh.toFixed(1)}kWh 用于卖电）`);
  } else {
    console.log(`[充电目标] 卖电无利: 无 feedIn > 买入${estimatedBuyCost.toFixed(1)}¢+${SELL_MIN_MARGIN_C}¢ 的时段, 目标 ${Math.round(gridChargeTarget*100)}%（仅过夜）`);
  }

  console.log(`[PV预测] 今日预计: ${pvForecastKwh.toFixed(1)}kWh, 剩余: ${pvRemaining.toFixed(1)}kWh → 充电目标 ${Math.round(gridChargeTarget*100)}%`);

  // 5a. 热水器计划（先算，buildPlan 需要知道热水器时段）
    const { main: mainWin, gf: gfWin } = calcHotWaterWindows(slots, pvByHour);
  if (mainWin) console.log(`\n[主热水器] ${mainWin.startKey}–${mainWin.endKey} 均价${mainWin.avgBuyC}¢ → ${mainWin.source==='grid'?'电网直供':'电池供电'}`);
  if (gfWin)   console.log(`[GF热水器] ${gfWin.startKey}–${gfWin.endKey} 均价${gfWin.avgBuyC}¢ → ${gfWin.source==='grid'?'电网直供':'电池供电'}`);

  // 5b. 生成计划（dry-run 先算买入均价，再正式生成含卖电）
  const dryRun = buildPlan(slots, pvByHour, currentSocPct, hasDW, BUY_MIN_C + 1, null, mainWin, gridChargeTarget);
  const dryChargeSlots = dryRun.plan.filter(s => s.action === 'charge');
  const dryAvgBuyC = dryChargeSlots.length > 0
    ? dryChargeSlots.reduce((s, x) => s + x.buyC, 0) / dryChargeSlots.length
    : BUY_MIN_C + 1;

  // 用今天实际已充电的加权买电均价（按实际用量加权，更准确）
  let realAvgBuyC = dryAvgBuyC;
  try {
    // 优先用 cost_log 加权均价（buy_cost / buy_kwh）
    const costRow = db.prepare(`
      SELECT SUM(buy_cost_c) as totalCost, SUM(buy_kwh) as totalKwh FROM cost_log
      WHERE DATE(ts, 'localtime') = DATE('now', 'localtime')
        AND buy_kwh > 0
    `).get();
    if (costRow?.totalKwh > 0.1) {
      realAvgBuyC = parseFloat((costRow.totalCost / costRow.totalKwh).toFixed(2));
      console.log(`[买入均价] 今日加权实际 ${realAvgBuyC}¢（${costRow.totalKwh.toFixed(1)}kWh），dry-run估算 ${dryAvgBuyC.toFixed(2)}¢`);
    } else {
      // 回退到 energy_log 简单均价
      const actualRow = db.prepare(`
        SELECT AVG(buy_price) as avg FROM energy_log
        WHERE DATE(ts, 'localtime') = DATE('now', 'localtime')
          AND buy_price > 0 AND buy_price < ${BUY_MAX_C}
      `).get();
      if (actualRow?.avg != null && actualRow.avg > 0) {
        realAvgBuyC = parseFloat(actualRow.avg.toFixed(2));
        console.log(`[买入均价] 今日实际 ${realAvgBuyC}¢（energy_log），dry-run估算 ${dryAvgBuyC.toFixed(2)}¢`);
      } else {
        console.log(`[买入均价] 无历史数据，用dry-run估算 ${realAvgBuyC.toFixed(2)}¢`);
      }
    }
  } catch { console.log(`[买入均价] ${realAvgBuyC.toFixed(2)}¢`); }
  console.log(`[卖电门槛] max(${SELL_FLOOR_C}¢, ${realAvgBuyC}+${SELL_MIN_MARGIN_C}¢) = ${Math.max(SELL_FLOOR_C, realAvgBuyC + SELL_MIN_MARGIN_C).toFixed(1)}¢`);

  const avgNightKwh = calcAvgNightKwh(db);
  console.log(`[过夜用电] 近7天均值: ${avgNightKwh ?? '无数据'}kWh`);

  const { plan, buyThreshold, chargeTargetBy, sellMinC } = buildPlan(slots, pvByHour, currentSocPct, hasDW, realAvgBuyC, avgNightKwh, mainWin, gridChargeTarget);

  // 6. 打印
  const report = printPlan(plan, currentSocPct, today, mainWin, gfWin);
  console.log(report);

  // 6b. 过夜检阅
  const overnight = reviewOvernightReserve(plan, db);
  const overnightLine = overnight.warning
    ? overnight.warning
    : `✅ 21:00 预计 ${overnight.plannedSoc21}% (${overnight.plannedKwh21?.toFixed(1)}kWh)，近7天夜间均耗 ${overnight.avgNightKwh ?? '?'}kWh，过夜充足`;
  console.log('\n[过夜检阅] ' + overnightLine);

  // 7. 存 DB
  const prevPlan = db.prepare("SELECT charge_windows_json, intervals_json, notes FROM daily_plan WHERE date=? AND is_active=1").get(today);
  const prevChargeSlots = prevPlan ? JSON.parse(prevPlan.intervals_json ?? '[]').filter(s=>s.action==='charge').map(s=>s.key).join(',') : '';
  const prevSellSlots   = prevPlan ? JSON.parse(prevPlan.intervals_json ?? '[]').filter(s=>s.action==='sell').map(s=>s.key).join(',') : '';

  const version = savePlan(db, today, plan, {
    currentSocPct, hasDW, pvForecastKwh, pvPeakKw, calibFactor: PV_SCALE,
    gridChargeTarget,
    buyThreshold, chargeTargetBy, sellMinC, mainWin, gfWin, avgNightKwh,
    prevHardwareTasks: prevPlan?.notes ? (() => { try { return JSON.parse(prevPlan.notes).hardwareTasks; } catch { return null; } })() : null,
  });
  db.close();

  // 8. 写逆变器
  await applyToInverter(plan, today);

  // 9. 有变化才发 WhatsApp
  const newChargeSlots = plan.filter(s=>s.action==='charge').map(s=>s.key).join(',');
  const newSellSlots   = plan.filter(s=>s.action==='sell').map(s=>s.key).join(',');
  const windowChanged  = newChargeSlots !== prevChargeSlots || newSellSlots !== prevSellSlots;

  if (windowChanged) {
    const hwLines = [
      mainWin ? `🚿 主热水器: ${mainWin.startKey}–${mainWin.endKey}（${mainWin.source==='grid'?'电网':'电池'}，${mainWin.avgBuyC}¢）` : '',
      gfWin   ? `🛁 GF热水器: ${gfWin.startKey}–${gfWin.endKey}（${gfWin.source==='grid'?'电网':'电池'}，${gfWin.avgBuyC}¢）` : '',
    ].filter(Boolean).join('\n');
    await sendWhatsApp(report + '\n\n' + overnightLine + (hwLines ? '\n' + hwLines : ''));
    console.log('\n[完成] 计划已发送到 WhatsApp');
  } else {
    console.log('\n[完成] 计划无变化，静默');
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
