#!/usr/bin/env node
/**
 * solar-forecast.js
 *
 * Fetches solar radiation + cloud cover forecast from Open-Meteo for Sydney.
 * Estimates daily PV generation based on shortwave_radiation (W/m²).
 *
 * Usage:
 *   node solar-forecast.js              # fetch and store today + tomorrow forecast
 *   node solar-forecast.js --print      # also print a summary to stdout
 *
 * Runs daily at 07:00 AEST via cron.
 * Results stored in data/energy.db → solar_forecast table.
 *
 * PV estimation formula:
 *   hourly_kwh ≈ shortwave_radiation(W/m²) × SYSTEM_SCALE_FACTOR
 *   SYSTEM_SCALE_FACTOR calibrated from historical data (pvPower vs radiation)
 *   Default: 0.010 (≈ 10kW system with ~15% efficiency * panel area factor)
 *   Tune this value once we have enough data.
 */

'use strict';

const https   = require('https');
const path    = require('path');
const fs      = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const LATITUDE  = -33.87;   // Sydney
const LONGITUDE = 151.21;
const TIMEZONE  = 'Australia/Sydney';

// PV scale factor: W/m² → kWh per hour
// Start conservative, tune after collecting data vs actual pvPower
const SYSTEM_SCALE_FACTOR = parseFloat(process.env.PV_SCALE_FACTOR ?? '0.010');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const DB_PATH   = path.join(DATA_DIR, 'energy.db');
const PRINT     = process.argv.includes('--print');

// ── Helpers ───────────────────────────────────────────────────────────────────
function httpsGet(url) {
  const { execSync } = require('child_process');
  const result = execSync(`curl -s --max-time 15 "${url}"`, { encoding: 'utf8' });
  return JSON.parse(result);
}

function getDb() {
  try {
    const Database = require('better-sqlite3');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    return new Database(DB_PATH);
  } catch { return null; }
}

// ── Fetch forecast ────────────────────────────────────────────────────────────
function fetchForecast() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&hourly=shortwave_radiation,direct_radiation,cloud_cover` +
    `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=3&models=best_match`;
  const data = httpsGet(url);
  return data.hourly;
}

// ── Estimate daily PV kWh ─────────────────────────────────────────────────────
function estimateDayKwh(hourly, date) {
  let kwhSum = 0;
  let peakWm2 = 0;
  let cloudSum = 0;
  let cloudCount = 0;

  hourly.time.forEach((t, i) => {
    if (!t.startsWith(date)) return;
    const hour = parseInt(t.substring(11, 13));
    // Solar hours only (06:00-20:00)
    if (hour < 6 || hour > 20) return;

    const sw    = hourly.shortwave_radiation[i] ?? 0;
    const cloud = hourly.cloud_cover[i] ?? 0;

    kwhSum    += sw * SYSTEM_SCALE_FACTOR;   // W/m² × factor → kWh per hour
    peakWm2    = Math.max(peakWm2, sw);
    cloudSum  += cloud;
    cloudCount++;
  });

  return {
    kwh_est:   parseFloat(kwhSum.toFixed(2)),
    peak_wm2:  peakWm2,
    cloud_avg: cloudCount > 0 ? parseFloat((cloudSum / cloudCount).toFixed(1)) : null,
  };
}

// ── Get current hour's solar data ─────────────────────────────────────────────
function getCurrentHourData(hourly) {
  const now = new Date();
  // Sydney time string: YYYY-MM-DDTHH:00
  const sydneyOffset = 11 * 3600 * 1000; // AEDT UTC+11
  const sydneyNow = new Date(now.getTime() + sydneyOffset);
  const dateStr = sydneyNow.toISOString().substring(0, 10);
  const hour    = sydneyNow.getUTCHours();
  const target  = `${dateStr}T${String(hour).padStart(2, '0')}:00`;

  const idx = hourly.time.indexOf(target);
  if (idx === -1) return null;
  return {
    solar_wm2:       hourly.shortwave_radiation[idx] ?? null,
    cloud_cover_pct: hourly.cloud_cover[idx] ?? null,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const now = new Date();
  const sydneyNow = new Date(now.getTime() + 11 * 3600 * 1000);
  const today    = sydneyNow.toISOString().substring(0, 10);
  const tomorrow = new Date(sydneyNow.getTime() + 86400000).toISOString().substring(0, 10);

  console.log(`[solar-forecast] Fetching for ${today} / ${tomorrow} ...`);
  const hourly = fetchForecast();

  const todayStats    = estimateDayKwh(hourly, today);
  const tomorrowStats = estimateDayKwh(hourly, tomorrow);
  const currentHour   = getCurrentHourData(hourly);

  console.log(`[TODAY    ${today}] est=${todayStats.kwh_est}kWh  peak=${todayStats.peak_wm2}W/m²  cloud_avg=${todayStats.cloud_avg}%`);
  console.log(`[TOMORROW ${tomorrow}] est=${tomorrowStats.kwh_est}kWh  peak=${tomorrowStats.peak_wm2}W/m²  cloud_avg=${tomorrowStats.cloud_avg}%`);
  if (currentHour) {
    console.log(`[NOW] solar=${currentHour.solar_wm2}W/m²  cloud=${currentHour.cloud_cover_pct}%`);
  }

  // Store in DB
  const db = getDb();
  if (db) {
    try {
      db.prepare(`
        INSERT INTO solar_forecast (date, fetched_at, forecast_json,
          today_kwh_est, tomorrow_kwh_est,
          today_peak_wm2, tomorrow_peak_wm2,
          today_cloud_avg, tomorrow_cloud_avg)
        VALUES (@date, @fetchedAt, @json,
          @todayKwh, @tomorrowKwh,
          @todayPeak, @tomorrowPeak,
          @todayCloud, @tomorrowCloud)
        ON CONFLICT(date) DO UPDATE SET
          fetched_at        = @fetchedAt,
          forecast_json     = @json,
          today_kwh_est     = @todayKwh,
          tomorrow_kwh_est  = @tomorrowKwh,
          today_peak_wm2    = @todayPeak,
          tomorrow_peak_wm2 = @tomorrowPeak,
          today_cloud_avg   = @todayCloud,
          tomorrow_cloud_avg = @tomorrowCloud
      `).run({
        date:          today,
        fetchedAt:     now.toISOString(),
        json:          JSON.stringify({ time: hourly.time, sw: hourly.shortwave_radiation, cloud: hourly.cloud_cover }),
        todayKwh:      todayStats.kwh_est,
        tomorrowKwh:   tomorrowStats.kwh_est,
        todayPeak:     todayStats.peak_wm2,
        tomorrowPeak:  tomorrowStats.peak_wm2,
        todayCloud:    todayStats.cloud_avg,
        tomorrowCloud: tomorrowStats.cloud_avg,
      });
      console.log(`[solar-forecast] Stored in DB ✓`);
    } catch(e) { console.warn('[solar-forecast] DB write failed:', e.message); }
    db.close();
  }

  return { today: todayStats, tomorrow: tomorrowStats, current: currentHour };
}

try {
  main();
} catch(e) {
  console.error('[solar-forecast] ERROR:', e.message);
  process.exit(1);
}
