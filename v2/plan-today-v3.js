#!/usr/bin/env node
/**
 * v2/plan-today-v3.js — 简化卖电策略
 *
 * 核心逻辑：
 *   1. 过夜保底 35%（16:00→次日07:00 自用，实测24%/15.5h ≈ 10.1kWh）
 *   2. 卖电每小时消耗 ≈ 5kWh ≈ 12% SOC
 *   3. 从晚间(16:00-21:00)选最高卖电价的槽位填满
 *   4. 充电目标 = 35% + 卖电槽数 × 12%（上限100%）
 *   5. 三点前充满到目标（用最便宜的时段）
 *
 * 输入：Amber 价格、当前 SOC、PV 预测
 * 输出：daily_plan 表 + 逆变器设置 + 打印计划
 */
'use strict';

process.env.TZ = 'Australia/Sydney';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https    = require('https');
const path     = require('path');
const Database = require('better-sqlite3');

// ── 环境变量 ──────────────────────────────────────────────────
const AMBER_TOKEN   = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID;
const ESS_TOKEN     = process.env.ESS_TOKEN;
const ESS_MAC_HEX   = process.env.ESS_MAC_HEX;
const GW_PORT       = process.env.OPENCLAW_GATEWAY_PORT || '18789';

if (!AMBER_TOKEN || !AMBER_SITE_ID) throw new Error('Missing AMBER_API_TOKEN or AMBER_SITE_ID');
if (!ESS_TOKEN || !ESS_MAC_HEX)     throw new Error('Missing ESS_TOKEN or ESS_MAC_HEX');

// ── 常量 ──────────────────────────────────────────────────────
const e = (key, def) => parseFloat(process.env[key] || def);
const BATT_KWH       = e('BATT_KWH', 42);
const MAX_CHARGE_KW  = e('MAX_CHARGE_KW', 5.0);
const MAX_SELL_KW    = e('MAX_SELL_KW', 5.0);
const BREAKER_KW     = e('BREAKER_KW', 7.7);
const CHARGE_BUFFER  = e('CHARGE_BUFFER_KW', 0.5);
const PV_SCALE       = e('PV_SCALE', 0.0032);
const HW_LOAD_KW     = e('HW_LOAD_KW', 5.0);
const HW_GRID_MAX_C  = e('HW_GRID_MAX_C', 15.0); // 热水器可接受的最高电价
const HW_EARLIEST_H  = 8;   // 最早 08:00 开热水器
const HW_DURATION_SLOTS = 4; // 每台热水器 4 × 30min = 2h
const DB_PATH        = path.join(__dirname, '..', 'data', 'energy.db');

// ── 新策略常量 ────────────────────────────────────────────────
const OVERNIGHT_RESERVE_PCT = 35;     // 卖电时过夜保底 35%
const NO_SELL_RESERVE_PCT   = 55;     // 不卖电时过夜保底 55%（覆盖15:00→次日10:00）
const SELL_KWH_PER_HOUR    = 5.0;    // 每小时卖电约5kWh
const SELL_PCT_PER_HOUR    = 12;     // ≈ 5/42 × 100 ≈ 12%
const SELL_WINDOW_START    = 16;     // 卖电窗口起始 16:00
const SELL_WINDOW_END      = 22;     // 卖电窗口结束 22:00（扩展到覆盖晚高峰尾部）
const CHARGE_DEADLINE_HOUR = 15;     // 充电截止时间 15:00（之后转 self-use 等卖电）
const SELL_MIN_FEEDIN_C    = e('SELL_FLOOR_C', 5.0); // 最低卖电价 5¢
const SELL_PROFIT_MARGIN   = e('SELL_PROFIT_MARGIN', 0.25); // 卖电利润率门槛（保留变量兼容）
const MIN_PROFIT_SPREAD_C = e('MIN_PROFIT_SPREAD_C', 3.0);  // 卖电绝对差价门槛：feedIn均价 > 充电均价 + 3¢ 即可卖
// 决策逻辑：用上午充电区均价 vs 下午卖电区 feedIn 均价判断，差价 >= 3¢ 就充满去卖

// ── 工具函数 ──────────────────────────────────────────────────
function sydneyNow() {
  const s = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const [datePart, timePart] = s.split(', ');
  const [dd, mm, yyyy] = datePart.split('/');
  const [hh, mi, ss]   = timePart.split(':').map(Number);
  return { yyyy, mm, dd, hh, mi, ss, date: `${yyyy}-${mm}-${dd}` };
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject); req.end();
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
    req.on('error', reject); req.write(data); req.end();
  });
}

