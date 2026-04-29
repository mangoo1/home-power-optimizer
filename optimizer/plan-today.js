#!/usr/bin/env node
/**
 * plan-today.js — Rule-based daily planner (no LP)
 *
 * Logic:
 *   1. Fetch Amber price forecast (5-min intervals, next 288 slots = 24h)
 *   2. Fetch PV forecast, apply 60% discount (real-world derating)
 *   3. Get current SOC from DB
 *   4. Estimate home load per half-hour
 *   5. Walk through each 30-min slot:
 *      - Net energy = PV*0.6 - homeLoad → surplus or deficit
 *      - Compute buy/sell thresholds from forecast distribution
 *      - Decide: charge / sell / self-use
 *   6. Save plan to daily_plan table (same schema as before)
 *
 * Usage:
 *   node optimizer/plan-today.js
 */

'use strict';

const path     = require('path');
const https    = require('https');
const Database = require('better-sqlite3');

// Load .env from project root
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch(e) {}

const DB_PATH       = path.join(__dirname, '..', 'data', 'energy.db');
const AMBER_TOKEN   = process.env.AMBER_API_TOKEN || process.env.AMBER_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID   || '01KMN0H71HS5SYAE5P3E9WDGCD';

// ── System constants ──────────────────────────────────────────────────────────
const BATTERY_KWH      = 42;
const SOC_MIN          = 0.32;   // never discharge below 32%
const SOC_MAX          = 0.85;   // charge target
const MAX_CHARGE_KW    = 5.0;
const MAX_DISCHARGE_KW = 5.0;
const CHARGE_EFF       = 0.95;
const DISCHARGE_EFF    = 0.95;
const PANEL_KWP        = 4.3;
const PV_DISCOUNT      = 0.90;   // real-world derating factor (calibrated 2026-04-15 from 8 days data)
const INTERVAL_H       = 0.5;    // 30-min slots

// Sell threshold: feedIn must be >= this to consider selling
const SELL_MIN_C       = 13.5;   // c/kWh absolute floor
// Buy threshold multiplier: charge when price <= cheapest_avg * BUY_MULT
const BUY_MULT         = 1.30;
const BUY_HARD_MAX_C   = 12.0;   // never buy above this regardless

// ── Hot water heater config ───────────────────────────────────────────────────
// Two separate heaters, each ~5kW, each needs 2 hours in daytime.
// They MUST NOT run simultaneously (breaker limit).
// Planner picks the best non-overlapping 2h windows for each heater,
// avoiding high-price slots and demand windows.
const HW_MAIN_KW         = 5.0;   // Main heater load
const HW_GF_KW           = 5.0;   // GF heater load (actually ~3.5kW but budget 5)
const HW_HOURS_EACH      = 2;     // preferred duration per heater
const HW_HOURS_MIN       = 1.5;   // minimum acceptable if no 2h window available
const HW_EARLIEST        = 9;     // not before 09:00 (PV needs to be up)
const HW_LATEST          = 17;    // must finish by 17:00 (before evening peak)
const BREAKER_KW         = 7.7;
const BREAKER_BUFFER_KW  = 1.0;   // safety headroom

// Device IDs for hardware_tasks
const HW_MAIN_DEVICE_ID  = 'bf160bbe78f4f1ce6dpkdp';
const HW_GF_DEVICE_ID    = 'bf3c28e8181e5e980eoobm';

// Home load profile (kW) by Sydney hour — excludes hot water heater
function homeLoadKw(hour) {
  if (hour >= 6  && hour < 9)  return 1.2;  // morning routine
  if (hour >= 9  && hour < 12) return 0.5;  // quiet day
  if (hour >= 12 && hour < 14) return 0.6;  // midday
  if (hour >= 14 && hour < 17) return 0.8;  // afternoon
  if (hour >= 17 && hour < 21) return 1.5;  // evening peak
  if (hour >= 21 && hour < 23) return 0.8;  // winding down
  return 0.35;                               // overnight standby
}

