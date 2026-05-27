#!/usr/bin/env node
/**
 * v2/insert-manual-plan.js — 安全插入手动计划并激活
 *
 * 用法：
 *   node v2/insert-manual-plan.js '2026-05-27' '{"intervals":[...],"notes":{...}}'
 *
 * 或者作为模块引用：
 *   const { insertManualPlan } = require('./insert-manual-plan');
 *   insertManualPlan(db, { date, intervals, notes, chargeTargetPct, buyThresholdC });
 *
 * 关键保证：
 *   1. 自动 deactivate 同日旧计划
 *   2. 新计划一定 is_active=1
 *   3. version 自动递增
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'energy.db');

/**
 * 插入手动计划并激活
 * @param {Database} db - better-sqlite3 实例（可选，不传则自动打开）
 * @param {object} opts
 * @param {string} opts.date - 计划日期 YYYY-MM-DD
 * @param {Array} opts.intervals - 半小时时段数组
 * @param {object} opts.notes - 计划备注（含 hardwareTasks 等）
 * @param {number} [opts.chargeTargetPct=65] - 充电目标百分比
 * @param {number} [opts.buyThresholdC=20] - 买价阈值
 * @param {number} [opts.sellMinC=10] - 卖电最低价
 * @param {string} [opts.chargeWindowsJson='[]'] - 充电窗口 JSON
 * @returns {object} { id, version, date }
 */
function insertManualPlan(db, opts) {
  const {
    date,
    intervals,
    notes = {},
    chargeTargetPct = 65,
    buyThresholdC = 20,
    sellMinC = 10,
    chargeWindowsJson = '[]',
  } = opts;

  if (!date || !intervals) {
    throw new Error('date and intervals are required');
  }

  // 1. 获取当前最大 version
  const maxRow = db.prepare(
    "SELECT MAX(version) as maxV FROM daily_plan WHERE date=?"
  ).get(date);
  const newVersion = (maxRow?.maxV ?? 0) + 1;

  // 2. Deactivate 同日所有旧计划
  db.prepare("UPDATE daily_plan SET is_active=0 WHERE date=?").run(date);

  // 3. 计算 SOC（取最新值）
  const socRow = db.prepare(
    "SELECT soc FROM energy_log ORDER BY ts DESC LIMIT 1"
  ).get();
  const socAtGen = socRow?.soc ?? null;

  // 4. 构建 notes
  const fullNotes = {
    strategy: 'manual',
    chargeTargetPct,
    ...notes,
  };

  // 5. 插入新计划，is_active=1
  const stmt = db.prepare(`
    INSERT INTO daily_plan (
      date, version, generated_at, source, created_by,
      soc_at_gen, has_demand_window,
      charge_cutoff_hour, pv_forecast_kwh, pv_peak_kw,
      charge_windows_json, intervals_json, notes,
      is_active, buy_threshold_c, sell_min_c
    ) VALUES (
      @date, @version, @generated_at, 'manual', 'dan-manual',
      @soc_at_gen, 0,
      15, 0, 0,
      @charge_windows_json, @intervals_json, @notes,
      1, @buy_threshold_c, @sell_min_c
    )
  `);

  const info = stmt.run({
    date,
    version: newVersion,
    generated_at: new Date().toISOString(),
    soc_at_gen: socAtGen,
    charge_windows_json: chargeWindowsJson,
    intervals_json: JSON.stringify(intervals),
    notes: JSON.stringify(fullNotes),
    buy_threshold_c: buyThresholdC,
    sell_min_c: sellMinC,
  });

  console.log(`[手动计划] ✅ 插入成功: date=${date} version=${newVersion} id=${info.lastInsertRowid} is_active=1`);
  console.log(`[手动计划] 已 deactivate 同日 ${newVersion - 1} 个旧版本`);

  return { id: info.lastInsertRowid, version: newVersion, date };
}

// ── CLI 模式 ──────────────────────────────────────────────────
if (require.main === module) {
  const [,, dateArg, jsonArg] = process.argv;

  if (!dateArg || !jsonArg) {
    console.error('用法: node insert-manual-plan.js <date> <json>');
    console.error('  json 格式: {"intervals":[...], "notes":{...}, "chargeTargetPct":65}');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonArg);
  } catch (e) {
    console.error('JSON 解析失败:', e.message);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  try {
    const result = insertManualPlan(db, { date: dateArg, ...parsed });
    console.log('Result:', result);
  } finally {
    db.close();
  }
}

module.exports = { insertManualPlan };