// ── Amber 价格 ────────────────────────────────────────────────
async function fetchAmberPrices() {
  const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=288&previous=48`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const data = await httpsGet(url, { Authorization: `Bearer ${AMBER_TOKEN}` });
    if (Array.isArray(data)) return data;
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 30000));
    else throw new Error('Amber API failed: ' + JSON.stringify(data).slice(0, 200));
  }
}

function aggregateAmberTo30min(raw, today) {
  // 先按 5 分钟间隔分组，优先用 Actual/Current 价格，只有没有实际价时才用 Forecast
  const fiveMin = {};
  for (const p of raw) {
    const sydStart = new Date(new Date(p.startTime).getTime() + 10 * 3600 * 1000);
    const sydDate  = sydStart.toISOString().substring(0, 10);
    if (sydDate !== today) continue;
    const ts = sydStart.toISOString().substring(11, 16); // HH:MM
    const isActual = p.type === 'ActualInterval' || p.type === 'CurrentInterval';
    if (!fiveMin[ts]) fiveMin[ts] = { actual: [], forecast: [], dw: false };
    const entry = { channelType: p.channelType, perKwh: p.perKwh };
    if (isActual) fiveMin[ts].actual.push(entry);
    else          fiveMin[ts].forecast.push(entry);
    if (p.tariffInformation?.demandWindow) fiveMin[ts].dw = true;
  }

  // 聚合到 30 分钟槽
  const slots = {};
  for (const [ts, data] of Object.entries(fiveMin)) {
    const mm30 = parseInt(ts.substring(3, 5)) < 30 ? '00' : '30';
    const key  = `${ts.substring(0, 2)}:${mm30}`;
    if (!slots[key]) slots[key] = { buySum: 0, feedInSum: 0, count: 0, demandWindow: false };
    // 优先用 actual，没有才用 forecast
    const prices = data.actual.length > 0 ? data.actual : data.forecast;
    for (const e of prices) {
      if (e.channelType === 'general') { slots[key].buySum += e.perKwh; slots[key].count++; }
      if (e.channelType === 'feedIn')  slots[key].feedInSum += Math.abs(e.perKwh);
    }
    if (data.dw) slots[key].demandWindow = true;
  }
  return Object.entries(slots)
    .map(([key, v]) => ({
      key,
      buyC:    v.count > 0 ? parseFloat((v.buySum / v.count).toFixed(2)) : 0,
      feedInC: v.count > 0 ? parseFloat((v.feedInSum / v.count).toFixed(2)) : 0,
      dw:      v.demandWindow,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ── PV 预测 ───────────────────────────────────────────────────
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
    let peakWm2 = 0, cloudSum = 0, cloudCount = 0;
    hourly.time.forEach((t, i) => {
      if (!t.startsWith(today)) return;
      const h = parseInt(t.substring(11, 13));
      if (h < 6 || h > 20) return;
      peakWm2 = Math.max(peakWm2, hourly.shortwave_radiation[i] ?? 0);
      cloudSum += hourly.cloud_cover[i] ?? 0;
      cloudCount++;
    });
    console.log(`[PV] Open-Meteo 更新 ✓ 峰值=${peakWm2}W/m² 云量=${cloudCount > 0 ? (cloudSum/cloudCount).toFixed(0) : '?'}%`);
  } catch(e) {
    console.warn(`[PV] Open-Meteo 获取失败: ${e.message}，使用 DB 缓存`);
  }
}

function getPvForecast(db, today) {
  const row = db.prepare('SELECT forecast_json FROM solar_forecast WHERE date=? ORDER BY fetched_at DESC LIMIT 1').get(today);
  if (!row) return {};
  const fc = JSON.parse(row.forecast_json);
  const pvByHour = {};
  for (let i = 0; i < fc.time.length; i++) {
    if (!fc.time[i].startsWith(today)) continue;
    const h = parseInt(fc.time[i].substring(11, 13));
    const swRad = fc.sw[i] ?? 0;
    const cloud = fc.cloud[i] ?? 0;
    const cloudFactor = 1 - (cloud / 100) * 0.7;
    pvByHour[h] = parseFloat(Math.max(0, swRad * PV_SCALE * cloudFactor).toFixed(2));
  }
  return pvByHour;
}

/**
 * 获取明天的 PV 预测总发电量（kWh）和平均云量（%）
 * 同时查 Open-Meteo 和 wttr.in，取较高云量值（保守）
 */
function getTomorrowPvEstimate(db, today) {
  const row = db.prepare('SELECT forecast_json FROM solar_forecast WHERE date=? ORDER BY fetched_at DESC LIMIT 1').get(today);
  if (!row) return { tomorrowKwh: null, tomorrowCloudPct: null };
  const fc = JSON.parse(row.forecast_json);
  const tomorrow = new Date(new Date(today + 'T00:00:00+10:00').getTime() + 86400000).toISOString().slice(0, 10);
  let totalKwh = 0, cloudSum = 0, cloudCount = 0;
  for (let i = 0; i < fc.time.length; i++) {
    if (!fc.time[i].startsWith(tomorrow)) continue;
    const h = parseInt(fc.time[i].substring(11, 13));
    if (h < 6 || h > 18) continue;
    const swRad = fc.sw[i] ?? 0;
    const cloud = fc.cloud[i] ?? 0;
    const cloudFactor = 1 - (cloud / 100) * 0.7;
    totalKwh += Math.max(0, swRad * PV_SCALE * cloudFactor);
    cloudSum += cloud;
    cloudCount++;
  }
  const openMeteoCloud = cloudCount > 0 ? cloudSum / cloudCount : null;
  console.log(`[明日PV] Open-Meteo: 预测发电 ${totalKwh.toFixed(1)}kWh, 云量 ${openMeteoCloud?.toFixed(0) ?? '?'}%`);
  return { tomorrowKwh: totalKwh, tomorrowCloudPct: openMeteoCloud };
}

/**
 * 从 wttr.in 获取明天平均云量（同步 HTTP，作为 Open-Meteo 的交叉验证）
 */
async function getWttrTomorrowCloud() {
  try {
    const data = await httpsGet('https://wttr.in/Sydney?format=j1');
    if (!data?.weather?.[1]?.hourly) return null;
    const hourly = data.weather[1].hourly;
    let cloudSum = 0;
    for (const h of hourly) cloudSum += parseInt(h.cloudcover || 0);
    const avg = cloudSum / hourly.length;
    console.log(`[明日PV] wttr.in: 云量 ${avg.toFixed(0)}%`);
    return avg;
  } catch (e) {
    console.warn(`[明日PV] wttr.in 查询失败: ${e.message}`);
    return null;
  }
}

// ── 家庭负载估算 ──────────────────────────────────────────────
function homeLoadKw(hour, minute, hwSlots) {
  let base;
  if (hour >= 6  && hour < 10) base = 1.2;
  else if (hour >= 17 && hour < 21) base = 1.5;
  else if (hour >= 21 || hour < 6)  base = 0.35;
  else base = 0.6;

  // 加上热水器负载（如果当前时段有热水器运行）
  if (hwSlots) {
    const key = `${String(hour).padStart(2,'0')}:${String(minute ?? 0).padStart(2,'0')}`;
    if (hwSlots.has(key)) base += HW_LOAD_KW;
  }
  return base;
}

// ── 热水器调度 ────────────────────────────────────────────────
function scheduleHotWater(slots) {
  // 找危险截止时间（DW 或高价 >= HW_GRID_MAX_C，14:00 以后）
  let dangerStartMins = 17 * 60; // 默认 17:00
  for (const s of slots) {
    const [h, m] = s.key.split(':').map(Number);
    if ((s.buyC > HW_GRID_MAX_C || s.dw) && h >= 14) {
      dangerStartMins = h * 60 + m;
      break;
    }
  }
  const allHwDeadlineMins = dangerStartMins - 30; // 所有热水器在危险前30分结束

  console.log(`[热水器] 危险起点=${Math.floor(dangerStartMins/60)}:${String(dangerStartMins%60).padStart(2,'0')} 截止=${Math.floor(allHwDeadlineMins/60)}:${String(allHwDeadlineMins%60).padStart(2,'0')}`);

  // 候选槽：08:00 ~ 截止，非DW，价格合理
  const candidates = slots.filter(s => {
    const [h, m] = s.key.split(':').map(Number);
    const endMins = h * 60 + m + 30;
    return h >= HW_EARLIEST_H && endMins <= allHwDeadlineMins && !s.dw;
  });

  // 找最便宜的连续 N 槽
  function findCheapestWindow(pool, nSlots) {
    if (pool.length < nSlots) return null;
    let bestIdx = -1, bestAvg = Infinity;
    for (let i = 0; i <= pool.length - nSlots; i++) {
      // 检查连续性
      let consecutive = true;
      for (let j = 0; j < nSlots - 1; j++) {
        const [h1, m1] = pool[i+j].key.split(':').map(Number);
        const [h2, m2] = pool[i+j+1].key.split(':').map(Number);
        if ((h2*60+m2) - (h1*60+m1) !== 30) { consecutive = false; break; }
      }
      if (!consecutive) continue;
      const avg = pool.slice(i, i+nSlots).reduce((s, x) => s + x.buyC, 0) / nSlots;
      if (avg < bestAvg) { bestAvg = avg; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    const win = pool.slice(bestIdx, bestIdx + nSlots);
    const [eh, em] = win[nSlots-1].key.split(':').map(Number);
    const endMins = eh*60+em+30;
    return {
      startKey: win[0].key,
      endKey: `${String(Math.floor(endMins/60)).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`,
      avgBuyC: parseFloat(bestAvg.toFixed(2)),
      slots: win,
    };
  }

  // 两台热水器都必须排上，主在前 GF 在后，不重叠。
  // 枚举所有主热水器窗口，对每个找其后最便宜的 GF 窗口，选总均价最低的组合。
  const N = HW_DURATION_SLOTS;
  let bestCombo = null, bestTotalAvg = Infinity;

  // 枚举所有合法的主热水器连续窗口
  for (let i = 0; i <= candidates.length - N; i++) {
    // 检查连续性
    let consecutive = true;
    for (let j = 0; j < N - 1; j++) {
      const [h1, m1] = candidates[i+j].key.split(':').map(Number);
      const [h2, m2] = candidates[i+j+1].key.split(':').map(Number);
      if ((h2*60+m2) - (h1*60+m1) !== 30) { consecutive = false; break; }
    }
    if (!consecutive) continue;

    const mainSlots = candidates.slice(i, i + N);
    const mainEndKey = (() => {
      const [eh, em] = mainSlots[N-1].key.split(':').map(Number);
      const endMins = eh*60+em+30;
      return `${String(Math.floor(endMins/60)).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`;
    })();
    const mainOccupied = new Set(mainSlots.map(s => s.key));

    // GF 候选：主热水器之后，不重叠
    const gfPool = candidates.filter(s => !mainOccupied.has(s.key) && s.key >= mainEndKey);
    const gfWin = findCheapestWindow(gfPool, N);
    if (!gfWin) continue;

    const mainAvg = mainSlots.reduce((s, x) => s + x.buyC, 0) / N;
    const totalAvg = (mainAvg + gfWin.avgBuyC) / 2;
    if (totalAvg < bestTotalAvg) {
      bestTotalAvg = totalAvg;
      const [meh, mem] = mainSlots[N-1].key.split(':').map(Number);
      const mEndMins = meh*60+mem+30;
      bestCombo = {
        mainHw: {
          startKey: mainSlots[0].key,
          endKey: mainEndKey,
          avgBuyC: parseFloat(mainAvg.toFixed(2)),
          slots: mainSlots,
        },
        gfHw: gfWin,
      };
    }
  }

  if (!bestCombo) {
    // 降级：至少排主热水器
    const mainWin = findCheapestWindow(candidates, N);
    if (!mainWin) {
      console.log('[热水器] ⚠️ 无法安排任何热水器（候选槽不足）');
      return { mainHw: null, gfHw: null };
    }
    console.log(`[主热水器] ${mainWin.startKey}–${mainWin.endKey} 均价=${mainWin.avgBuyC}¢`);
    console.log('[热水器] ⚠️ 无法安排 GF 热水器（排完主热水器后候选槽不足）');
    return { mainHw: mainWin, gfHw: null };
  }

  console.log(`[主热水器] ${bestCombo.mainHw.startKey}–${bestCombo.mainHw.endKey} 均价=${bestCombo.mainHw.avgBuyC}¢`);
  console.log(`[GF热水器] ${bestCombo.gfHw.startKey}–${bestCombo.gfHw.endKey} 均价=${bestCombo.gfHw.avgBuyC}¢`);
  return bestCombo;
}

// ── 核心：新卖电策略 ──────────────────────────────────────────
function planSellSlots(slots, avgChargeCostC) {
  // 用实际买入均价计算利润率门槛：feedIn > avgChargeCost × 1.25（25%利润）
  const costBasis = avgChargeCostC || 10.0;
  const minFeedIn = Math.max(SELL_MIN_FEEDIN_C, costBasis * (1 + SELL_PROFIT_MARGIN));
  console.log(`[卖电选槽] 成本基准=${costBasis.toFixed(1)}¢ 最低feedIn=${minFeedIn.toFixed(1)}¢ (25%利润率) 窗口=${SELL_WINDOW_START}:00-${SELL_WINDOW_END}:00`);

  const candidates = slots
    .filter(s => {
      const h = parseInt(s.key.split(':')[0]);
      return h >= SELL_WINDOW_START && h < SELL_WINDOW_END && !s.dw && s.feedInC >= minFeedIn;
    })
    .sort((a, b) => b.feedInC - a.feedInC);

  // 可用卖电时间：(100% - 35%) / 12% per hour = 最多 ~5.4 小时 = 10.8 个半小时槽
  // 但实际受限于电池最大放电和 SELL_WINDOW
  const maxSellSlots = Math.floor((100 - OVERNIGHT_RESERVE_PCT) / (SELL_PCT_PER_HOUR / 2)); // 每半小时6%
  const sellSlots = candidates.slice(0, maxSellSlots);

  console.log(`[卖电选槽] 候选${candidates.length}个，选${sellSlots.length}个（上限${maxSellSlots}）`);
  return sellSlots;
}

function calcChargeTarget(sellSlotCount) {
  // 每个半小时槽消耗 6% SOC（= 12% / 2）
  const sellPct = sellSlotCount * (SELL_PCT_PER_HOUR / 2);
  const basePct = sellSlotCount > 0 ? OVERNIGHT_RESERVE_PCT : NO_SELL_RESERVE_PCT;
  const target = Math.min(100, basePct + sellPct);
  return target;
}

// ── 生成完整计划 ──────────────────────────────────────────────
function buildPlan(slots, pvByHour, currentSocPct, sellSlots, hwSlots) {
  const sellKeys = new Set(sellSlots.map(s => s.key));
  const chargeTargetPct = calcChargeTarget(sellSlots.length);
  const chargeTargetKwh = chargeTargetPct / 100 * BATT_KWH;
  const currentKwh = currentSocPct / 100 * BATT_KWH;
  const neededKwh = Math.max(0, chargeTargetKwh - currentKwh);

  console.log(`\n[策略] 过夜保底: ${OVERNIGHT_RESERVE_PCT}% | 卖电槽: ${sellSlots.length}个(${sellSlots.length * 0.5}h) | 充电目标: ${chargeTargetPct}% (${chargeTargetKwh.toFixed(1)}kWh)`);
  console.log(`[策略] 当前: ${currentSocPct}% (${currentKwh.toFixed(1)}kWh) | 需充: ${neededKwh.toFixed(1)}kWh`);

  // 选充电槽：15:00前最便宜的时段，充到目标
  // 买价上限：卖电时 = feedIn均价 - 3¢（保底利润）；不卖电时 = 保守 12¢
  const avgFeedInC = sellSlots.length > 0
    ? sellSlots.reduce((s, x) => s + x.feedInC, 0) / sellSlots.length
    : 0;
  // 买价上限：卖电 feedIn 倒推，保证 25% 利润率或 3¢ 差价（取宽松的）
  const buyMaxDynamic = sellSlots.length > 0
    ? Math.max(avgFeedInC / (1 + SELL_PROFIT_MARGIN), avgFeedInC - MIN_PROFIT_SPREAD_C)
    : 12.0;
  console.log(`[充电] 动态买价上限: ${buyMaxDynamic.toFixed(1)}¢ (avgFeedIn=${avgFeedInC.toFixed(1)}¢)`);

  const chargeCandidates = slots
    .filter(s => {
      const h = parseInt(s.key.split(':')[0]);
      return h < CHARGE_DEADLINE_HOUR && !s.dw && s.buyC > 0 && s.buyC <= buyMaxDynamic;
    })
    .sort((a, b) => a.buyC - b.buyC);

  const chargeKeys = new Set();
  let accKwh = 0;
  for (const s of chargeCandidates) {
    if (accKwh >= neededKwh) break;
    const [h, m] = s.key.split(":").map(Number);
    const pv = pvByHour[h] ?? 0;
    const hl = homeLoadKw(h, m, hwSlots);
    const gridHeadroom = BREAKER_KW - Math.max(0, hl - pv) - CHARGE_BUFFER;
    const maxKw = Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom));
    const slotKwh = maxKw * 0.5 * 0.95;
    if (slotKwh < 0.5) continue;
    chargeKeys.add(s.key);
    accKwh += slotKwh;
  }

  // 填充电连续性：首到尾之间所有非DW槽都补上（避免中间空洞导致切换）
  // 但跳过充电功率 < 1kW 的垃圾槽
  const sortedCK = [...chargeKeys].sort();
  if (sortedCK.length >= 2) {
    const first = sortedCK[0], last = sortedCK[sortedCK.length - 1];
    for (const s of slots) {
      const h = parseInt(s.key.split(':')[0]);
      if (!chargeKeys.has(s.key) && s.key >= first && s.key <= last && !s.dw && h < CHARGE_DEADLINE_HOUR && s.buyC <= buyMaxDynamic) {
        // 检查该槽是否有足够充电空间
        const [sh, sm] = s.key.split(':').map(Number);
        const pv = pvByHour[sh] ?? 0;
        const hl = homeLoadKw(sh, sm, hwSlots);
        const gridHeadroom = BREAKER_KW - Math.max(0, hl - pv) - CHARGE_BUFFER;
        const maxKw = Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom));
        if (maxKw < 1.0) continue; // 跳过低功率垃圾槽
        chargeKeys.add(s.key);
      }
    }
  }
  // 同样从原始选择中移除低功率槽
  for (const key of [...chargeKeys]) {
    const [h, m] = key.split(':').map(Number);
    const pv = pvByHour[h] ?? 0;
    const hl = homeLoadKw(h, m, hwSlots);
    const gridHeadroom = BREAKER_KW - Math.max(0, hl - pv) - CHARGE_BUFFER;
    const maxKw = Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom));
    if (maxKw < 1.0) chargeKeys.delete(key);
  }

  console.log(`[充电] 选中 ${chargeKeys.size} 槽, 预计充入 ${accKwh.toFixed(1)}kWh`);
  if (sellSlots.length > 0) {
    const sortedSell = [...sellKeys].sort();
    const prices = sellSlots.map(s => s.feedInC);
    console.log(`[卖电] ${sortedSell[0]}–${sortedSell[sortedSell.length-1]} | feedIn ${Math.min(...prices).toFixed(1)}–${Math.max(...prices).toFixed(1)}¢`);
  }

  // 生成逐槽计划
  const avgSellC = sellSlots.length > 0 ? sellSlots.reduce((s, x) => s + x.feedInC, 0) / sellSlots.length : 15;
  let socKwh = currentKwh;
  const plan = [];

  for (const s of slots) {
    const [h, m] = s.key.split(":").map(Number);
    const pv = pvByHour[h] ?? 0;
    const hl = homeLoadKw(h, m, hwSlots);
    const net = hl - pv; // 正=需供电，负=PV有余

    const gridHeadroom = BREAKER_KW - Math.max(0, net) - CHARGE_BUFFER;
    const maxChargeKw = parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom)).toFixed(2));

    let action = 'self-use', chargeKw = 0, sellKw = 0, reason = '';

    if (s.dw) {
      action = 'standby';
      reason = 'DW';
    } else if (chargeKeys.has(s.key) && socKwh < chargeTargetKwh) {
      action = 'charge';
      chargeKw = maxChargeKw;
      reason = `buy=${s.buyC}¢ → 充到${chargeTargetPct}%`;
    } else if (sellKeys.has(s.key) && socKwh > OVERNIGHT_RESERVE_PCT / 100 * BATT_KWH) {
      action = 'sell';
      sellKw = MAX_SELL_KW;
      reason = `feedIn=${s.feedInC}¢`;
    } else if (socKwh < chargeTargetKwh && s.buyC < avgSellC * 0.8 && s.buyC < 8) {
      // 低价补充：买价 < 卖电均价80% 且 < 8¢（绝对低价），才值得从电网充
      // 防止 10¢ 买入然后 10¢ 卖出的搞笑操作
      action = 'charge';
      const gridRoom = parseFloat(Math.min(maxChargeKw, BREAKER_KW - hl - CHARGE_BUFFER).toFixed(2));
      chargeKw = Math.max(0.5, gridRoom);
      reason = `cheap buy=${s.buyC}¢<${(avgSellC*0.8).toFixed(1)}¢ grid-charge`;
    } else if (hwSlots && hwSlots.has(s.key) && hl > 3) {
      // 热水器运行时段：绝不能 self-use（会放电给热水器，浪费电池）
      // 强制小功率充电或 backup，让电网供热水器
      action = 'charge';
      chargeKw = Math.max(0.1, maxChargeKw);
      reason = `热水器运行中，禁止放电 buy=${s.buyC}¢`;
    } else if (pv > 0.2 && socKwh < chargeTargetKwh) {
      // PV 消纳（纯太阳能余量，不管电价）
      action = 'charge';
      chargeKw = parseFloat(Math.min(maxChargeKw, Math.max(0, pv - hl)).toFixed(2));
      if (chargeKw < 1.0) { action = 'self-use'; chargeKw = 0; reason = `pv=${pv.toFixed(1)}kW self`; }
      else reason = `pv=${pv.toFixed(1)}kW absorb`;
    } else {
      action = 'self-use';
      reason = `buy=${s.buyC}¢ feedIn=${s.feedInC}¢`;
    }

    // SOC 变化
    const deltaKwh = action === 'charge'
      ? chargeKw * 0.5 * 0.95
      : action === 'sell'
        ? -sellKw * 0.5
        : net > 0
          ? -net * 0.5 * 0.85
          : (-net) * 0.5 * 0.9;

    socKwh = Math.min(BATT_KWH, Math.max(BATT_KWH * 0.10, socKwh + deltaKwh));

    plan.push({
      key: s.key, hour: h, buyC: s.buyC, feedInC: s.feedInC, pvKw: pv, homeLoad: hl, dw: s.dw,
      action, chargeKw: parseFloat(chargeKw.toFixed(2)), sellKw: parseFloat(sellKw.toFixed(2)),
      socPct: Math.round(socKwh / BATT_KWH * 100), reason,
    });
  }

  return { plan, chargeTargetPct, sellSlotCount: sellSlots.length };
}

// ── 打印计划 ──────────────────────────────────────────────────
function printPlan(plan, currentSocPct, today, chargeTargetPct, sellSlotCount) {
  const lines = [
    `\n🔋 充放电计划 v3 — ${today}  SOC: ${currentSocPct}%`,
    `策略: 保底${OVERNIGHT_RESERVE_PCT}% + 卖电${sellSlotCount}×30min(${sellSlotCount*6}%) = 充到${chargeTargetPct}%`,
    `时间   动作      充电   卖电    买¢    卖¢   SOC   PV`,
    `${'─'.repeat(62)}`,
  ];

  let prevAction = null;
  for (const s of plan) {
    const icon = { charge: '⚡', sell: '💰', 'self-use': '🔋', standby: '⏸' }[s.action] ?? ' ';
    const act = { charge: '充电', sell: '卖电', 'self-use': '自用', standby: '待机' }[s.action] ?? s.action;
    const chKw = s.chargeKw > 0 ? `${s.chargeKw.toFixed(1)}kW` : '   -';
    const slKw = s.sellKw > 0   ? `${s.sellKw.toFixed(1)}kW`   : '   -';
    const dw = s.dw ? '⚠️DW' : '';
    if (prevAction && prevAction !== s.action) lines.push('');
    lines.push(`${s.key} ${icon}${act} ${chKw.padStart(6)} ${slKw.padStart(6)}  ${String(s.buyC.toFixed(1)).padStart(5)}¢ ${String(s.feedInC.toFixed(1)).padStart(5)}¢  ${String(s.socPct).padStart(3)}%  ${s.pvKw.toFixed(1)}kW ${dw}`);
    prevAction = s.action;
  }

  const last = plan[plan.length - 1];
  lines.push(`${'─'.repeat(62)}`);

  // 摘要
  const chargeSlots = plan.filter(s => s.action === 'charge');
  const sellSlots   = plan.filter(s => s.action === 'sell');
  const totalChargeKwh = chargeSlots.reduce((s, x) => s + x.chargeKw * 0.5 * 0.95, 0);
  const totalSellKwh   = sellSlots.reduce((s, x) => s + x.sellKw * 0.5, 0);
  const avgBuyC  = totalChargeKwh > 0 ? chargeSlots.reduce((s,x) => s + x.buyC * x.chargeKw * 0.5 * 0.95, 0) / totalChargeKwh : 0;
  const avgSellC = totalSellKwh > 0 ? sellSlots.reduce((s,x) => s + x.feedInC * x.sellKw * 0.5, 0) / totalSellKwh : 0;

  lines.push(`\n📊 摘要:`);
  lines.push(`  充电: ${chargeSlots.length}槽 ${totalChargeKwh.toFixed(1)}kWh 均价${avgBuyC.toFixed(1)}¢`);
  lines.push(`  卖电: ${sellSlots.length}槽 ${totalSellKwh.toFixed(1)}kWh 均价${avgSellC.toFixed(1)}¢`);
  if (avgSellC > avgBuyC && sellSlots.length > 0) {
    const profit = (avgSellC - avgBuyC) * totalSellKwh;
    lines.push(`  利润: ~${profit.toFixed(0)}¢ (${(avgSellC - avgBuyC).toFixed(1)}¢/kWh × ${totalSellKwh.toFixed(1)}kWh)`);
  }
  lines.push(`  收盘: SOC ${last?.socPct ?? '?'}% (${((last?.socPct??0)/100*BATT_KWH).toFixed(1)}kWh)`);

  return lines.join('\n');
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  const syd   = sydneyNow();
  const today = syd.date;
  console.log(`\n===== v3/plan-today  ${today} ${syd.hh}:${String(syd.mi).padStart(2,'0')} Sydney =====`);

  const db = new Database(DB_PATH);

  // 当前 SOC
  const latest = db.prepare('SELECT soc FROM energy_log ORDER BY ts DESC LIMIT 1').get();
  const currentSocPct = latest?.soc ?? 50;
  console.log(`[SOC] 当前: ${currentSocPct}%`);

  // PV 预测（先拉 Open-Meteo 更新 DB）
  await fetchSolarForecast(db, today);
  const pvByHour = getPvForecast(db, today);
  const pvTotal = Object.values(pvByHour).reduce((s, v) => s + v, 0);
  console.log(`[PV] 今日预计: ${pvTotal.toFixed(1)}kWh`);

  // Amber 价格
  console.log('[Amber] 拉取价格...');
  const rawAmber = await fetchAmberPrices();
  const allSlots = aggregateAmberTo30min(rawAmber, today);
  // 过滤掉已过去的时段
  const nowKey = `${String(syd.hh).padStart(2,'0')}:${syd.mi < 30 ? '00' : '30'}`;
  const slots = allSlots.filter(s => s.key >= nowKey);
  console.log(`[Amber] ${allSlots.length} 个半小时槽 (未来${slots.length}个), DW: ${slots.some(s => s.dw)}`);

  // 核心：选卖电槽（带利润校验）
  // 先算今日实际买电均价作为成本基准
  let avgChargeCostC = 10.0;
  try {
    const todayAvg = db.prepare(
      "SELECT AVG(buy_price) as avg_buy FROM energy_log WHERE date(ts, '+10 hours')=? AND charge_kw > 0 AND buy_price > 0"
    ).get(today);
    if (todayAvg?.avg_buy > 0) avgChargeCostC = todayAvg.avg_buy;
    console.log(`[成本] 今日实际充电均价: ${avgChargeCostC.toFixed(1)}¢`);
  } catch { console.log(`[成本] 查询失败，用默认 ${avgChargeCostC}¢`); }

  let sellSlots = planSellSlots(slots, avgChargeCostC);

  // 热水器调度（用全天槽位排，不受"已过去"过滤影响）
  let { mainHw, gfHw } = scheduleHotWater(allSlots);

  // 如果重跑时排不上热水器，继承前一版本的安排
  if (!mainHw || !gfHw) {
    try {
      const prev = db.prepare("SELECT notes FROM daily_plan WHERE date=? AND is_active=0 ORDER BY version DESC LIMIT 1").get(today);
      if (prev) {
        const prevNotes = JSON.parse(prev.notes || '{}');
        const prevTasks = prevNotes.hardwareTasks || [];
        if (!mainHw) {
          const prevMainOn = prevTasks.find(t => t.device === 'main_hw' && t.action === 'on');
          const prevMainOff = prevTasks.find(t => t.device === 'main_hw' && t.action === 'off');
          if (prevMainOn && prevMainOff && prevMainOff.time > nowKey) {
            mainHw = { startKey: prevMainOn.time, endKey: prevMainOff.time, avgBuyC: 0, slots: [] };
            console.log(`[主热水器] 继承前版计划: ${mainHw.startKey}–${mainHw.endKey}`);
          }
        }
        if (!gfHw) {
          const prevGfOn = prevTasks.find(t => t.device === 'gf_hw' && t.action === 'on');
          const prevGfOff = prevTasks.find(t => t.device === 'gf_hw' && t.action === 'off');
          if (prevGfOn && prevGfOff && prevGfOff.time > nowKey) {
            gfHw = { startKey: prevGfOn.time, endKey: prevGfOff.time, avgBuyC: 0, slots: [] };
            console.log(`[GF热水器] 继承前版计划: ${gfHw.startKey}–${gfHw.endKey}`);
          }
        }
      }
    } catch (e) { console.warn('[热水器] 继承前版失败:', e.message); }
  }
  const hardwareTasks = [];
  if (mainHw) {
    hardwareTasks.push({ device: 'main_hw', action: 'on',  time: mainHw.startKey });
    hardwareTasks.push({ device: 'main_hw', action: 'off', time: mainHw.endKey });
  }
  if (gfHw) {
    hardwareTasks.push({ device: 'gf_hw', action: 'on',  time: gfHw.startKey });
    hardwareTasks.push({ device: 'gf_hw', action: 'off', time: gfHw.endKey });
  }

  // 利润校验：上午充电区均价 vs 下午卖电区 feedIn 均价，差价 >= 3¢ 就卖
  if (sellSlots.length > 0) {
    const avgFeedIn = sellSlots.reduce((s, x) => s + x.feedInC, 0) / sellSlots.length;

    // 充电区均价：08:00-15:00 所有非DW的可用槽
    const chargeZoneSlots = allSlots.filter(s => {
      const h = parseInt(s.key.split(':')[0]);
      return h >= HW_EARLIEST_H && h < CHARGE_DEADLINE_HOUR && !s.dw && s.buyC > 0;
    });
    let avgChargeCost = chargeZoneSlots.length > 0
      ? chargeZoneSlots.reduce((s, x) => s + x.buyC, 0) / chargeZoneSlots.length
      : 0;

    // 兜底：如果没有充电区价格数据，查今日实际充电均价或用 10¢
    if (avgChargeCost === 0) {
      try {
        const todayAvg = db.prepare(
          "SELECT AVG(buy_price) as avg_buy FROM energy_log WHERE date(ts, '+10 hours')=? AND charge_kw > 0 AND buy_price > 0"
        ).get(today);
        avgChargeCost = todayAvg?.avg_buy || 10.0;
        console.log(`[利润校验] 无充电区价格，用今日实际充电均价: ${avgChargeCost.toFixed(1)}¢`);
      } catch { avgChargeCost = 10.0; }
    }

    const minByMargin = avgChargeCost * (1 + SELL_PROFIT_MARGIN); // 25% 利润率
    const minBySpread = avgChargeCost + MIN_PROFIT_SPREAD_C;      // 绝对差价 3¢
    const minRequired = Math.min(minByMargin, minBySpread);       // 取较低门槛
    console.log(`[利润校验] 充电区均价=${avgChargeCost.toFixed(1)}¢ 卖电区feedIn=${avgFeedIn.toFixed(1)}¢ 门槛=min(×1.25=${minByMargin.toFixed(1)}¢, +3¢=${minBySpread.toFixed(1)}¢)=${minRequired.toFixed(1)}¢`);
    if (avgFeedIn < minRequired) {
      console.log(`[利润校验] ❌ feedIn ${avgFeedIn.toFixed(1)}¢ < ${minRequired.toFixed(1)}¢，取消卖电`);
      sellSlots = [];
    } else {
      console.log(`[利润校验] ✅ feedIn ${avgFeedIn.toFixed(1)}¢ >= ${minRequired.toFixed(1)}¢，执行卖电`);
    }
  }

  // ── 明天天气调整：天气差时保守卖电 ──────────────────────────
  if (sellSlots.length > 0) {
    const { tomorrowKwh, tomorrowCloudPct } = getTomorrowPvEstimate(db, today);
    const wttrCloud = await getWttrTomorrowCloud();
    // 取两家预报中较高的云量（保守原则）
    const finalCloud = Math.max(tomorrowCloudPct ?? 0, wttrCloud ?? 0);
    console.log(`[明日天气] 综合云量: ${finalCloud.toFixed(0)}% (Open-Meteo=${tomorrowCloudPct?.toFixed(0) ?? '?'}%, wttr=${wttrCloud?.toFixed(0) ?? '?'}%)`);
    // 明天云量 > 80% → 供应少 → 明天电价大概率高 → 留电明天卖利润更好
    const tomorrowPoorSolar = finalCloud > 80;
    if (tomorrowPoorSolar) {
      // 比较今天卖电均价 vs 保守估计的明天高峰卖价
      // 冬天阴天傍晚 feedIn 通常 20-35¢，今天如果 < 20¢ 就不值得卖
      const todayAvgFeedIn = sellSlots.reduce((s, x) => s + x.feedInC, 0) / sellSlots.length;
      const TOMORROW_EXPECTED_FEEDIN_C = 22; // 阴天傍晚保守估计
      if (todayAvgFeedIn < TOMORROW_EXPECTED_FEEDIN_C) {
        console.log(`[明日天气] 💰 明天云量${tomorrowCloudPct?.toFixed(0)}%→电价预计走高，今天卖价${todayAvgFeedIn.toFixed(1)}¢ < 明天预期${TOMORROW_EXPECTED_FEEDIN_C}¢，取消今天卖电，留电明天卖`);
        sellSlots = [];
      } else {
        console.log(`[明日天气] ⚠️ 明天云量${tomorrowCloudPct?.toFixed(0)}%，但今天卖价${todayAvgFeedIn.toFixed(1)}¢已够高，继续卖`);
      }
    } else {
      console.log(`[明日天气] ✅ 明天云量${tomorrowCloudPct?.toFixed(0) ?? '?'}%正常，按计划卖电`);
    }
  }

  // 生成计划
  // 构建热水器时段 Set（key 格式 "HH:MM"）
  const hwSlots = new Set();
  function addHwRange(startKey, endKey) {
    if (!startKey || !endKey) return;
    const [sh, sm] = startKey.split(':').map(Number);
    const [eh, em] = endKey.split(':').map(Number);
    let mins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    while (mins < endMins) {
      hwSlots.add(`${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`);
      mins += 30;
    }
  }
  if (mainHw) addHwRange(mainHw.startKey, mainHw.endKey);
  if (gfHw)   addHwRange(gfHw.startKey, gfHw.endKey);
  console.log(`[热水器负载] 占用时段: ${[...hwSlots].sort().join(', ') || '无'}`);

  // 可行性检查：估算实际可充入量，如果不够支撑卖电则削减
  {
    const avgSellCFeas = sellSlots.length > 0 ? sellSlots.reduce((s,x) => s + x.feedInC, 0) / sellSlots.length : 15;
    const chargeCandidates = slots
      .filter(s => {
        const h = parseInt(s.key.split(':')[0]);
        return !s.dw && s.buyC > 0 && (h < CHARGE_DEADLINE_HOUR || s.buyC < avgSellCFeas * 0.8);
      })
      .sort((a, b) => a.buyC - b.buyC);
    let estChargeKwh = 0;
    for (const s of chargeCandidates) {
      const [h, m] = s.key.split(':').map(Number);
      const pv = pvByHour[h] ?? 0;
      const hl = homeLoadKw(h, m, hwSlots);
      const gridHeadroom = BREAKER_KW - Math.max(0, hl - pv) - CHARGE_BUFFER;
      const maxKw = Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom));
      estChargeKwh += maxKw * 0.5 * 0.95;
    }
    const achievableKwh = currentSocPct / 100 * BATT_KWH + estChargeKwh;
    const achievablePct = Math.round(achievableKwh / BATT_KWH * 100);
    // 保底线根据卖电结束时间动态计算：
    // - 卖电最晚到 ~21:00，之后只需过夜 (35% ≈ 14.7kWh)
    // - 但卖电前还有 self-use 消耗（下午用电 ~1.2kW）
    // - 用最后一个卖电槽的时间来算需要保留多少
    const lastSellHour = sellSlots.length > 0 
      ? Math.max(...sellSlots.map(s => parseInt(s.key.split(':')[0]))) + 1
      : 21;
    // 从 lastSellHour 到次日 10:00 的用电估算（包括早晨 07-10 用电）
    const hoursToTen = lastSellHour <= 10 ? (10 - lastSellHour) : (24 - lastSellHour + 10);
    // 晚间 ~1kW（到23:00），深夜 0.35kW（23:00-07:00），早晨 ~1.5kW（07:00-10:00）
    let nightKwh = 0;
    for (let h = lastSellHour; h !== 10; h = (h + 1) % 24) {
      if (h >= 21 && h < 23) nightKwh += 1.0;       // 晚间
      else if (h >= 23 || h < 7) nightKwh += 0.35;   // 深夜
      else if (h >= 7 && h < 10) nightKwh += 1.5;    // 早晨（不含热水器）
      else nightKwh += 1.0;                           // 其他
    }
    const reserveKwh = nightKwh * 1.3; // 30% buffer（确保过夜安全）
    const reservePct = Math.max(OVERNIGHT_RESERVE_PCT, Math.round(reserveKwh / BATT_KWH * 100));
    const surplusKwh = Math.max(0, achievableKwh - reserveKwh);
    // 每个卖电槽实际消耗 = 放电2.5kWh + 卖电窗口内self-use约0.3kWh
    const effectiveKwhPerSlot = (SELL_KWH_PER_HOUR / 2) + 0.3;
    const maxSellSlots = Math.floor(surplusKwh / effectiveKwhPerSlot);
    console.log(`[可行性] 最大可充到 ${achievablePct}% (${achievableKwh.toFixed(1)}kWh)，卖到${lastSellHour}:00后需${reserveKwh.toFixed(1)}kWh(${reservePct}%)过夜，可卖 ${maxSellSlots} 槽`);
    if (maxSellSlots < sellSlots.length) {
      console.log(`[可行性] ⚠️ 削减卖电: ${sellSlots.length} → ${maxSellSlots}（选最贵的）`);
      sellSlots = sellSlots.sort((a, b) => b.feedInC - a.feedInC).slice(0, maxSellSlots);
    }
  }

  const { plan, chargeTargetPct, sellSlotCount } = buildPlan(slots, pvByHour, currentSocPct, sellSlots, hwSlots);

  // 打印
  const report = printPlan(plan, currentSocPct, today, chargeTargetPct, sellSlotCount);
  console.log(report);

  // ── 写入 DB ─────────────────────────────────────────────────
  // 确保表结构
  try { db.prepare('ALTER TABLE daily_plan ADD COLUMN hw_window_json TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE daily_plan ADD COLUMN gf_window_json TEXT').run(); } catch {}

  db.prepare('UPDATE daily_plan SET is_active=0 WHERE date=? AND is_active=1').run(today);
  const lastVer = db.prepare('SELECT MAX(version) as v FROM daily_plan WHERE date=?').get(today);
  const version = (lastVer?.v ?? 0) + 1;

  const chargeSlots = plan.filter(s => s.action === 'charge');
  const totalCKwh = chargeSlots.reduce((s, x) => s + x.chargeKw * 0.5 * 0.95, 0);
  const chargeWindows = chargeSlots.length > 0 ? [{
    startHour: parseInt(chargeSlots[0].key),
    endHour:   parseInt(chargeSlots[chargeSlots.length-1].key) + 1,
    avgBuyC:   parseFloat((totalCKwh > 0 ? chargeSlots.reduce((s,x)=>s+x.buyC*x.chargeKw*0.5*0.95,0)/totalCKwh : 0).toFixed(1)),
  }] : [];

  const notes = JSON.stringify({
    strategy: 'v3-sell',
    overnightReservePct: OVERNIGHT_RESERVE_PCT,
    sellSlotCount,
    chargeTargetPct,
    hardwareTasks,
  });

  db.prepare(`
    INSERT INTO daily_plan
      (date, version, generated_at, source, created_by, soc_at_gen,
       has_demand_window, charge_cutoff_hour,
       pv_forecast_kwh, pv_peak_kw,
       charge_windows_json, intervals_json, notes,
       buy_threshold_c, sell_min_c, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    today, version, new Date().toISOString(), 'v3-sell', 'v2/plan-today-v3.js',
    currentSocPct,
    slots.some(s => s.dw) ? 1 : 0,
    CHARGE_DEADLINE_HOUR,
    parseFloat(pvTotal.toFixed(2)),
    parseFloat(Math.max(...Object.values(pvByHour), 0).toFixed(2)),
    JSON.stringify(chargeWindows),
    JSON.stringify(plan),
    notes,
    chargeSlots.length > 0 ? parseFloat(Math.max(...chargeSlots.map(s=>s.buyC)).toFixed(2)) : 0,
    SELL_MIN_FEEDIN_C,
  );
  console.log(`\n✅ 计划 v${version} 已存入 DB (source=v3-sell)`);

  // ── 逆变器设置 ─────────────────────────────────────────────
  const ESS_HEADERS = {
    Authorization: ESS_TOKEN, lang: 'en', showloading: 'false',
    Referer: 'https://eu.ess-link.com/appViews/appHome', 'User-Agent': 'Mozilla/5.0',
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
  function hhmm(h, m=0) { return String(h).padStart(2,'0') + String(m).padStart(2,'0'); }

  // 充电窗口
  let chargeStartHHMM = '0000', chargeEndHHMM = '0000';
  if (chargeSlots.length > 0) {
    const [fh, fm] = chargeSlots[0].key.split(':').map(Number);
    const [lh, lm] = chargeSlots[chargeSlots.length-1].key.split(':').map(Number);
    chargeStartHHMM = hhmm(fh, fm);
    const endMins = lh*60+lm+30;
    chargeEndHHMM = hhmm(Math.floor(endMins/60), endMins%60);
  }

  // 卖电窗口
  const sellPlan = plan.filter(s => s.action === 'sell');
  let sellStartHHMM = '0000', sellEndHHMM = '0000';
  if (sellPlan.length > 0) {
    const [fh, fm] = sellPlan[0].key.split(':').map(Number);
    const [lh, lm] = sellPlan[sellPlan.length-1].key.split(':').map(Number);
    sellStartHHMM = hhmm(fh, fm);
    const endMins = lh*60+lm+30;
    sellEndHHMM = hhmm(Math.floor(endMins/60), endMins%60);
  }

  console.log(`[逆变器] 充电: ${chargeStartHHMM}–${chargeEndHHMM} | 卖电: ${sellStartHHMM}–${sellEndHHMM}`);

  const sydNow = new Date(); // TZ already set to Australia/Sydney
  const yesterday = new Date(sydNow - 86400*1000).toISOString().slice(0,10);
  const tomorrow  = new Date(+sydNow + 86400*1000).toISOString().slice(0,10);
  // 时钟同步字符串：YYYY-MM-DD HH:MM:SS（Sydney 本地时间）
  const pad = n => String(n).padStart(2,'0');
  const clockStr = `${sydNow.getFullYear()}-${pad(sydNow.getMonth()+1)}-${pad(sydNow.getDate())} ${pad(sydNow.getHours())}:${pad(sydNow.getMinutes())}:${pad(sydNow.getSeconds())}`;

  const steps = [
    [`syncClock=${clockStr}`,          () => httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceDateParam',
      { data: clockStr, macHex: ESS_MAC_HEX, index: '0x3050' }, ESS_HEADERS).then(r => r.code === 200).catch(() => false)],
    ['mode=Timed(1)',                  () => setParam('0x300C', 1)],
    [`chargeStart=${chargeStartHHMM}`, () => setParam('0xC014', chargeStartHHMM)],
    [`chargeEnd=${chargeEndHHMM}`,     () => setParam('0xC016', chargeEndHHMM)],
    [`chargeKw=${MAX_CHARGE_KW}`,      () => setParam('0xC0BA', MAX_CHARGE_KW)],
    [`sellStart=${sellStartHHMM}`,     () => setParam('0xC018', sellStartHHMM)],
    [`sellEnd=${sellEndHHMM}`,         () => setParam('0xC01A', sellEndHHMM)],
    [`sellKw=${MAX_SELL_KW}`,          () => setParam('0xC0BC', MAX_SELL_KW)],
    ['otherMode=0',                    () => setParam('0x314E', 0)],
    ['weekdays=all',                   () => setWeekParam('0xC0B4', [1,2,3,4,5,6,0])],
    [`startDate=${yesterday}`,         () => setDateParam('0xC0B6', yesterday)],
    [`endDate=${tomorrow}`,            () => setDateParam('0xC0B8', tomorrow)],
  ];

  for (const [label, fn] of steps) {
    const ok = await fn();
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    await new Promise(r => setTimeout(r, 350));
  }

  // ── Turso 同步 ─────────────────────────────────────────────
  try {
    const { execSync } = require('child_process');
    execSync('node scripts/turso-sync.js', {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env },
      timeout: 30000,
    });
    console.log('✅ Turso 同步完成');
  } catch(e) {
    console.warn('[turso-sync] 同步失败:', e.message);
  }

  db.close();
}

// ── --hw-only 模式：只重算热水器时段，更新现有 plan ──────────
async function hwOnlyMain() {
  const syd = sydneyNow();
  const today = syd.date;
  console.log(`\n===== hw-only mode  ${today} ${syd.hh}:${String(syd.mi).padStart(2,'0')} Sydney =====`);

  const db = new Database(DB_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)");

  // 检查哪台热水器已开过
  const mainDone = !!db.prepare("SELECT 1 FROM kv_store WHERE key=?").get(`hw_main:${today}:on`);
  const gfDone   = !!db.prepare("SELECT 1 FROM kv_store WHERE key=?").get(`hw_gf:${today}:open_time`);

  console.log(`[状态] 主热水器: ${mainDone ? '已开过 ✓' : '未开'}  GF热水器: ${gfDone ? '已开过 ✓' : '未开'}`);

  if (mainDone && gfDone) {
    console.log('两台热水器今天都已开过，无需重算。');
    db.close();
    return;
  }

  // 拉 Amber 价格
  console.log('[Amber] 拉取价格...');
  const rawAmber = await fetchAmberPrices();
  const allSlots = aggregateAmberTo30min(rawAmber, today);

  // 过滤掉已过去的时段
  const nowKey = `${String(syd.hh).padStart(2,'0')}:${syd.mi < 30 ? '00' : '30'}`;
  const futureSlots = allSlots.filter(s => s.key >= nowKey);
  console.log(`[Amber] ${allSlots.length} 个半小时槽 (未来${futureSlots.length}个)`);

  if (futureSlots.length === 0) {
    console.log('没有未来时段可排，退出。');
    db.close();
    return;
  }

  // 用未来时段重算热水器
  const { mainHw, gfHw } = scheduleHotWater(futureSlots);

  // 构建新的 hardwareTasks
  const newTasks = [];
  if (mainDone) {
    // 保留已完成的（不加 task，executor 已经处理了）
  } else if (mainHw) {
    newTasks.push({ device: 'main_hw', action: 'on',  time: mainHw.startKey });
    newTasks.push({ device: 'main_hw', action: 'off', time: mainHw.endKey });
  } else {
    console.log('⚠️ 无法为主热水器找到合适时段！');
  }

  if (gfDone) {
    // 保留已完成的
  } else if (gfHw) {
    newTasks.push({ device: 'gf_hw', action: 'on',  time: gfHw.startKey });
    newTasks.push({ device: 'gf_hw', action: 'off', time: gfHw.endKey });
  } else {
    console.log('⚠️ 无法为 GF 热水器找到合适时段！');
  }

  // 读取当前 active plan
  const plan = db.prepare("SELECT notes, rowid FROM daily_plan WHERE date=? AND is_active=1 ORDER BY rowid DESC LIMIT 1").get(today);
  if (!plan) {
    console.log('⚠️ 没有找到今天的 active plan，无法更新。请先运行完整 plan。');
    db.close();
    return;
  }

  // 解析 notes，替换 hardwareTasks
  const notes = JSON.parse(plan.notes || '{}');
  const oldTasks = notes.hardwareTasks || [];

  // 保留已完成热水器的旧 task
  const preservedTasks = [];
  if (mainDone) {
    preservedTasks.push(...oldTasks.filter(t => t.device === 'main_hw'));
  }
  if (gfDone) {
    preservedTasks.push(...oldTasks.filter(t => t.device === 'gf_hw'));
  }

  notes.hardwareTasks = [...preservedTasks, ...newTasks];

  // 更新 DB
  db.prepare("UPDATE daily_plan SET notes=? WHERE rowid=?").run(JSON.stringify(notes), plan.rowid);

  console.log('\n[更新完成]');
  console.log('  旧 hardwareTasks:', JSON.stringify(oldTasks));
  console.log('  新 hardwareTasks:', JSON.stringify(notes.hardwareTasks));

  db.close();
}

// ── 入口 ──────────────────────────────────────────────────────
if (process.argv.includes('--hw-only')) {
  hwOnlyMain().catch(e => {
    console.error('[ERROR]', e.message);
    process.exit(1);
  });
} else {
  main().catch(e => {
    console.error('[ERROR]', e.message);
    process.exit(1);
  });
}
