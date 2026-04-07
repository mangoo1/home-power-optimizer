#!/usr/bin/env node
/**
 * turso-sync.js — Sync local energy.db to Turso cloud (daily backup)
 * Uses @libsql/client for reliable write support.
 */

'use strict';

const path = require('path');
const { createClient } = require('@libsql/client');
const Database = require('better-sqlite3');

const TURSO_URL   = process.env.TURSO_DB_URL;
const TURSO_TOKEN = process.env.TURSO_DB_TOKEN;
const DB_PATH     = path.join(__dirname, '..', 'data', 'energy.db');

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('[turso-sync] Missing TURSO_DB_URL or TURSO_DB_TOKEN');
  process.exit(1);
}

const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // last 2 hours (cron runs every 5min, keep overlap)

  const rows = db.prepare(`
    SELECT ts, soc, batt_power, home_load, pv_power, grid_power,
           buy_price, feedin_price, spot_price, demand_window, mode,
           renewables, record_trigger, solar_wm2, cloud_cover_pct,
           meter_buy_total, meter_sell_total,
           interval_buy_aud, interval_sell_aud, interval_net_aud,
           meter_buy_delta, meter_sell_delta
    FROM energy_log WHERE ts >= ? ORDER BY ts
  `).all(since);

  const dailyRows = db.prepare(`SELECT * FROM daily_summary ORDER BY date DESC LIMIT 7`).all();
  const planRows  = db.prepare(`SELECT date, version, generated_at, source, soc_at_gen,
    has_demand_window, charge_cutoff_hour, pv_forecast_kwh, pv_peak_kw,
    charge_windows_json, intervals_json, notes, is_active
    FROM daily_plan ORDER BY generated_at DESC LIMIT 14`).all();
  const reportRows = db.prepare(`SELECT * FROM daily_plan_report ORDER BY date DESC LIMIT 7`).all();
  db.close();

  console.log(`[turso-sync] Syncing ${rows.length} energy_log + ${dailyRows.length} daily_summary + ${planRows.length} daily_plan + ${reportRows.length} daily_plan_report rows...`);

  // Sync energy_log in batches of 50
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50).map(r => ({
      sql: `INSERT OR REPLACE INTO energy_log
        (ts,soc,batt_power,home_load,pv_power,grid_power,buy_price,feedin_price,
         spot_price,demand_window,mode,renewables,record_trigger,solar_wm2,cloud_cover_pct,
         meter_buy_total,meter_sell_total,
         interval_buy_aud,interval_sell_aud,interval_net_aud,
         meter_buy_delta,meter_sell_delta)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [r.ts, r.soc, r.batt_power, r.home_load, r.pv_power, r.grid_power,
             r.buy_price, r.feedin_price, r.spot_price, r.demand_window||0, r.mode,
             r.renewables, r.record_trigger, r.solar_wm2, r.cloud_cover_pct,
             r.meter_buy_total, r.meter_sell_total,
             r.interval_buy_aud ?? null, r.interval_sell_aud ?? null, r.interval_net_aud ?? null,
             r.meter_buy_delta ?? null, r.meter_sell_delta ?? null]
    }));
    await client.batch(batch, 'write');
    process.stdout.write('.');
  }

  // Sync daily_summary
  if (dailyRows.length > 0) {
    const batch = dailyRows.map(r => ({
      sql: `INSERT OR REPLACE INTO daily_summary
        (date,home_kwh,grid_buy_kwh,grid_sell_kwh,cost_aud,earnings_aud,
         demand_peak_kw,demand_charge_est,avg_soc,min_soc,max_soc,
         meter_buy_start,meter_buy_end,meter_sell_start,meter_sell_end)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [r.date, r.home_kwh, r.grid_buy_kwh, r.grid_sell_kwh, r.cost_aud,
             r.earnings_aud, r.demand_peak_kw, r.demand_charge_est, r.avg_soc,
             r.min_soc, r.max_soc, r.meter_buy_start, r.meter_buy_end,
             r.meter_sell_start, r.meter_sell_end]
    }));
    await client.batch(batch, 'write');
  }

  // Sync daily_plan (ensure table exists first)
  await client.execute(`CREATE TABLE IF NOT EXISTS daily_plan (
    date TEXT, version INTEGER, generated_at TEXT, source TEXT, soc_at_gen REAL,
    has_demand_window INTEGER, charge_cutoff_hour INTEGER,
    pv_forecast_kwh REAL, pv_peak_kw REAL,
    charge_windows_json TEXT, intervals_json TEXT, notes TEXT, is_active INTEGER,
    PRIMARY KEY (date, version))`);
  if (planRows.length > 0) {
    const batch = planRows.map(r => ({
      sql: `INSERT OR REPLACE INTO daily_plan
        (date,version,generated_at,source,soc_at_gen,has_demand_window,charge_cutoff_hour,
         pv_forecast_kwh,pv_peak_kw,charge_windows_json,intervals_json,notes,is_active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [r.date, r.version, r.generated_at, r.source, r.soc_at_gen,
             r.has_demand_window||0, r.charge_cutoff_hour, r.pv_forecast_kwh,
             r.pv_peak_kw, r.charge_windows_json, r.intervals_json,
             r.notes, r.is_active||0]
    }));
    await client.batch(batch, 'write');
  }

  const result = await client.execute('SELECT COUNT(*) as cnt FROM energy_log');

  // Sync daily_plan_report
  await client.execute(`CREATE TABLE IF NOT EXISTS daily_plan_report (
    date TEXT PRIMARY KEY, generated_at TEXT,
    current_soc REAL, current_kwh REAL, target_soc REAL, target_kwh REAL,
    floor_soc REAL, floor_kwh REAL, needed_kwh REAL, pv_forecast_kwh REAL,
    charge_window TEXT, charge_hours REAL, avg_charge_kw REAL,
    total_charge_kwh REAL, surplus_kwh REAL,
    hw_start_h INTEGER, hw_end_h INTEGER, hw_avg_buy_c REAL,
    sell_window TEXT, avg_sell_feedin_c REAL, sell_slot_count INTEGER,
    buy_threshold_c REAL, notes TEXT)`);
  if (reportRows.length > 0) {
    const batch = reportRows.map(r => ({
      sql: `INSERT OR REPLACE INTO daily_plan_report
        (date,generated_at,current_soc,current_kwh,target_soc,target_kwh,
         floor_soc,floor_kwh,needed_kwh,pv_forecast_kwh,
         charge_window,charge_hours,avg_charge_kw,total_charge_kwh,surplus_kwh,
         hw_start_h,hw_end_h,hw_avg_buy_c,
         sell_window,avg_sell_feedin_c,sell_slot_count,buy_threshold_c,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [r.date, r.generated_at, r.current_soc, r.current_kwh, r.target_soc, r.target_kwh,
             r.floor_soc, r.floor_kwh, r.needed_kwh, r.pv_forecast_kwh,
             r.charge_window, r.charge_hours, r.avg_charge_kw, r.total_charge_kwh, r.surplus_kwh,
             r.hw_start_h, r.hw_end_h, r.hw_avg_buy_c,
             r.sell_window, r.avg_sell_feedin_c, r.sell_slot_count, r.buy_threshold_c, r.notes]
    }));
    await client.batch(batch, 'write');
  }

  console.log(`\n[turso-sync] Done ✓ (${result.rows[0].cnt} rows in Turso)`);
}

main().catch(e => { console.error('[turso-sync] ERROR:', e.message); process.exit(1); });
