#!/usr/bin/env node
/**
 * plan-today.js — Forward LP optimizer for today (v2)
 *
 * Model:
 *   - Battery can charge from: (a) grid, (b) excess PV
 *   - Battery can discharge to: (a) home load (self-use, saves buy cost), (b) grid export (earns feedin)
 *   - LP minimises: grid_buy_cost - grid_sell_revenue + demand_charge
 *   - Key fix: self-use discharge value = buy_price (not feedin); grid export value = feedin_price
 *
 * Usage:
 *   node optimizer/plan-today.js
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const solver  = require('javascript-lp-solver');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'energy.db');
const AMBER_TOKEN   = process.env.AMBER_API_TOKEN || process.env.AMBER_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID   || '01KMN0H71HS5SYAE5P3E9WDGCD';

// ── System config ─────────────────────────────────────────────────────────────
const BATTERY_CAPACITY_KWH = 42;
const SOC_MIN    = 0.10;
const SOC_MAX    = 0.85;
const MAX_CHARGE_KW    = 5.0;
const MAX_DISCHARGE_KW = 5.0;
const CHARGE_EFF       = 0.95;
const DISCHARGE_EFF    = 0.95;
const INTERVAL_H       = 5 / 60;
const PANEL_KWP        = 4.3;  // actual system size (not inverter nameplate)
const DEMAND_CHARGE_RATE = 0.6104;  // $/kW/day

// Assumed home load profile (kW) by hour
function homeLoadKw(hour) {
  // Simple profile: morning/evening higher, midday lower
  if (hour >= 6  && hour < 9)  return 1.2;
  if (hour >= 9  && hour < 15) return 0.5;
  if (hour >= 15 && hour < 20) return 1.5;  // demand window
  if (hour >= 20 && hour < 23) return 1.0;
  return 0.4;  // overnight
}

const DW_START_H = 15;
const DW_END_H   = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────
function httpsGet(url, token) {
  return new Promise((res, rej) => {
    const req = https.get(url, { headers: { 'Authorization': 'Bearer ' + token } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
    });
    req.on('error', rej);
  });
}

function sydOffsetHours() {
  const now = new Date();
  const sydStr = now.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false });
  const timePart = sydStr.split(', ')[1] || sydStr.split(' ')[1];
  const h = parseInt(timePart.split(':')[0]);
  const utcH = now.getUTCHours();
  let offset = h - utcH;
  if (offset < -12) offset += 24;
  if (offset > 12)  offset -= 24;
  return offset;
}
const SYD_OFFSET = sydOffsetHours();

function sydHour(nemTimeStr) {
  const t = new Date(nemTimeStr);
  return ((t.getUTCHours() + SYD_OFFSET) % 24 + 24) % 24;
}

function sydHourLocal(isoLocal) {
  return parseInt(isoLocal.split('T')[1].split(':')[0]);
}

function fmtTime(nemTimeStr) {
  const t = new Date(nemTimeStr);
  const hh = ((t.getUTCHours() + SYD_OFFSET) % 24 + 24) % 24;
  const mm = t.getUTCMinutes();
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

// ── Fetch Amber prices ────────────────────────────────────────────────────────
async function fetchPrices() {
  const data = await httpsGet(
    `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=350`,
    AMBER_TOKEN
  );
  const byTime = {};
  data.forEach(x => {
    const t = x.nemTime;
    if (!byTime[t]) byTime[t] = { nemTime: t };
    if (x.channelType === 'general') {
      byTime[t].buy      = x.perKwh;          // c/kWh, positive = cost
      byTime[t].demandWindow = x.tariffInformation?.demandWindow || false;
      byTime[t].descriptor = x.descriptor;
    }
    if (x.channelType === 'feedIn') {
      // feedIn perKwh is negative in Amber API (they represent it as a charge)
      // actual revenue = abs value
      byTime[t].feedin = Math.abs(x.perKwh);   // c/kWh received when selling
    }
  });
  return Object.values(byTime)
    .filter(x => x.buy !== undefined)
    .sort((a, b) => new Date(a.nemTime) - new Date(b.nemTime));
}

// ── PV forecast ───────────────────────────────────────────────────────────────
function pvKwForHour(sw_wm2, cloud_pct) {
  const cloudFactor = 1 - (cloud_pct / 100) * 0.5;
  return Math.max(0, PANEL_KWP * (sw_wm2 / 1000) * cloudFactor * 0.85);
}

// ── LP model ──────────────────────────────────────────────────────────────────
// Decision variables per interval i:
//   gc[i]  = grid charge (kWh bought from grid to charge battery)
//   su[i]  = self-use discharge (kWh from battery to cover home load, avoids buying)
//   ge[i]  = grid export discharge (kWh from battery sold to grid)
//   s[i]   = battery SOC at start of interval i (kWh)
//
// PV flows:
//   pv_load[i] = min(pv, load) — PV direct to home (no cost/revenue)
//   pv_batt[i] = max(pv - load, 0) — excess PV to battery (free)
//   pv_export[i] = overflow when battery full (not modelled as variable, simplified)
//
// Objective: minimize
//   Σ gc[i] * buy_price[i] * h        (cost of grid charging)
//   - Σ ge[i] * feedin_price[i] * h   (revenue from selling)
//   - Σ su[i] * buy_price[i] * h      (value of avoided grid purchase)
//   + demand_peak * DEMAND_RATE        (demand charge)
//
// Because su saves buy_price, its cost contribution is negative → LP will use battery during high-price periods

function buildLP(intervals, pvMap, initSOC_kwh) {
  const n = intervals.length;
  const model = {
    optimize: 'cost',
    opType: 'min',
    constraints: {},
    variables: {},
  };

  let demandVarAdded = false;

  intervals.forEach((iv, i) => {
    const buyP   = (iv.buy    || 15) / 100;   // $/kWh
    const feedP  = (iv.feedin || 5)  / 100;   // $/kWh
    const h      = sydHour(iv.nemTime);
    const load   = homeLoadKw(h);              // kW
    const pv     = pvMap[i] || 0;             // kW
    const inDW   = (h >= DW_START_H && h < DW_END_H);

    // PV split
    const pvToLoad  = Math.min(pv, load);           // kW direct to home
    const pvExcess  = Math.max(0, pv - load);        // kW to battery/export
    const pvCharge  = pvExcess * INTERVAL_H * CHARGE_EFF;  // kWh to battery
    const residLoad = Math.max(0, load - pv);        // kW still needed after PV

    // Variables
    const gcVar = `gc${i}`;  // grid charge (kWh)
    const suVar = `su${i}`;  // self-use discharge (kWh out of battery → home)
    const geVar = `ge${i}`;  // grid export (kWh out of battery → grid)
    const sVar  = `s${i}`;
    const sNext = `s${i+1}`;

    model.variables[sVar]  = model.variables[sVar]  || {};
    model.variables[sNext] = model.variables[sNext] || {};

    // gc: costs buy_price per kWh grid bought
    model.variables[gcVar] = { cost: buyP * INTERVAL_H };
    model.constraints[`gcMax${i}`] = { max: MAX_CHARGE_KW * INTERVAL_H };
    model.variables[gcVar][`gcMax${i}`] = 1;
    model.constraints[`gcMin${i}`] = { min: 0 };
    model.variables[gcVar][`gcMin${i}`] = 1;
    if (inDW) {
      // No grid charging during demand window
      model.constraints[`gcDW${i}`] = { max: 0 };
      model.variables[gcVar][`gcDW${i}`] = 1;
    }

    // su: saves buy_price per kWh (so cost = -buyP per kWh delivered to home)
    // But battery efficiency: 1 kWh from battery → 1/eff kWh actually drawn
    // Value per kWh discharged from battery = buyP * eff (round-trip loss)
    model.variables[suVar] = { cost: -buyP * DISCHARGE_EFF * INTERVAL_H };
    // su limited by residual load (can't self-use more than load - pv)
    const maxSu = residLoad * INTERVAL_H / DISCHARGE_EFF;  // kWh from battery to deliver residLoad
    model.constraints[`suMax${i}`] = { max: Math.max(0, maxSu) };
    model.variables[suVar][`suMax${i}`] = 1;
    model.constraints[`suMin${i}`] = { min: 0 };
    model.variables[suVar][`suMin${i}`] = 1;

    // ge: earns feedin per kWh
    model.variables[geVar] = { cost: -feedP * DISCHARGE_EFF * INTERVAL_H };
    model.constraints[`geMax${i}`] = { max: MAX_DISCHARGE_KW * INTERVAL_H };
    model.variables[geVar][`geMax${i}`] = 1;
    model.constraints[`geMin${i}`] = { min: 0 };
    model.variables[geVar][`geMin${i}`] = 1;

    // Total discharge rate: su + ge ≤ MAX_DISCHARGE_KW * h
    model.constraints[`dTot${i}`] = { max: MAX_DISCHARGE_KW * INTERVAL_H };
    model.variables[suVar][`dTot${i}`] = 1;
    model.variables[geVar][`dTot${i}`] = 1;

    // SOC balance: s[i+1] = s[i] + gc[i]*eff + pvCharge - su[i] - ge[i]
    // => s[i+1] - s[i] - gc[i]*eff + su[i] + ge[i] = pvCharge
    const balKey = `bal${i}`;
    model.constraints[balKey] = { equal: pvCharge };
    model.variables[sNext][balKey] = 1;
    model.variables[sVar] [balKey] = -1;
    model.variables[gcVar][balKey] = -CHARGE_EFF;
    model.variables[suVar][balKey] = 1;
    model.variables[geVar][balKey] = 1;

    // SOC bounds
    model.constraints[`sMin${i}`] = { min: SOC_MIN * BATTERY_CAPACITY_KWH };
    model.variables[sVar][`sMin${i}`] = 1;
    model.constraints[`sMax${i}`] = { max: SOC_MAX * BATTERY_CAPACITY_KWH };
    model.variables[sVar][`sMax${i}`] = 1;

    // Demand charge: track peak grid import during demand window
    if (inDW) {
      if (!demandVarAdded) {
        model.variables['demand_peak'] = { cost: DEMAND_CHARGE_RATE };
        demandVarAdded = true;
      }
      // Grid import during DW = gc[i]/h (in kW) + residLoad - su[i]*eff/h
      // demand_peak >= grid_import in each interval
      // Simplified: demand_peak >= gc[i]/h + max(residLoad - su[i]*eff/h, 0)
      // As LP constraint (linearised): demand_peak*h >= gc[i] + residLoad*h - su[i]*eff
      const dpKey = `dp${i}`;
      model.constraints[dpKey] = { min: residLoad * INTERVAL_H };
      model.variables['demand_peak'][dpKey] = INTERVAL_H;
      model.variables[gcVar][dpKey] = -1;
      model.variables[suVar][dpKey] = DISCHARGE_EFF;
    }
  });

  // Fix initial SOC
  model.variables['s0'] = model.variables['s0'] || {};
  model.constraints['s0_init'] = { equal: initSOC_kwh };
  model.variables['s0']['s0_init'] = 1;
  model.variables[`s${n}`] = model.variables[`s${n}`] || { cost: 0 };

  return model;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const sydH = (now.getUTCHours() + SYD_OFFSET + 24) % 24;
  const sydM = now.getUTCMinutes();
  console.log(`\n🕐 Sydney time: ${String(sydH).padStart(2,'0')}:${String(sydM).padStart(2,'0')} (UTC+${SYD_OFFSET})`);

  // Current SOC
  const roDb = new Database(DB_PATH, { readonly: true });
  const latest = roDb.prepare('SELECT soc FROM energy_log ORDER BY ts DESC LIMIT 1').get();
  const frow   = roDb.prepare("SELECT forecast_json FROM solar_forecast ORDER BY fetched_at DESC LIMIT 1").get();
  roDb.close();

  const currentSOC = latest?.soc || 54;
  const initSOC_kwh = (currentSOC / 100) * BATTERY_CAPACITY_KWH;
  console.log(`🔋 Current SOC: ${currentSOC}% (${initSOC_kwh.toFixed(1)} kWh / ${BATTERY_CAPACITY_KWH}kWh)`);

  // Solar forecast
  const forecast = JSON.parse(frow.forecast_json);
  const todayDate = new Date();
  const today = todayDate.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // YYYY-MM-DD
  const solarByHour = {};
  forecast.time.forEach((t, i) => {
    if (t.startsWith(today)) {
      const h = sydHourLocal(t);
      solarByHour[h] = pvKwForHour(forecast.sw[i], forecast.cloud[i]);
    }
  });

  console.log(`\n☀️  PV forecast (${today}, Sydney) — SYD UTC+${SYD_OFFSET}:`);
  for (let h = 6; h <= 19; h++) {
    const kw = solarByHour[h] || 0;
    const bar = '█'.repeat(Math.round(kw / 0.5));
    console.log(`  ${String(h).padStart(2,'0')}:00  ${kw.toFixed(2).padStart(5)} kW  ${bar}`);
  }
  const totalPvEst = Object.values(solarByHour).reduce((s,v) => s+v, 0);
  console.log(`  Est. total PV: ~${totalPvEst.toFixed(1)} kWh`);

  // Amber prices
  console.log('\n📡 Fetching Amber forecast prices...');
  const priceIntervals = await fetchPrices();
  console.log(`  Got ${priceIntervals.length} price intervals`);

  // Map pv to each interval
  const pvMap = priceIntervals.map(iv => solarByHour[sydHour(iv.nemTime)] || 0);

  // Solve LP
  console.log('\n🧮 Running LP optimizer (v2)...');
  const model = buildLP(priceIntervals, pvMap, initSOC_kwh);
  const result = solver.Solve(model);

  if (!result.feasible) {
    console.error('❌ LP infeasible');
    console.log('  Constraints may be too tight. Try relaxing SOC_MIN or MAX_CHARGE_KW');
    process.exit(1);
  }

  // ── Print Schedule ──────────────────────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
  console.log(` LP OPTIMAL SCHEDULE — ${today} (UTC+${SYD_OFFSET})  SOC ${currentSOC}% → target ${SOC_MAX*100}%`);
  console.log('╚═══════════════════════════════════════════════════════════════════════╝');
  console.log(' Time   Buy¢  Fdin¢  PV kW  Load  GridChg  SelfUse  GridExp  SOC%  Action');
  console.log('───────────────────────────────────────────────────────────────────────');

  let totGridChgKwh = 0, totGridChgCost = 0;
  let totSelfUseKwh = 0, totSelfUseSave = 0;
  let totGridExpKwh = 0, totGridExpRev  = 0;
  let totPvKwh = 0;
  let demandPeakKw = 0;

  // Track SOC for printing
  let printSoc = initSOC_kwh;
  const socTrace = [initSOC_kwh];

  priceIntervals.forEach((iv, i) => {
    const gc  = result[`gc${i}`] || 0;
    const su  = result[`su${i}`] || 0;
    const ge  = result[`ge${i}`] || 0;
    const s_i = result[`s${i}`]  || 0;
    const soc_pct = Math.round((s_i / BATTERY_CAPACITY_KWH) * 100);

    const buyP  = (iv.buy    || 15) / 100;
    const feedP = (iv.feedin || 5)  / 100;
    const h     = sydHour(iv.nemTime);
    const pv    = pvMap[i];
    const load  = homeLoadKw(h);
    const inDW  = (h >= DW_START_H && h < DW_END_H);

    totGridChgKwh  += gc;
    totGridChgCost += gc * buyP;
    totSelfUseKwh  += su;
    totSelfUseSave += su * buyP * DISCHARGE_EFF;
    totGridExpKwh  += ge;
    totGridExpRev  += ge * feedP * DISCHARGE_EFF;
    totPvKwh       += pv * INTERVAL_H;

    // Track demand peak during DW
    const gridImportKw = (gc / INTERVAL_H) + Math.max(0, load - pv - su * DISCHARGE_EFF / INTERVAL_H);
    if (inDW && gridImportKw > demandPeakKw) demandPeakKw = gridImportKw;

    // Print every 30 min or when action
    const hasAction = (gc > 0.005 || su > 0.005 || ge > 0.005);
    const t = new Date(iv.nemTime);
    const mm = t.getUTCMinutes();
    const show = hasAction || mm === 0 || mm === 30;

    if (show) {
      const action = gc > 0.005 ? `⚡CHARGE ${(gc/INTERVAL_H).toFixed(1)}kW` :
                     ge > 0.005 ? `💰SELL ${(ge/INTERVAL_H).toFixed(1)}kW` :
                     su > 0.005 ? `🔋SELF-USE ${(su/INTERVAL_H).toFixed(1)}kW` :
                     pv > 0.2   ? `☀️ PV→home` : `💤 idle`;
      const dwM = inDW ? '🌆' : '  ';
      const gcS = gc > 0.005 ? (gc/INTERVAL_H).toFixed(1).padStart(7) : '       ';
      const suS = su > 0.005 ? (su/INTERVAL_H).toFixed(1).padStart(7) : '       ';
      const geS = ge > 0.005 ? (ge/INTERVAL_H).toFixed(1).padStart(7) : '       ';
      console.log(
        ` ${fmtTime(iv.nemTime)}  ${(iv.buy||0).toFixed(1).padStart(5)}  ${(iv.feedin||0).toFixed(1).padStart(5)}  ` +
        `${pv.toFixed(2).padStart(5)}  ${load.toFixed(1).padStart(4)}  ` +
        `${gcS}  ${suS}  ${geS}  ${String(soc_pct).padStart(4)}%${dwM}  ${action}`
      );
    }
  });

  const demandCharge = demandPeakKw * DEMAND_CHARGE_RATE;
  const netCost = totGridChgCost - totSelfUseSave - totGridExpRev + demandCharge;

  console.log('───────────────────────────────────────────────────────────────────────');
  console.log('\n📊 LP Summary:');
  console.log(`  PV generation (est):     ${totPvKwh.toFixed(2)} kWh`);
  console.log(`  Grid charge:             ${totGridChgKwh.toFixed(2)} kWh → cost $${totGridChgCost.toFixed(3)}`);
  console.log(`  Self-use discharge:      ${totSelfUseKwh.toFixed(2)} kWh → saves $${totSelfUseSave.toFixed(3)}`);
  console.log(`  Grid export:             ${totGridExpKwh.toFixed(2)} kWh → earns $${totGridExpRev.toFixed(3)}`);
  console.log(`  Demand peak (DW):        ${demandPeakKw.toFixed(2)} kW → charge $${demandCharge.toFixed(3)}`);
  console.log(`  ──────────────────────────────────────`);
  console.log(`  LP NET COST:             $${netCost.toFixed(3)}`);

  // ── Rule-based comparison ───────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(' RULE-BASED STRATEGY (heuristic comparison)');
  console.log('╚══════════════════════════════════════════════════╝');

  let rbSOC = initSOC_kwh;
  let rbGridChgCost = 0, rbSelfSave = 0, rbExpRev = 0, rbDemandPk = 0;

  priceIntervals.forEach((iv, i) => {
    const pv    = pvMap[i];
    const load  = homeLoadKw(sydHour(iv.nemTime));
    const buyP  = (iv.buy    || 15) / 100;
    const feedP = (iv.feedin || 5)  / 100;
    const h     = sydHour(iv.nemTime);
    const inDW  = (h >= DW_START_H && h < DW_END_H);

    // PV: excess charges battery
    const pvExcess = Math.max(0, pv - load);
    const pvCharge = Math.min(pvExcess * INTERVAL_H * CHARGE_EFF,
                               SOC_MAX * BATTERY_CAPACITY_KWH - rbSOC);
    rbSOC = Math.min(rbSOC + pvCharge, SOC_MAX * BATTERY_CAPACITY_KWH);

    // Self-use from battery during DW if price is high
    if (inDW && load > pv) {
      const need = (load - pv) * INTERVAL_H;
      const avail = Math.max(0, rbSOC - SOC_MIN * BATTERY_CAPACITY_KWH);
      const discharge = Math.min(need / DISCHARGE_EFF, avail);
      rbSOC -= discharge;
      rbSelfSave += discharge * DISCHARGE_EFF * buyP;
    }

    // Grid charge in morning if cheap and SOC < 85%
    if (!inDW && h < 15 && h >= 7 && rbSOC < SOC_MAX * BATTERY_CAPACITY_KWH && buyP < 0.15) {
      const space = SOC_MAX * BATTERY_CAPACITY_KWH - rbSOC;
      const charge = Math.min(MAX_CHARGE_KW * INTERVAL_H * CHARGE_EFF, space);
      rbSOC += charge;
      rbGridChgCost += charge / CHARGE_EFF * buyP;
    }

    // Demand tracking
    const rbGridImport = Math.max(0, (load - pv) * (inDW ? 1 : 0));
    if (inDW && rbGridImport > rbDemandPk) rbDemandPk = rbGridImport;
  });

  const rbDemandCharge = rbDemandPk * DEMAND_CHARGE_RATE;
  const rbNet = rbGridChgCost - rbSelfSave - rbExpRev + rbDemandCharge;

  console.log(`  Grid charge cost:   $${rbGridChgCost.toFixed(3)}`);
  console.log(`  Self-use savings:  -$${rbSelfSave.toFixed(3)}`);
  console.log(`  Grid export rev:   -$${rbExpRev.toFixed(3)}`);
  console.log(`  Demand charge:      $${rbDemandCharge.toFixed(3)}`);
  console.log(`  ──────────────────────────────────`);
  console.log(`  RULE-BASED NET:     $${rbNet.toFixed(3)}`);

  const saving = rbNet - netCost;
  console.log(`\n💡 LP vs Rules improvement: $${saving.toFixed(3)}/day (${saving > 0 ? 'LP wins' : 'rules win'})`);

  // ── Today's Key Recommendations ────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log(` 📋 TODAY'S BATTERY STRATEGY (${today})`);
  console.log('╚══════════════════════════════════════════════════════╝');

  const morningPrices = priceIntervals.filter(iv => { const h=sydHour(iv.nemTime); return h>=8&&h<15; });
  const cheapMorn = morningPrices.filter(x => x.buy < 12);
  const dwPrices  = priceIntervals.filter(iv => { const h=sydHour(iv.nemTime); return h>=15&&h<20; });
  const maxBuyDW  = Math.max(...dwPrices.map(x => x.buy));
  const maxFeedDW = Math.max(...dwPrices.map(x => x.feedin||0));

  const pvMornMax = Math.max(...[8,9,10,11,12,13,14].map(h => solarByHour[h]||0));
  const pvMornLabel = pvMornMax >= 3 ? 'good' : pvMornMax >= 1.5 ? 'moderate/cloudy' : 'low/overcast';
  console.log(`\n  1️⃣  MORNING (08:00–14:00): PV today is ${pvMornLabel} (peak ~${pvMornMax.toFixed(1)}kW)`);
  console.log(`     → SOC currently ${currentSOC}% — battery is below target`);
  if (cheapMorn.length > 0) {
    console.log(`     → ${cheapMorn.length} intervals with price < 12¢ available (down to ${Math.min(...cheapMorn.map(x=>x.buy)).toFixed(1)}¢)`);
    console.log(`     ✅ Consider grid top-up: charge 3–4 kW when price < 12¢`);
  }

  const midPvPeak = Math.max(...[10,11,12,13,14].map(h=>solarByHour[h]||0));
  const avgMornBuy = morningPrices.length ? (morningPrices.reduce((s,x)=>s+x.buy,0)/morningPrices.length).toFixed(1) : '?';
  console.log(`\n  2️⃣  MIDDAY (10:00–15:00): PV peak ${midPvPeak.toFixed(1)}kW, avg price ${avgMornBuy}¢`);
  const pvMidEst = [10,11,12,13,14].reduce((s,h)=>(solarByHour[h]||0)+s,0);
  const socNeedKwh = Math.max(0, (SOC_MAX - currentSOC/100) * BATTERY_CAPACITY_KWH);
  const pvSufficient = pvMidEst >= socNeedKwh * 0.8;
  console.log(`     → Est. midday PV: ~${pvMidEst.toFixed(1)} kWh; need ~${socNeedKwh.toFixed(1)} kWh to reach ${SOC_MAX*100}%`);
  if (pvSufficient) {
    console.log(`     ✅ PV alone should get you close to target — grid top-up minimal`);
  } else {
    const deficit = (socNeedKwh - pvMidEst).toFixed(1);
    console.log(`     ⚠️  PV deficit ~${deficit} kWh — grid top-up needed (charge when price < 10¢)`);
  }

  // Section 3: DW or afternoon strategy — based on actual Amber API data
  const dwIntervalsFwd = priceIntervals.filter(iv => iv.demandWindow === true);
  if (dwIntervalsFwd.length > 0) {
    const dwH1 = Math.min(...dwIntervalsFwd.map(iv => sydHour(iv.nemTime)));
    const dwH2 = Math.max(...dwIntervalsFwd.map(iv => sydHour(iv.nemTime))) + 1;
    const maxBuyDW2  = Math.max(...dwIntervalsFwd.map(x => x.buy));
    const maxFeedDW2 = Math.max(...dwIntervalsFwd.map(x => x.feedin || 0));
    console.log(`\n  3️⃣  DEMAND WINDOW (${dwH1}:00–${dwH2}:00, from Amber API): price up to ${maxBuyDW2.toFixed(1)}¢, feedin ${maxFeedDW2.toFixed(1)}¢`);
    console.log(`     → Battery supplies home load during DW`);
    console.log(`     → Grid export attractive at ${maxFeedDW2.toFixed(1)}¢ if SOC high`);
    console.log(`     ✅ Discharge: self-use first, then export surplus`);
    console.log(`     ⛔ NO grid charging during DW`);
  } else {
    // No DW today — show afternoon price trend
    const aftIntervals = priceIntervals.filter(iv => { const h=sydHour(iv.nemTime); return h>=15&&h<20; });
    const maxAft = aftIntervals.length ? Math.max(...aftIntervals.map(x=>x.buy)) : 0;
    const minAft = aftIntervals.length ? Math.min(...aftIntervals.map(x=>x.buy)) : 0;
    console.log(`\n  3️⃣  AFTERNOON (15:00–20:00): no demand window today`);
    console.log(`     → Price range: ${minAft.toFixed(1)}–${maxAft.toFixed(1)}¢ (offPeak)`);
    if (maxAft > 10) {
      console.log(`     ⚠️  Price rising after 15:00 — stop charging before prices exceed 10¢`);
    } else {
      console.log(`     ✅ Prices stay reasonable — can continue charging if needed`);
    }
  }

  console.log(`\n  4️⃣  EVENING (20:00+): prices typically 12–15¢, PV done`);
  console.log(`     ✅ Let battery discharge for home use, coast until next morning`);

  const peakEntry2 = Object.entries(solarByHour).sort((a,b)=>b[1]-a[1])[0];
  const peakKw2 = peakEntry2 ? +peakEntry2[1].toFixed(1) : 0;
  const peakH2  = peakEntry2 ? peakEntry2[0] : '?';
  const outlook2 = peakKw2 >= 3 ? 'Good' : peakKw2 >= 1.5 ? 'Moderate (cloudy)' : 'Poor (overcast)';
  console.log(`\n  ☀️  SOLAR OUTLOOK: ${outlook2} — peak ${peakKw2}kW at ${peakH2}:00 (${PANEL_KWP}kWp system)`);
  console.log(`     Est. total generation: ${totalPvEst.toFixed(1)} kWh`);

  // ── Save plan to database ──────────────────────────────────────────────────
  const db = new Database(DB_PATH);

  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      generated_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'lp',
      created_by TEXT,
      soc_at_gen REAL,
      has_demand_window INTEGER NOT NULL DEFAULT 0,
      demand_window_start INTEGER,
      demand_window_end INTEGER,
      charge_cutoff_hour INTEGER NOT NULL DEFAULT 20,
      pv_forecast_kwh REAL,
      pv_peak_kw REAL,
      charge_windows_json TEXT,
      intervals_json TEXT,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(date, version)
    )
  `);

  // Mark previous versions as inactive
  db.prepare('UPDATE daily_plan SET is_active=0 WHERE date=? AND is_active=1').run(today);

  // Get next version number
  const lastVer = db.prepare('SELECT MAX(version) as v FROM daily_plan WHERE date=?').get(today);
  const newVersion = (lastVer?.v ?? 0) + 1;

  // Build plan object
  const hasDW = priceIntervals.some(iv => iv.demandWindow === true);
  const dwIntervals = priceIntervals.filter(iv => iv.demandWindow === true);
  const dwStart = dwIntervals.length ? Math.min(...dwIntervals.map(iv => sydHour(iv.nemTime))) : null;
  const dwEnd   = dwIntervals.length ? Math.max(...dwIntervals.map(iv => sydHour(iv.nemTime))) + 1 : null;
  const cutoff  = hasDW ? dwStart : 20;

  // Charge windows: group consecutive cheap (<= 12c) non-DW intervals by hour
  const cheapHours = new Set(
    priceIntervals
      .filter(iv => !iv.demandWindow && (iv.buy||99) <= 12)
      .map(iv => sydHour(iv.nemTime))
  );
  const chargeWindows = [];
  let wStart = null;
  for (let h = 0; h <= 23; h++) {
    if (cheapHours.has(h) && wStart === null) wStart = h;
    if (!cheapHours.has(h) && wStart !== null) {
      const wIntervals = priceIntervals.filter(iv => {
        const wh = sydHour(iv.nemTime);
        return wh >= wStart && wh < h && !iv.demandWindow;
      });
      const avg = wIntervals.length ? wIntervals.reduce((s,iv)=>s+(iv.buy||0),0)/wIntervals.length : 0;
      chargeWindows.push({ startHour: wStart, endHour: h, avgPriceC: parseFloat(avg.toFixed(1)) });
      wStart = null;
    }
  }
  if (wStart !== null) {
    const wIntervals = priceIntervals.filter(iv => sydHour(iv.nemTime) >= wStart && !iv.demandWindow);
    const avg = wIntervals.length ? wIntervals.reduce((s,iv)=>s+(iv.buy||0),0)/wIntervals.length : 0;
    chargeWindows.push({ startHour: wStart, endHour: 24, avgPriceC: parseFloat(avg.toFixed(1)) });
  }

  // Intervals with LP actions
  const intervalsData = priceIntervals.map((iv, i) => {
    const gc = result[`gc${i}`] || 0;
    const ge = result[`ge${i}`] || 0;
    const su = result[`su${i}`] || 0;
    const action = gc > 0.005 ? 'charge' : ge > 0.005 ? 'sell' : su > 0.005 ? 'self-use' : 'idle';
    return {
      nemTime: iv.nemTime,
      hour: sydHour(iv.nemTime),
      buyC: parseFloat((iv.buy||0).toFixed(2)),
      feedinC: parseFloat((iv.feedin||0).toFixed(2)),
      pvKw: parseFloat((pvMap[i]||0).toFixed(3)),
      action,
      chargeKw: parseFloat((gc/INTERVAL_H).toFixed(2)),
      inDW: !!iv.demandWindow
    };
  });

  db.prepare(`
    INSERT INTO daily_plan (date, version, generated_at, source, created_by, soc_at_gen,
      has_demand_window, demand_window_start, demand_window_end, charge_cutoff_hour,
      pv_forecast_kwh, pv_peak_kw, charge_windows_json, intervals_json, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    today, newVersion, new Date().toISOString(), 'lp', 'plan-today.js', currentSOC,
    hasDW ? 1 : 0, dwStart, dwEnd, cutoff,
    totPvKwh, Math.max(...Object.values(solarByHour), 0),
    JSON.stringify(chargeWindows), JSON.stringify(intervalsData)
  );

  db.close();
  console.log(`\n📁 Plan saved → energy.db daily_plan (date=${today}, version=${newVersion}, source=lp)`);
  // Note: today-plan.json is no longer written. All plan data lives in energy.db (daily_plan table).
}

main().catch(e => { console.error(e); process.exit(1); });
