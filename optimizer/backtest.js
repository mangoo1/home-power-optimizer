#!/usr/bin/env node
/**
 * backtest.js — LP optimizer backtest against historical energy_log data
 *
 * Simulates what the LP optimizer WOULD have done on a given day,
 * then compares cost vs what the rule-based system actually spent.
 *
 * Usage:
 *   node optimizer/backtest.js [date]          # e.g. 2026-03-30
 *   node optimizer/backtest.js                 # uses yesterday
 *
 * Output: side-by-side comparison of LP vs actual cost/revenue
 */

'use strict';

const path   = require('path');
const solver = require('javascript-lp-solver');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'energy.db');

// ── Config ────────────────────────────────────────────────────────────────────
const BATTERY_CAPACITY_KWH = 42;
const SOC_MIN = 0.10;   // 10%
const SOC_MAX = 0.85;   // 85% (our current target)
const MAX_CHARGE_KW  = 5.0;
const MAX_DISCHARGE_KW = 5.0;
const DEMAND_CHARGE_RATE = 0.6104; // $/kW/day
const INTERVAL_H = 0.5;  // 30-min intervals

// Demand window: 15:00–20:00 Sydney time (in UTC+11: 04:00–09:00 UTC)
const DW_START_H = 15;
const DW_END_H   = 20;

// ── Load historical data ──────────────────────────────────────────────────────
function loadDayData(date) {
  const db = new Database(DB_PATH, { readonly: true });

  // Get all scheduled records for the day (UTC date, Sydney is UTC+11)
  // Sydney midnight = UTC 13:00 previous day
  const startUTC = `${date}T13:00:00`; // previous day 13:00 UTC = Sydney midnight
  const endUTC   = new Date(new Date(startUTC).getTime() + 24*3600*1000).toISOString().substring(0,19);

  const rows = db.prepare(`
    SELECT ts, soc, home_load, pv_power, grid_power, buy_price, feedin_price,
           demand_window, mode, interval_buy_aud, interval_sell_aud, interval_net_aud
    FROM energy_log
    WHERE ts >= ? AND ts < ? AND record_trigger = 'scheduled'
    ORDER BY ts
  `).all(startUTC, endUTC);

  db.close();
  return rows;
}

// ── Build LP problem ──────────────────────────────────────────────────────────
function buildAndSolve(intervals) {
  const n = intervals.length;
  if (n < 2) { console.error('Not enough data'); process.exit(1); }

  // Variables: charge[i], discharge[i], soc[i]  (i = 0..n-1)
  // Objective: minimize total_cost = Σ charge[i]*buyPrice[i]*intervalH - Σ discharge[i]*feedIn[i]*intervalH + demand_charge

  const model = {
    optimize: 'cost',
    opType: 'min',
    constraints: {},
    variables: {},
    ints: {},
  };

  let demandVarAdded = false;

  intervals.forEach((iv, i) => {
    const t = i;
    const buyP  = (iv.buy_price   || 15) / 100;  // $/kWh
    const feedP = (iv.feedin_price || 5)  / 100;  // $/kWh
    const load  = iv.home_load || 0;
    const pv    = iv.pv_power  || 0;
    const inDW  = iv.demand_window === 1;

    // charge[i]: kWh charged from grid this interval
    const cVar = `c${t}`;
    model.variables[cVar] = { cost: buyP * INTERVAL_H };
    model.constraints[`cMax${t}`] = { max: MAX_CHARGE_KW * INTERVAL_H };
    model.variables[cVar][`cMax${t}`] = 1;
    if (inDW) {
      // No grid charging during demand window
      model.constraints[`cDW${t}`] = { max: 0 };
      model.variables[cVar][`cDW${t}`] = 1;
    }

    // discharge[i]: kWh discharged to grid this interval (selling)
    const dVar = `d${t}`;
    model.variables[dVar] = { cost: -feedP * INTERVAL_H };
    model.constraints[`dMax${t}`] = { max: MAX_DISCHARGE_KW * INTERVAL_H };
    model.variables[dVar][`dMax${t}`] = 1;

    // SOC balance: soc[i+1] = soc[i] + charge[i] - discharge[i] - netLoad[i]
    // netLoad = load - pv (what battery must cover beyond PV)
    // We encode this as: soc[i+1] - soc[i] - c[i] + d[i] = -netLoad[i]
    const sVar  = `s${t}`;
    const sVarN = `s${t+1}`;
    const netLoad = (load - pv) * INTERVAL_H; // kWh net load this interval

    model.variables[sVar]  = model.variables[sVar]  || {};
    model.variables[sVarN] = model.variables[sVarN] || {};

    // SOC balance constraint
    const balKey = `bal${t}`;
    model.constraints[balKey] = { equal: -netLoad };
    model.variables[sVarN][balKey] = 1;
    model.variables[sVar] [balKey] = -1;
    model.variables[cVar] [balKey] = -1;  // charging increases SOC
    model.variables[dVar] [balKey] = 1;   // discharging decreases SOC

    // SOC bounds
    model.constraints[`sMin${t}`] = { min: SOC_MIN * BATTERY_CAPACITY_KWH };
    model.variables[sVar][`sMin${t}`] = 1;
    model.constraints[`sMax${t}`] = { max: SOC_MAX * BATTERY_CAPACITY_KWH };
    model.variables[sVar][`sMax${t}`] = 1;

    // Demand window: track peak grid import
    if (inDW && !demandVarAdded) {
      model.variables['demand_peak'] = { cost: DEMAND_CHARGE_RATE };
      demandVarAdded = true;
    }
    if (inDW) {
      // grid_import[i] = charge[i] + netLoad[i] (positive = import)
      // demand_peak >= grid_import[i]
      const dpKey = `dp${t}`;
      model.constraints[dpKey] = { min: 0 };
      if (demandVarAdded) {
        model.variables['demand_peak'][dpKey] = 1;
      }
      model.variables[cVar][dpKey] = -1;
      // netLoad already baked in as constant — approximate: add as RHS
      model.constraints[dpKey].min = -Math.max(0, netLoad);
    }
  });

  // Initial SOC (from first record)
  const initSOC = (intervals[0].soc / 100) * BATTERY_CAPACITY_KWH;
  model.constraints['s0_init'] = { equal: initSOC };
  model.variables['s0'] = model.variables['s0'] || {};
  model.variables['s0']['s0_init'] = 1;

  // Ensure final SOC var exists
  model.variables[`s${n}`] = model.variables[`s${n}`] || { cost: 0 };

  const result = solver.Solve(model);
  return result;
}