// Pick best window for a single heater: tries HW_HOURS_EACH first, falls back to HW_HOURS_MIN
// excludeRanges: array of {startH, endH} to avoid overlap with other heater
function pickHwWindow(slots, pvByHour, heaterKw, excludeRanges = []) {
  // Try preferred duration first, then fall back to minimum
  const durations = [HW_HOURS_EACH, HW_HOURS_MIN];
  for (const hours of durations) {
    const slotCount = Math.round(hours * 2); // 30-min slots needed
    const candidates = [];
    for (let i = 0; i <= slots.length - slotCount; i++) {
      const window = slots.slice(i, i + slotCount);
      const startH = window[0].hour + (window[0].key ? parseInt(window[0].key.split('T')[1]?.substring(3,5) || '0') / 60 : 0);
      const startHour = window[0].hour;
      const startMin  = parseInt(window[0].key?.split('T')[1]?.substring(3,5) || '0');
      const endMin    = startHour * 60 + startMin + slotCount * 30;
      const endH      = endMin / 60;
      if (startHour < HW_EARLIEST || endH > HW_LATEST) continue;
      if (window.some(s => s.demandWindow)) continue;
      // Check overlap with excluded ranges (using fractional hours)
      const winStart = startHour + startMin / 60;
      const winEnd   = winStart + hours;
      const overlaps = excludeRanges.some(r => winStart < r.endH && winEnd > r.startH);
      if (overlaps) continue;
      const avgBuy = window.reduce((s, v) => s + v.buyC, 0) / window.length;
      const avgPv  = window.reduce((s, v) => s + (pvByHour[v.hour] || 0), 0) / window.length;
      const score = avgPv - avgBuy * 0.5;
      candidates.push({ startH: startHour, startMin, endH: Math.ceil(endH), hours, avgBuy, avgPv, score, slots: window });
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0];
    }
  }
  return null;
}

// ── Timezone helpers ──────────────────────────────────────────────────────────
function getSydneyOffsetHours() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const sydH = parseInt(
    now.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hour12: false }), 10
  );
  let diff = sydH - utcH;
  if (diff < -12) diff += 24;
  if (diff > 12)  diff -= 24;
  return diff;
}
const SYD_OFFSET_H = getSydneyOffsetHours();

function toSydneyHour(isoUtcStr) {
  const t = new Date(isoUtcStr);
  return ((t.getUTCHours() + SYD_OFFSET_H) % 24 + 24) % 24;
}

