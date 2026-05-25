#!/usr/bin/env node
/**
 * record-weather.js — 记录天气预报到 energy.db
 * 拉取 Open-Meteo 未来2天预报，存入 weather_forecast 表
 * 用法: node scripts/record-weather.js [--days 3]
 * 建议: 每天早上 06:00 cron 运行一次
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'energy.db');
const LAT = -33.87;
const LON = 151.21;

async function main() {
  const days = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--days') || '2');

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + `&daily=weathercode,sunshine_duration,shortwave_radiation_sum,temperature_2m_max,temperature_2m_min,rain_sum,cloud_cover_mean`
    + `&hourly=shortwave_radiation,cloud_cover`
    + `&timezone=Australia/Sydney&forecast_days=${days}`;

  console.log(`[weather] 拉取 ${days} 天预报...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  const data = await resp.json();

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 确保表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS weather_forecast (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      forecast_date TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      weathercode INTEGER,
      sunshine_hours REAL,
      radiation_sum_mj REAL,
      temp_max REAL,
      temp_min REAL,
      rain_sum_mm REAL,
      cloud_cover_mean REAL,
      hourly_radiation_json TEXT,
      pv_estimate_kwh REAL,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_weather_date ON weather_forecast(forecast_date);
  `);

  const insert = db.prepare(`
    INSERT INTO weather_forecast
      (forecast_date, recorded_at, weathercode, sunshine_hours, radiation_sum_mj,
       temp_max, temp_min, rain_sum_mm, cloud_cover_mean, hourly_radiation_json, pv_estimate_kwh, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();

  for (let i = 0; i < data.daily.time.length; i++) {
    const date = data.daily.time[i];
    const sunH = data.daily.sunshine_duration[i] / 3600;
    const radMJ = data.daily.shortwave_radiation_sum[i];

    // 提取该天逐时辐射
    const hourlyRad = [];
    data.hourly.time.forEach((t, j) => {
      if (t.startsWith(date) && data.hourly.shortwave_radiation[j] > 0) {
        hourlyRad.push({
          hour: parseInt(t.slice(11, 13)),
          wm2: data.hourly.shortwave_radiation[j],
          cloud: data.hourly.cloud_cover[j]
        });
      }
    });

    // 简易PV估算: 4.3kWp系统, 效率~15%, 用辐射量换算
    // PV(kWh) ≈ radiation_sum(MJ/m²) × panel_area_factor × efficiency
    // 简化: 历史数据 8.9MJ→4.4kWh, 所以系数约 0.49
    const pvEstimate = Math.round(radMJ * 0.49 * 10) / 10;

    insert.run(
      date, now,
      data.daily.weathercode[i],
      Math.round(sunH * 10) / 10,
      radMJ,
      data.daily.temperature_2m_max[i],
      data.daily.temperature_2m_min[i],
      data.daily.rain_sum?.[i] ?? null,
      data.daily.cloud_cover_mean?.[i] ?? null,
      JSON.stringify(hourlyRad),
      pvEstimate,
      null
    );

    const wmoDesc = {
      0: '晴', 1: '大部晴', 2: '多云', 3: '阴', 45: '雾', 48: '冻雾',
      51: '小毛毛雨', 53: '中毛毛雨', 55: '大毛毛雨',
      61: '小雨', 63: '中雨', 65: '大雨', 80: '阵雨', 95: '雷阵雨'
    };
    const desc = wmoDesc[data.daily.weathercode[i]] || `code${data.daily.weathercode[i]}`;

    console.log(`[weather] ${date}: ${desc} | 日照${sunH.toFixed(1)}h | 辐射${radMJ}MJ/m² | PV估${pvEstimate}kWh | ${data.daily.temperature_2m_min[i]}–${data.daily.temperature_2m_max[i]}°C | 雨${data.daily.rain_sum?.[i] ?? '?'}mm`);
  }

  // ── 同步 daily_pv_weather 表 ──────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_pv_weather (
      date TEXT PRIMARY KEY,
      pv_actual_kwh REAL,
      pv_forecast_kwh REAL,
      cloud_cover_mean REAL,
      sunshine_hours REAL,
      radiation_sum_mj REAL,
      weathercode INTEGER,
      rain_mm REAL,
      notes TEXT
    )
  `);

  // 更新预报数据
  const upsertPvW = db.prepare(`
    INSERT INTO daily_pv_weather (date, pv_forecast_kwh, cloud_cover_mean, sunshine_hours, radiation_sum_mj, weathercode, rain_mm)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      pv_forecast_kwh=excluded.pv_forecast_kwh,
      cloud_cover_mean=excluded.cloud_cover_mean,
      sunshine_hours=excluded.sunshine_hours,
      radiation_sum_mj=excluded.radiation_sum_mj,
      weathercode=excluded.weathercode,
      rain_mm=excluded.rain_mm
  `);
  for (let i = 0; i < data.daily.time.length; i++) {
    const date = data.daily.time[i];
    const sunH = (data.daily.sunshine_duration[i] || 0) / 3600;
    const radMJ = Math.round((data.daily.shortwave_radiation_sum[i] || 0) / 100) / 10;
    const pvEst = Math.round(radMJ * 0.49 * 10) / 10;
    upsertPvW.run(date, pvEst, data.daily.cloud_cover_mean?.[i], Math.round(sunH*10)/10, radMJ, data.daily.weathercode[i], data.daily.rain_sum?.[i]);
  }

  // 回填昨天的实际 PV（如果还没填）
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yRow = db.prepare("SELECT pv_actual_kwh FROM daily_pv_weather WHERE date=?").get(yesterday);
  if (!yRow || yRow.pv_actual_kwh === null) {
    const actual = db.prepare(`
      SELECT sum(pv_power)/12.0 as kwh FROM energy_log
      WHERE date(ts, '+10 hours')=? AND pv_power >= 0
    `).get(yesterday);
    if (actual?.kwh > 0) {
      db.prepare("INSERT INTO daily_pv_weather (date, pv_actual_kwh) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET pv_actual_kwh=excluded.pv_actual_kwh")
        .run(yesterday, parseFloat(actual.kwh.toFixed(2)));
      console.log(`[weather] 回填昨日 PV 实际: ${yesterday} = ${actual.kwh.toFixed(2)}kWh`);
    }
  }

  db.close();
  console.log(`[weather] ✅ 已记录 ${data.daily.time.length} 天预报 + daily_pv_weather 同步`);
}

main().catch(e => { console.error('[weather] ❌', e.message); process.exit(1); });