// ── Compare LP vs actual ──────────────────────────────────────────────────────
function compare(intervals, lpResult) {
  // Actual cost from DB
  const actualBuy  = intervals.reduce((s,r) => s + (r.interval_buy_aud  || 0), 0);
  const actualSell = intervals.reduce((s,r) => s + (r.interval_sell_aud || 0), 0);
  const actualNet  = actualBuy - actualSell;

  // LP optimal cost
  const lpCost = lpResult.result || 0;

  console.log('\n=== Backtest Results ===');
  console.log(`Intervals analysed: ${intervals.length}`);
  console.log(`\nActual (rule-based):`);
  console.log(`  Buy cost:   $${actualBuy.toFixed(3)}`);
  console.log(`  Sell revenue: $${actualSell.toFixed(3)}`);
  console.log(`  Net cost:   $${actualNet.toFixed(3)}`);
  console.log(`\nLP Optimizer (theoretical optimum):`);
  console.log(`  Net cost:   $${lpCost.toFixed(3)}`);
  console.log(`  Feasible:   ${lpResult.feasible}`);
  console.log(`\nPotential saving: $${Math.max(0, actualNet - lpCost).toFixed(3)}/day`);
  if (actualNet > 0 && lpCost < actualNet) {
    const pct = ((actualNet - lpCost) / actualNet * 100).toFixed(1);
    console.log(`Improvement: ${pct}%`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  // Target date in Sydney time
  const arg = process.argv[2];
  let date;
  if (arg) {
    date = arg;
  } else {
    // Yesterday Sydney time
    const sydney = new Date(Date.now() + 11*3600*1000);
    sydney.setUTCDate(sydney.getUTCDate() - 1);
    date = sydney.toISOString().substring(0, 10);
  }

  console.log(`Backtesting date: ${date} (Sydney)`);

  const intervals = loadDayData(date);
  if (!intervals.length) {
    console.error(`No data found for ${date}`);
    process.exit(1);
  }

  console.log(`Loaded ${intervals.length} intervals`);
  console.log(`SOC range: ${Math.min(...intervals.map(r=>r.soc))}% – ${Math.max(...intervals.map(r=>r.soc))}%`);
  console.log(`Price range: ${Math.min(...intervals.map(r=>r.buy_price||0)).toFixed(2)}c – ${Math.max(...intervals.map(r=>r.buy_price||0)).toFixed(2)}c`);

  const lpResult = buildAndSolve(intervals);
  compare(intervals, lpResult);
}

main();