function toSydneyHourLocal(isoLocalStr) {
  // e.g. "2026-04-07T09:30:00+10:00" → 9
  return parseInt(isoLocalStr.split('T')[1].split(':')[0], 10);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── Fetch Amber prices ────────────────────────────────────────────────────────
async function fetchAmberPrices() {
  const raw = await httpsGet(
    `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=350`,
    { Authorization: `Bearer ${AMBER_TOKEN}` }
  );
  const data = Array.isArray(raw) ? raw : [];
  if (!data.length) { console.warn('⚠️  Amber returned no price data'); }
  // Group by nemTime
  const byTime = {};
  data.forEach(x => {
    if (!byTime[x.nemTime]) byTime[x.nemTime] = { nemTime: x.nemTime };
    if (x.channelType === 'general') {
      byTime[x.nemTime].buy         = x.perKwh;
      byTime[x.nemTime].demandWindow = x.tariffInformation?.demandWindow || false;
      byTime[x.nemTime].descriptor   = x.descriptor;
      byTime[x.nemTime].type         = x.type;
    }
    if (x.channelType === 'feedIn') {
      byTime[x.nemTime].feedin = Math.abs(x.perKwh);
    }
  });
  return Object.values(byTime)
    .filter(x => x.buy !== undefined)
    .sort((a, b) => new Date(a.nemTime) - new Date(b.nemTime));
}

// ── Aggregate 5-min → 30-min slots ───────────────────────────────────────────
function aggregateTo30min(priceIntervals) {
  const slots = {};
  for (const iv of priceIntervals) {
    const t = new Date(iv.nemTime);
    // Round down to nearest 30 min in Sydney time
    const sydMs = t.getTime() + SYD_OFFSET_H * 3600 * 1000;
    const sydDate = new Date(sydMs);
    sydDate.setUTCMinutes(sydDate.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
    const key = sydDate.toISOString();
    if (!slots[key]) {
      slots[key] = { nemTime: iv.nemTime, key, buy: [], feedin: [], demandWindow: false, hour: sydDate.getUTCHours() };
    }
    slots[key].buy.push(iv.buy ?? 15);
    slots[key].feedin.push(iv.feedin ?? 5);
    if (iv.demandWindow) slots[key].demandWindow = true;
  }
  return Object.values(slots)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(s => ({
      nemTime:     s.nemTime,
      key:         s.key,
      hour:        s.hour,
      buyC:        s.buy.reduce((a, v) => a + v, 0) / s.buy.length,
      feedinC:     s.feedin.reduce((a, v) => a + v, 0) / s.feedin.length,
      demandWindow: s.demandWindow,
    }));
}

// ── PV forecast per hour ──────────────────────────────────────────────────────
function pvKwForHour(sw_wm2, cloud_pct) {
  // Note: Open-Meteo shortwave_radiation already accounts for cloud cover (actual surface radiation).
  // Do NOT apply a separate cloud correction factor — that would double-count cloud losses.
  // PV_DISCOUNT covers: inverter efficiency, wiring losses, panel temperature, soiling (~10% total).
  return Math.max(0, PANEL_KWP * (sw_wm2 / 1000)) * PV_DISCOUNT;
}

// ── Buy threshold: cheapest slots in daytime window ──────────────────────────
function calcBuyThreshold(slots) {
  // Take all daytime (06:00–17:00) non-demand-window buy prices
  const dayPrices = slots
    .filter(s => s.hour >= 6 && s.hour < 17 && !s.demandWindow)
    .map(s => s.buyC)
    .sort((a, b) => a - b);
  if (dayPrices.length === 0) return 9.6;
  // Average of cheapest 6 slots (≈3h), × BUY_MULT
  const n = Math.min(6, dayPrices.length);
  const avg = dayPrices.slice(0, n).reduce((s, v) => s + v, 0) / n;
  return Math.min(BUY_HARD_MAX_C, Math.max(9.6, avg * BUY_MULT));
}

// ── Main planner ──────────────────────────────────────────────────────────────
async function main() {
  const now    = new Date();
  const sydH   = (now.getUTCHours() + SYD_OFFSET_H + 24) % 24;
  const today  = now.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  console.log(`\n🕐 plan-today.js — ${today}  Sydney ${String(sydH).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`);
  console.log(`   PV derating: ${(PV_DISCOUNT*100).toFixed(0)}%  SOC target: ${SOC_MAX*100}%  SOC floor: ${SOC_MIN*100}%`);

  // ── 1. Current SOC ──────────────────────────────────────────────────────────
  const db = new Database(DB_PATH);
  const latest = db.prepare('SELECT soc FROM energy_log ORDER BY ts DESC LIMIT 1').get();
  const currentSOC = latest?.soc ?? 50;
  let socKwh = (currentSOC / 100) * BATTERY_KWH;
  console.log(`\n🔋 Current SOC: ${currentSOC}% (${socKwh.toFixed(1)} kWh / ${BATTERY_KWH} kWh)`);

  // ── 2. PV forecast ─────────────────────────────────────────────────────────
  const frow = db.prepare("SELECT forecast_json FROM solar_forecast ORDER BY fetched_at DESC LIMIT 1").get();
  const pvByHour = {};
  if (frow) {
    const fc = JSON.parse(frow.forecast_json);
    fc.time.forEach((t, i) => {
      if (t.startsWith(today)) {
        const h = toSydneyHourLocal(t);
        pvByHour[h] = pvKwForHour(fc.sw[i], fc.cloud[i]);
      }
    });
  }
  const totalPvEst = Object.values(pvByHour).reduce((s, v) => s + v, 0);
  console.log(`\n☀️  PV forecast (×${(PV_DISCOUNT*100).toFixed(0)}% derating):`);
  for (let h = 6; h <= 18; h++) {
    const kw = pvByHour[h] || 0;
    const bar = '█'.repeat(Math.round(kw / 0.2));
    console.log(`   ${String(h).padStart(2,'0')}:00  ${kw.toFixed(2).padStart(5)} kW  ${bar}`);
  }
  console.log(`   Est. total: ~${totalPvEst.toFixed(1)} kWh`);

  // ── 3. Amber prices ─────────────────────────────────────────────────────────
  console.log('\n📡 Fetching Amber prices...');
  const rawIntervals = await fetchAmberPrices();
  const slots = aggregateTo30min(rawIntervals);
  console.log(`   Got ${slots.length} 30-min slots`);

  // Buy threshold
  const buyThresholdC = calcBuyThreshold(slots);
  console.log(`   Buy threshold: ≤ ${buyThresholdC.toFixed(1)}c/kWh`);
  console.log(`   Sell threshold: ≥ ${SELL_MIN_C}c/kWh`);

  // ── Hot water window selection (two separate heaters) ─────────────────────
  const todaySlots = slots.filter(s => s.key.startsWith(today));
  const hwMainWindow = pickHwWindow(todaySlots, pvByHour, HW_MAIN_KW, []);
  // Exclude range uses precise end time (startH + startMin/60 + hours)
  const mainExclude = hwMainWindow
    ? [{ startH: hwMainWindow.startH + (hwMainWindow.startMin||0)/60, endH: hwMainWindow.startH + (hwMainWindow.startMin||0)/60 + hwMainWindow.hours }]
    : [];
  const hwGfWindow   = pickHwWindow(todaySlots, pvByHour, HW_GF_KW, mainExclude);

  // Build hardware_tasks array (the single source of truth for executor)
  const hardwareTasks = [];
  function fmtTime(h, m) { return `${String(h).padStart(2,'0')}:${String(m||0).padStart(2,'0')}`; }

  if (hwMainWindow) {
    const startTime = fmtTime(hwMainWindow.startH, hwMainWindow.startMin || 0);
    const endMins = hwMainWindow.startH * 60 + (hwMainWindow.startMin || 0) + hwMainWindow.hours * 60;
    const endTime = fmtTime(Math.floor(endMins/60), endMins % 60);
    hardwareTasks.push(
      { time: startTime, action: 'on',  device: 'main_hw', deviceId: HW_MAIN_DEVICE_ID, deviceName: '主热水器', loadKw: HW_MAIN_KW },
      { time: endTime,   action: 'off', device: 'main_hw', deviceId: HW_MAIN_DEVICE_ID, deviceName: '主热水器', loadKw: 0 },
    );
    console.log(`\n🚿 主热水器窗口: ${startTime}–${endTime} (${hwMainWindow.hours}h)`);
    console.log(`   Avg buy: ${hwMainWindow.avgBuy.toFixed(1)}c  Avg PV: ${hwMainWindow.avgPv.toFixed(2)}kW`);
  } else {
    console.log(`\n🚿 主热水器: 未找到合适窗口（${HW_EARLIEST}:00–${HW_LATEST}:00 内无空闲/低价时段）`);
  }
  if (hwGfWindow) {
    const startTime = fmtTime(hwGfWindow.startH, hwGfWindow.startMin || 0);
    const endMins = hwGfWindow.startH * 60 + (hwGfWindow.startMin || 0) + hwGfWindow.hours * 60;
    const endTime = fmtTime(Math.floor(endMins/60), endMins % 60);
    hardwareTasks.push(
      { time: startTime, action: 'on',  device: 'gf_hw', deviceId: HW_GF_DEVICE_ID, deviceName: 'GF热水器', loadKw: HW_GF_KW },
      { time: endTime,   action: 'off', device: 'gf_hw', deviceId: HW_GF_DEVICE_ID, deviceName: 'GF热水器', loadKw: 0 },
    );
    console.log(`\n🛁 GF热水器窗口: ${startTime}–${endTime} (${hwGfWindow.hours}h)`);
    console.log(`   Avg buy: ${hwGfWindow.avgBuy.toFixed(1)}c  Avg PV: ${hwGfWindow.avgPv.toFixed(2)}kW`);
  } else {
    console.log(`\n🛁 GF热水器: 未找到合适窗口（可能与主热水器窗口冲突或全时段有DW）`);
  }
  if (hardwareTasks.length > 0) {
    console.log(`\n🔧 Hardware tasks (${hardwareTasks.length}):`);
    hardwareTasks.sort((a, b) => a.time.localeCompare(b.time));
    for (const t of hardwareTasks) {
      console.log(`   ${t.time}  ${t.action.toUpperCase().padEnd(3)}  ${t.deviceName}`);
    }
  }

  // Determine which slots have hot water load for energy simulation
  // Use start/end in minutes for precise matching
  const hwMainStartMins = hwMainWindow ? hwMainWindow.startH * 60 + (hwMainWindow.startMin || 0) : null;
  const hwMainEndMins   = hwMainWindow ? hwMainStartMins + hwMainWindow.hours * 60 : null;
  const hwGfStartMins   = hwGfWindow ? hwGfWindow.startH * 60 + (hwGfWindow.startMin || 0) : null;
  const hwGfEndMins     = hwGfWindow ? hwGfStartMins + hwGfWindow.hours * 60 : null;

  // ── 4. Walk slots and build plan ────────────────────────────────────────────
  console.log('\n Time    Buy¢  FdIn¢  PV kW  Load kW  NetKwh  SOC%  Action      ChargeKw');
  console.log('─────────────────────────────────────────────────────────────────────────');

  const intervals = [];
  const socMinKwh = SOC_MIN * BATTERY_KWH;
  const socMaxKwh = SOC_MAX * BATTERY_KWH;

  // Detect demand window presence
  const hasDW = slots.some(s => s.demandWindow);

  // SOC floor for selling: time-dependent
  const SOC_MIN_SELL_MORNING   = 0.12 * BATTERY_KWH;  // 00:00–10:59
  const SOC_MIN_SELL_AFTERNOON = 0.35 * BATTERY_KWH;  // 11:00–23:59
  const SELL_STOP_HOUR = 21;

  for (const slot of slots) {
    const h       = slot.hour;
    const slotMin = parseInt(slot.key?.split('T')[1]?.substring(3,5) || '0');
    const slotMins = h * 60 + slotMin;
    const inMainHW = hwMainStartMins !== null && slotMins >= hwMainStartMins && slotMins < hwMainEndMins;
    const inGfHW   = hwGfStartMins !== null && slotMins >= hwGfStartMins && slotMins < hwGfEndMins;
    const inHW     = inMainHW || inGfHW;
    const hwLoad   = (inMainHW ? HW_MAIN_KW : 0) + (inGfHW ? HW_GF_KW : 0);
    const baseLoad = homeLoadKw(h);
    const load    = baseLoad + hwLoad;
    const pv      = pvByHour[h] ?? 0;
    const netKwh  = (pv - load) * INTERVAL_H;
    const inDW    = slot.demandWindow;
    const buyC    = slot.buyC;
    const feedinC = slot.feedinC;

    // PV charges battery passively when surplus
    const pvSurplus = Math.max(0, netKwh);
    const pvChargeKwh = Math.min(pvSurplus * CHARGE_EFF, socMaxKwh - socKwh);
    socKwh = Math.min(socMaxKwh, socKwh + pvChargeKwh);

    let action    = 'self-use';
    let chargeKw  = 0;
    let chargeKwh = 0;

    // ── Decision ────────────────────────────────────────────────────────────
    if (inDW) {
      // Demand window: no charging, allow selling if profitable
      const socMinSell = h < 11 ? SOC_MIN_SELL_MORNING : SOC_MIN_SELL_AFTERNOON;
      if (feedinC >= SELL_MIN_C && socKwh > socMinSell && h < SELL_STOP_HOUR) {
        action = 'sell';
        // Discharge at max safe rate
        const dischargeKwh = Math.min(MAX_DISCHARGE_KW * INTERVAL_H, socKwh - socMinSell);
        socKwh -= dischargeKwh / DISCHARGE_EFF;
      } else {
        action = 'self-use';
        // Battery covers deficit passively
        const deficitKwh = Math.max(0, -netKwh);
        const drawKwh = Math.min(deficitKwh, socKwh - socMinKwh);
        socKwh -= drawKwh;
      }

    } else if (buyC <= buyThresholdC && socKwh < socMaxKwh - 0.1 && h >= 6 && h < 16) {
      // Cheap price window: charge from grid (stop by 16:00 — prepare for evening sell)
      // Cheap price window: charge from grid
      // Dynamic charge power: limited by breaker headroom after hot water + home load
      const netHouseDraw = load - pv;  // includes hot water if active
      const available    = BREAKER_KW - netHouseDraw - BREAKER_BUFFER_KW;
      chargeKw  = Math.min(MAX_CHARGE_KW, Math.max(0, available));
      chargeKwh = chargeKw * INTERVAL_H * CHARGE_EFF;
      const canCharge = Math.min(chargeKwh, socMaxKwh - socKwh);
      socKwh   += canCharge;
      action    = chargeKw > 0 ? 'charge' : 'self-use';
      if (inHW && chargeKw > 0) action = 'charge+hw';  // mark hot water overlap

    } else if (feedinC >= SELL_MIN_C && h < SELL_STOP_HOUR && h >= 6) {
      // High feedIn: sell — only between 06:00 and SELL_STOP_HOUR (no overnight selling)
      const socMinSell = h < 11 ? SOC_MIN_SELL_MORNING : SOC_MIN_SELL_AFTERNOON;
      if (socKwh > socMinSell) {
        action = 'sell';
        const dischargeKwh = Math.min(MAX_DISCHARGE_KW * INTERVAL_H, socKwh - socMinSell);
        socKwh -= dischargeKwh / DISCHARGE_EFF;
      }

    } else {
      // Self-use: battery covers deficit
      const deficitKwh = Math.max(0, -netKwh);
      const drawKwh    = Math.min(deficitKwh, socKwh - socMinKwh);
      socKwh          -= drawKwh;
    }

    const socPct = Math.round((socKwh / BATTERY_KWH) * 100);
    const timeStr = slot.key.split('T')[1].substring(0, 5);

    // Only log today's slots for readability
    if (slot.key.startsWith(today)) {
      const actionPad = action.padEnd(10);
      console.log(
        ` ${timeStr}  ${buyC.toFixed(1).padStart(5)}  ${feedinC.toFixed(1).padStart(5)}  ` +
        `${pv.toFixed(2).padStart(5)}  ${load.toFixed(2).padStart(7)}  ` +
        `${netKwh.toFixed(2).padStart(6)}  ${String(socPct).padStart(4)}%  ` +
        `${actionPad}  ${chargeKw > 0 ? chargeKw.toFixed(2) : '—'}`
      );
    }

    intervals.push({
      nemTime:  slot.nemTime,
      key:      slot.key,
      hour:     h,
      buyC:     parseFloat(buyC.toFixed(2)),
      feedinC:  parseFloat(feedinC.toFixed(2)),
      pvKw:     parseFloat(pv.toFixed(3)),
      loadKw:   parseFloat(load.toFixed(2)),
      baseLoadKw: parseFloat(baseLoad.toFixed(2)),
      inHW:     inHW,
      action,
      chargeKw: parseFloat(chargeKw.toFixed(2)),
      inDW:     inDW,
      socPct,
    });
  }

  const finalSoc = Math.round((socKwh / BATTERY_KWH) * 100);
  console.log(`\n🔋 Projected end-of-day SOC: ${finalSoc}%`);
  console.log(`   Charge windows: buy ≤ ${buyThresholdC.toFixed(1)}c between 06:00–17:00`);
  console.log(`   Sell windows:   feedIn ≥ ${SELL_MIN_C}c, SOC > floor, before 21:00`);

  // Charge windows summary
  const chargeSlots = intervals.filter(s => s.action === 'charge' && s.key.startsWith(today));
  const chargeWindow = chargeSlots.length > 0
    ? [{ startHour: chargeSlots[0].hour, endHour: chargeSlots[chargeSlots.length - 1].hour + 1, avgPriceC: parseFloat((chargeSlots.reduce((s, v) => s + v.buyC, 0) / chargeSlots.length).toFixed(1)) }]
    : [];

  // ── 5. Save to DB ───────────────────────────────────────────────────────────
  db.prepare('UPDATE daily_plan SET is_active=0 WHERE date=? AND is_active=1').run(today);
  const lastVer = db.prepare('SELECT MAX(version) as v FROM daily_plan WHERE date=?').get(today);
  const newVersion = (lastVer?.v ?? 0) + 1;

  const pv_forecast_kwh = parseFloat(totalPvEst.toFixed(2));
  const pv_peak_kw      = parseFloat(Math.max(...Object.values(pvByHour), 0).toFixed(3));

  db.prepare(`
    INSERT INTO daily_plan
      (date, version, generated_at, source, created_by, soc_at_gen,
       has_demand_window, charge_cutoff_hour,
       pv_forecast_kwh, pv_peak_kw,
       charge_windows_json, intervals_json, notes, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    today, newVersion, now.toISOString(), 'rules', 'plan-today.js',
    currentSOC,
    hasDW ? 1 : 0,
    17,  // charge cutoff hour
    pv_forecast_kwh, pv_peak_kw,
    JSON.stringify(chargeWindow),
    JSON.stringify(intervals),
    JSON.stringify({
      buyThresholdC,
      sellMinC: SELL_MIN_C,
      pvDiscount: PV_DISCOUNT,
      mainHotWater: hwMainWindow
        ? { startH: hwMainWindow.startH, endH: hwMainWindow.endH, avgBuyC: parseFloat(hwMainWindow.avgBuy.toFixed(1)), avgPvKw: parseFloat(hwMainWindow.avgPv.toFixed(2)) }
        : null,
      gfHotWater: hwGfWindow
        ? { startH: hwGfWindow.startH, endH: hwGfWindow.endH, avgBuyC: parseFloat(hwGfWindow.avgBuy.toFixed(1)), avgPvKw: parseFloat(hwGfWindow.avgPv.toFixed(2)) }
        : null,
      hardwareTasks,
    }),
  );

  console.log(`\n✅ Plan v${newVersion} saved to DB (source=rules, hasDW=${hasDW}, chargeWindows=${chargeWindow.length})`);
  db.close();

  // ── 6. Apply plan to inverter ──────────────────────────────────────────────
  await applyPlanToInverter(intervals, today);
}

// ── Inverter helpers ──────────────────────────────────────────────────────────
const ESS_TOKEN    = process.env.ESS_TOKEN;
const ESS_MAC_HEX  = process.env.ESS_MAC_HEX  || '00534E0045FF';
const ESS_STATION  = process.env.ESS_STATION_SN || 'EU1774416396356';
const ESS_HEADERS  = { Authorization: ESS_TOKEN, lang: 'en', showloading: 'false',
                       Referer: 'https://eu.ess-link.com/appViews/appHome',
                       'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' };

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function setParam(index, data) {
  try {
    const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceParam',
      { macHex: ESS_MAC_HEX, index, data }, ESS_HEADERS);
    return r.code === 200;
  } catch { return false; }
}

async function setWeekParam(index, days) {
  try {
    const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceWeekParam',
      { macHex: ESS_MAC_HEX, index, data: days }, ESS_HEADERS);
    return r.code === 200;
  } catch { return false; }
}

async function setDateParam(index, dateStr) {
  try {
    const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceDateOrTimeParam',
      { macHex: ESS_MAC_HEX, index, data: dateStr }, ESS_HEADERS);
    return r.code === 200;
  } catch { return false; }
}

function fmt2(n) { return String(n).padStart(2, '0'); }
function hhmm(h, m = 0) { return fmt2(h) + fmt2(m); }

/**
 * Apply today's plan directly to the inverter:
 * - Set charge window = first charge slot start → last charge slot end
 * - Set sell window   = first sell slot start  → last sell slot end (capped at 21:00)
 * - Non-charge/sell time: collapse windows → inverter stays in Self-use with no grid activity
 * - Mode is always set to Timed(1) so the windows are respected
 */
async function applyPlanToInverter(intervals, today) {
  if (!ESS_TOKEN) { console.log('[INVERTER] ESS_TOKEN not set, skipping inverter apply'); return; }

  console.log('\n[INVERTER] Applying plan to inverter...');

  // Collect charge slots and sell slots for today
  const todayIntervals = intervals.filter(i => i.key.startsWith(today));
  const chargeSlots = todayIntervals.filter(i => i.action === 'charge' || i.action === 'charge+hw');
  const sellSlots   = todayIntervals.filter(i => i.action === 'sell');

  // Sydney "now" for clock sync
  const now = new Date();
  const sydStr = now.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // Format: dd/mm/yyyy, hh:mm:ss → yyyyMMdd HHmmss
  const [datePart, timePart] = sydStr.split(', ');
  const [dd, mm, yyyy] = datePart.split('/');
  const clockStr = `${yyyy}${mm}${dd} ${timePart.replace(/:/g, '')}`;
  const yd = new Date(now); yd.setDate(yd.getDate() - 1);
  const td = new Date(now); td.setDate(td.getDate() + 1);
  const yesterday = yd.toISOString().substring(0, 10);
  const tomorrow  = td.toISOString().substring(0, 10);

  // ── Charge window ─────────────────────────────────────────────────────────
  let chargeStartHHMM = '0000';
  let chargeEndHHMM   = '0000';
  let chargeKw        = 0;

  if (chargeSlots.length > 0) {
    // Parse start time from first charge slot's nemTime (e.g. "2026-04-20T09:30:00+10:00")
    const firstNem = chargeSlots[0].nemTime;
    const lastNem  = chargeSlots[chargeSlots.length - 1].nemTime;
    const fh = parseInt(firstNem.substring(11, 13));
    const fm = parseInt(firstNem.substring(14, 16));
    // End = last slot start + 30min
    const lh = parseInt(lastNem.substring(11, 13));
    const lm = parseInt(lastNem.substring(14, 16));
    const endMins = lh * 60 + lm + 30;
    chargeStartHHMM = hhmm(fh, fm);
    chargeEndHHMM   = hhmm(Math.floor(endMins / 60), endMins % 60);
    // Use minimum chargeKw across slots (conservative — cron will adjust up/down)
    chargeKw = Math.min(...chargeSlots.map(s => s.chargeKw ?? 5));
    chargeKw = Math.max(0.5, parseFloat(chargeKw.toFixed(2)));
    console.log(`[INVERTER] Charge window: ${chargeStartHHMM}–${chargeEndHHMM}, power=${chargeKw}kW`);
  } else {
    console.log('[INVERTER] No charge slots today — collapsing charge window');
  }

  // ── Sell window: first contiguous sell block only (inverter supports one sell window) ──
  // Take the earliest sell slot and run to 21:00 (demand-mode-manager will fine-tune power).
  // If there are two separate sell blocks (e.g. 07:30 and 17:00), we use the later one that
  // starts after the charge window, to avoid covering non-sell hours.
  let sellStartHHMM = '0000';
  let sellEndHHMM   = '0000';
  let sellKw        = 5;

  if (sellSlots.length > 0) {
    // Prefer sell window that starts at or after charge end (evening peak), fallback to earliest
    const chargeEndMins = chargeEndHHMM === '0000' ? 0
      : parseInt(chargeEndHHMM.substring(0,2))*60 + parseInt(chargeEndHHMM.substring(2,4));
    const eveningSell = sellSlots.find(s => {
      const sh = parseInt(s.nemTime.substring(11,13));
      const sm = parseInt(s.nemTime.substring(14,16));
      return sh*60+sm >= chargeEndMins;
    });
    const useSell = eveningSell ?? sellSlots[0];
    const fh = parseInt(useSell.nemTime.substring(11,13));
    const fm = parseInt(useSell.nemTime.substring(14,16));
    sellStartHHMM = hhmm(fh, fm);
    sellEndHHMM   = '2100';
    console.log(`[INVERTER] Sell window: ${sellStartHHMM}–${sellEndHHMM}, power=${sellKw}kW`);
  } else {
    console.log('[INVERTER] No sell slots today — collapsing sell window');
  }

  // ── Write to inverter (Timed mode) ────────────────────────────────────────
  // Both charge and sell windows set. Outside windows = Self-use (no grid charge, no forced discharge).
  const steps = [
    { label: `syncClock=${clockStr}`,          fn: () => httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceDateParam', { data: clockStr, macHex: ESS_MAC_HEX, index: '0x3050' }, ESS_HEADERS).then(r => r.code === 200).catch(() => false) },
    { label: 'mode=Timed(1)',                  fn: () => setParam('0x300C', 1) },
    // Charge window
    { label: `chargeStart=${chargeStartHHMM}`, fn: () => setParam('0xC014', chargeStartHHMM) },
    { label: `chargeEnd=${chargeEndHHMM}`,     fn: () => setParam('0xC016', chargeEndHHMM) },
    { label: `chargeKw=${chargeKw}`,           fn: () => setParam('0xC0BA', chargeKw) },
    // Sell window
    { label: `sellStart=${sellStartHHMM}`,     fn: () => setParam('0xC018', sellStartHHMM) },
    { label: `sellEnd=${sellEndHHMM}`,         fn: () => setParam('0xC01A', sellEndHHMM) },
    { label: `sellKw=${sellKw}`,               fn: () => setParam('0xC0BC', sellKw) },
    // Common
    { label: 'otherMode=0',                    fn: () => setParam('0x314E', 0) },
    { label: 'weekdays=all',                   fn: () => setWeekParam('0xC0B4', [1,2,3,4,5,6,0]) },
    { label: `startDate=${yesterday}`,         fn: () => setDateParam('0xC0B6', yesterday) },
    { label: `endDate=${tomorrow}`,            fn: () => setDateParam('0xC0B8', tomorrow) },
  ];

  let allOk = true;
  for (const step of steps) {
    const ok = await step.fn();
    console.log(`[INVERTER]   ${step.label} → ${ok ? 'OK' : 'FAILED'}`);
    if (!ok) allOk = false;
    await new Promise(r => setTimeout(r, 400));
  }

  if (allOk) {
    console.log('[INVERTER] ✅ Inverter configured successfully');
  } else {
    console.warn('[INVERTER] ⚠️ Some steps failed — check inverter state');
  }
}

main().catch(async e => {
  console.error('[ERROR]', e.message);
  // Send WhatsApp alert via OpenClaw gateway
  try {
    const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || '18789';
    const alertMsg = `⚠️ plan-today.js 失败！今天没有充电计划。\n错误：${e.message}\n请检查 Amber API token 是否有效。`;
    const alertBody = JSON.stringify({ message: alertMsg });
    await new Promise((resolve) => {
      const http = require('http');
      const req = http.request({
        hostname: 'localhost', port: gatewayPort, path: '/send', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(alertBody) }
      }, res => { res.resume(); resolve(); });
      req.on('error', () => resolve());
      req.write(alertBody);
      req.end();
    });
    console.log('[ALERT] WhatsApp notification sent');
  } catch (alertErr) {
    console.error('[ALERT] Failed to send notification:', alertErr.message);
  }
  process.exit(1);
});
