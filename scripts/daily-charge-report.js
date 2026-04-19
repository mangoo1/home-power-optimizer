#!/usr/bin/env node
/**
 * daily-charge-report.js
 *
 * 读取 plan-today.js 存入 DB 的当日计划，格式化后发送到 WhatsApp。
 * 计划算法在 plan-today.js，本脚本只负责展示。
 *
 * 用法：node scripts/daily-charge-report.js
 */
'use strict';

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'energy.db');

function getSydneyNow() {
  return new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function getSydneyDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // yyyy-mm-dd
}

function getSydneyHHMM() {
  return new Date().toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function main() {
  const db  = new Database(DB_PATH, { readonly: true });
  const today = getSydneyDate();

  // 当前计划
  const plan = db.prepare(
    "SELECT * FROM daily_plan WHERE date=? AND is_active=1 ORDER BY rowid DESC LIMIT 1"
  ).get(today);

  // 当前 SOC
  const ess = db.prepare(
    "SELECT soc FROM energy_log ORDER BY ts DESC LIMIT 1"
  ).get();
  db.close();

  if (!plan) {
    console.log(`⚠️ 今天 (${today}) 还没有充电计划，请等待 plan-today.js 运行。`);
    return;
  }

  const socPct    = ess?.soc ?? '?';
  const intervals = JSON.parse(plan.intervals_json);
  const notes     = JSON.parse(plan.notes ?? '{}');
  const timeNow   = getSydneyHHMM();

  // 过滤：只显示当前时间之后的时段
  const [nowH, nowM] = timeNow.split(':').map(Number);
  const nowMins = nowH * 60 + nowM;

  const future = intervals.filter(i => {
    if (!i.key.startsWith(today)) return false;
    const h = parseInt(i.nemTime.substring(11, 13));
    const m = parseInt(i.nemTime.substring(14, 16));
    return h * 60 + m >= nowMins;
  });

  // 动作映射
  function actionLabel(action) {
    if (action === 'charge' || action === 'charge+hw') return '⚡充电';
    if (action === 'sell') return '💰卖电';
    return '🔋自用';
  }

  // 格式化行
  const BATT_KWH = 42;
  const lines = [
    `🔋 充放电计划 ${timeNow} AEST（SOC ${socPct}%）`,
    `计划v${plan.version} | ${plan.has_demand_window ? '⚠️有DW' : '无DW'} | 充电≤${notes.buyThresholdC ?? '?'}¢ | 卖电≥${notes.sellMinC ?? '?'}¢`,
    `PV预测: ${plan.pv_forecast_kwh}kWh | 截止: ${plan.charge_cutoff_hour}:00`,
    '',
    '时间   动作      功率    买¢    卖¢   SOC',
    '──────────────────────────────────────',
  ];

  let prevAction = null;
  for (const s of future) {
    const action = actionLabel(s.action);
    const power  = s.chargeKw > 0 ? `${s.chargeKw.toFixed(2)}kW`
                 : s.action === 'sell' ? ' 5.00kW'
                 : '    -  ';
    const buy    = String(s.buyC.toFixed(1)).padStart(5) + '¢';
    const fi     = String(s.feedinC.toFixed(1)).padStart(5) + '¢';
    const soc    = String(s.socPct).padStart(3) + '%';
    const hw     = s.action === 'charge+hw' ? '🚿' : '  ';
    const dw     = s.inDW ? '⚡' : '  ';
    const time   = s.nemTime.substring(11, 16);

    // 在动作变化时加空行（除第一行）
    if (prevAction !== null && prevAction !== s.action) lines.push('');
    lines.push(`${time}  ${action.padEnd(6)} ${power.padStart(7)}  ${buy}  ${fi}  ${soc} ${hw}${dw}`);
    prevAction = s.action;
  }

  const lastSoc = future[future.length - 1]?.socPct ?? socPct;
  const lastKwh = ((lastSoc / 100) * BATT_KWH).toFixed(1);
  lines.push('──────────────────────────────────────');
  lines.push(`收盘预计: SOC ${lastSoc}%（${lastKwh}kWh）`);

  if (notes.hotWater) {
    const hw = notes.hotWater;
    lines.push(`🚿 热水器: ${hw.startH}:00–${hw.endH}:00 @ ${hw.avgBuyC}¢ PV≈${hw.avgPvKw}kW`);
  }

  const report = lines.join('\n');
  console.log(report);
  return report;
}

main();
