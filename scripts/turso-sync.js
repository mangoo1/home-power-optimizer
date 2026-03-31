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
  const since = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT ts, soc, batt_power, home_load, pv_power, grid_power,
           buy_price, feedin_price, spot_price, demand_window, mode,
           renewables, record_trigger, solar_wm2, cloud_cover_pct,
           meter_buy_total, meter_sell_total
    FROM energy_log WHERE ts >= ? ORDER BY ts
  `).all(since);

  const dailyRows = db.prepare(`SELECT * FROM daily_summary ORDER BY date DESC LIMIT 7`).all();
  db.close();

  console.log(`[turso-sync] Syncing ${rows.length} energy_log + ${dailyRows.length} daily_summary rows...`);

  // Sync energy_log in batches of 50
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50).map(r => ({
      sql: `INSERT OR REPLACE INTO energy_log
        (ts,soc,batt_power,home_load,pv_power,grid_power,buy_price,feedin_price,
         spot_price,demand_window,mode,renewables,record_trigger,solar_wm2,cloud_cover_pct,
         meter_buy_total,meter_sell_total)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [r.ts, r.soc, r.batt_power, r.home_load, r.pv_power, r.grid_power,
             r.buy_price, r.feedin_price, r.spot_price, r.demand_window||0, r.mode,
             r.renewables, r.record_trigger, r.solar_wm2, r.cloud_cover_pct,
             r.meter_buy_total, r.meter_sell_total]
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

  const result = await client.execute('SELECT COUNT(*) as cnt FROM energy_log');
  console.log(`\n[turso-sync] Done ✓ (${result.rows[0].cnt} rows in Turso)`);
}

main().catch(e => { console.error('[turso-sync] ERROR:', e.message); process.exit(1); });
