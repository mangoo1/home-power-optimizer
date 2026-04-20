#!/usr/bin/env node
/**
 * v2/plan-ab-compare.js — 收盘 A/B 对比（每天 23:00 跑）
 *
 * 用当天实际电价（energy_log）回测两套算法模拟计划，
 * 对比谁更省钱，结果存入 plan_ab_result。
 * 只读不写逆变器。
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'energy.db');

function sydneyDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

async function main() {
  const today = process.argv[2] || sydneyDate();
  console.log(`\n===== plan-ab-compare.js  ${today} =====`);

  const db = new Database(DB_PATH);

  // 1. 读今天两套模拟
  const sims = db.prepare("SELECT * FROM plan_ab_sim WHERE date=? ORDER BY algo").all(today);
  if (sims.length < 2) {
    console.log(`[跳过] ${today} 模拟数据不足（找到 ${sims.length} 条，需要 2 条）`);
    db.close(); return;
  }

  const simA = sims.find(s => s.algo === 'v2-rules');
  const simB = sims.find(s => s.algo === 'v2-spread');
  if (!simA || !simB) {
    console.log('[跳过] 找不到 v2-rules 或 v2-spread 模拟');
    db.close(); return;
  }

  // 2. 读当天实际执行数据（energy_log）
  const actualLogs = db.prepare(`
    SELECT ts, soc, charge_power, sell_power, buy_price, feed_in_price
    FROM energy_log
    WHERE DATE(ts, 'unixepoch', '+10 hours') = ?
    ORDER BY ts ASC
  `).all(today);

  let actualChargeKwh = 0, actualSellKwh = 0, actualNetC = 0;
  if (actualLogs.length > 0) {
    for (const log of actualLogs) {
      const chargeKwh = (log.charge_power ?? 0) / 12; // 5min slot → kWh
      const sellKwh   = (log.sell_power   ?? 0) / 12;
      actualChargeKwh += chargeKwh;
      actualSellKwh   += sellKwh;
      actualNetC += chargeKwh * (log.buy_price ?? 0) - sellKwh * (log.feed_in_price ?? 0);
    }
    actualChargeKwh = parseFloat(actualChargeKwh.toFixed(2));
    actualSellKwh   = parseFloat(actualSellKwh.toFixed(2));
    actualNetC      = parseFloat(actualNetC.toFixed(2));
  }

  // 3. 判断赢家（净成本更低 = 更省钱）
  const winner = simA.sim_net_c <= simB.sim_net_c ? 'v2-rules' : 'v2-spread';
  const diff   = Math.abs(simA.sim_net_c - simB.sim_net_c).toFixed(2);

  // 4. 打印报告
  console.log('\n📊 收盘 A/B 对比报告');
  console.log('──────────────────────────────────────────────────────');
  console.log(`日期: ${today}`);
  console.log(`${''.padEnd(22)} ${'v2-rules'.padEnd(15)} v2-spread`);
  console.log(`买电阈值           ${String(simA.buy_threshold_c+'¢').padEnd(15)} ${simB.buy_threshold_c}¢`);
  console.log(`模拟充电           ${String(simA.sim_charge_kwh+'kWh').padEnd(15)} ${simB.sim_charge_kwh}kWh`);
  console.log(`充电均价           ${String(simA.sim_charge_avg_c+'¢').padEnd(15)} ${simB.sim_charge_avg_c}¢`);
  console.log(`模拟卖电           ${String(simA.sim_sell_kwh+'kWh').padEnd(15)} ${simB.sim_sell_kwh}kWh`);
  console.log(`卖电均价           ${String(simA.sim_sell_avg_c+'¢').padEnd(15)} ${simB.sim_sell_avg_c}¢`);
  console.log(`净成本（充-卖）    ${String(simA.sim_net_c+'¢').padEnd(15)} ${simB.sim_net_c}¢`);
  console.log(`收盘 SOC           ${String(simA.sim_final_soc+'%').padEnd(15)} ${simB.sim_final_soc}%`);
  console.log('──────────────────────────────────────────────────────');
  console.log(`🏆 模拟赢家: ${winner}（差 ${diff}¢/kWh）`);
  if (actualLogs.length > 0) {
    console.log(`\n📈 实际执行: 充电 ${actualChargeKwh}kWh | 卖电 ${actualSellKwh}kWh | 净成本 ${actualNetC.toFixed(2)}¢`);
  }
  console.log('──────────────────────────────────────────────────────');

  // 5. 存入 plan_ab_result
  db.prepare(`
    INSERT INTO plan_ab_result
      (date, compared_at, rules_net_c, spread_net_c, winner,
       rules_charge_kwh, spread_charge_kwh, rules_sell_kwh, spread_sell_kwh,
       actual_charge_kwh, actual_sell_kwh, actual_net_c, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET
      compared_at=excluded.compared_at,
      rules_net_c=excluded.rules_net_c, spread_net_c=excluded.spread_net_c,
      winner=excluded.winner,
      rules_charge_kwh=excluded.rules_charge_kwh, spread_charge_kwh=excluded.spread_charge_kwh,
      rules_sell_kwh=excluded.rules_sell_kwh,     spread_sell_kwh=excluded.spread_sell_kwh,
      actual_charge_kwh=excluded.actual_charge_kwh, actual_sell_kwh=excluded.actual_sell_kwh,
      actual_net_c=excluded.actual_net_c, notes=excluded.notes
  `).run(
    today, new Date().toISOString(),
    simA.sim_net_c, simB.sim_net_c, winner,
    simA.sim_charge_kwh, simB.sim_charge_kwh,
    simA.sim_sell_kwh,   simB.sim_sell_kwh,
    actualChargeKwh, actualSellKwh, actualNetC,
    JSON.stringify({ diff, actualLogCount: actualLogs.length })
  );

  console.log(`✅ 对比结果已存入 plan_ab_result`);

  // 6. 累计战绩
  const history = db.prepare("SELECT winner, COUNT(*) as cnt FROM plan_ab_result GROUP BY winner").all();
  if (history.length > 0) {
    console.log('\n📅 累计战绩:');
    for (const h of history) console.log(`   ${h.winner}: ${h.cnt} 天`);
  }

  db.close();
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
