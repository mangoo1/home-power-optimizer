#!/usr/bin/env node
/**
 * v2/plan-ab-sim.js — A/B 算法模拟对比（只存档，绝不执行）
 *
 * 每天与 plan-today 同时运行，模拟两套充放电算法：
 *   A: v2-rules  — 当前算法（30%分位 + 保底 BUY_MIN_C）
 *   B: v2-spread — 价差锚定（峰值价 × SPREAD_RATIO 作为充电阈值）
 *
 * 结果存入 plan_ab_sim 表，供收盘后对比。
 * 不写逆变器，不影响实际执行。
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https    = require('https');
const path     = require('path');
const Database = require('better-sqlite3');

// ── 环境变量 ─────────────────────────────────────────────────
const AMBER_TOKEN   = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID;
if (!AMBER_TOKEN || !AMBER_SITE_ID) throw new Error('Missing AMBER_API_TOKEN or AMBER_SITE_ID');

// ── 系统常量 ──────────────────────────────────────────────────
const BATT_KWH      = 42;
const SOC_MIN       = 0.20;
const SOC_TARGET    = 0.85;
const SOC_TARGET_BY = 15;
const MAX_CHARGE_KW = 5.0;
const MAX_SELL_KW   = 5.0;
const BREAKER_KW    = 7.7;
const CHARGE_BUFFER = 0.5;
const SELL_MIN_C    = parseFloat(process.env.SELL_MIN_C    || '13.5');
const BUY_MAX_C     = 12.0;
// A: rules 保底阈值
const BUY_MIN_C     = parseFloat(process.env.BUY_THRESHOLD_C || '8.0');
// B: spread 参数（充电阈值 = 峰值价 × SPREAD_RATIO，但不超 BUY_MAX_C）
const SPREAD_RATIO  = parseFloat(process.env.SPREAD_RATIO  || '0.65');
const DB_PATH       = path.join(__dirname, '..', 'data', 'energy.db');

// ── 工具 ──────────────────────────────────────────────────────
function sydneyDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // YYYY-MM-DD
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.end();
  });
}

function homeLoadKw(hour) {
  if (hour >= 6  && hour < 9)  return 1.2;
  if (hour >= 9  && hour < 12) return 0.5;
  if (hour >= 12 && hour < 18) return 0.8;
  if (hour >= 18 && hour < 21) return 1.5;
  if (hour >= 21 || hour < 6)  return 0.35;
  return 0.6;
}

// ── 拉取 Amber 价格预测 ───────────────────────────────────────
async function fetchAmberSlots() {
  const data = await httpsGet(
    `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=47&previous=0`,
    { Authorization: `Bearer ${AMBER_TOKEN}`, accept: 'application/json' }
  );
  if (!Array.isArray(data)) throw new Error('Amber API error: ' + JSON.stringify(data));

  const slots = [];
  for (const item of data) {
    if (item.channelType !== 'general') continue;
    const nemTime = item.nemTime;
    const sydHour = parseInt(new Date(nemTime).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false
    }));
    const sydMin  = parseInt(new Date(nemTime).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney', minute: '2-digit'
    }));
    const key = `${String(sydHour).padStart(2,'0')}:${sydMin < 30 ? '00' : '30'}`;
    slots.push({
      key,
      nemTime,
      hour: sydHour,
      buyC:    parseFloat((item.perKwh ?? 0).toFixed(2)),
      feedInC: 0,  // 填充后面
      dw:      item.tariffInformation?.demandWindow ?? false,
    });
  }

  // feedIn 价格
  for (const item of data) {
    if (item.channelType !== 'feedIn') continue;
    const nemTime = item.nemTime;
    const sydHour = parseInt(new Date(nemTime).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false
    }));
    const sydMin  = parseInt(new Date(nemTime).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney', minute: '2-digit'
    }));
    const key = `${String(sydHour).padStart(2,'0')}:${sydMin < 30 ? '00' : '30'}`;
    const match = slots.find(s => s.key === key);
    if (match) match.feedInC = Math.abs(parseFloat((item.perKwh ?? 0).toFixed(2)));
  }

  return slots.filter(s => s.buyC > 0);
}

// ── 核心：模拟一套算法 ────────────────────────────────────────
function simulate(slots, buyThreshold, currentSocPct, algoName) {
  let socKwh = currentSocPct / 100 * BATT_KWH;
  const plan = [];

  for (const s of slots) {
    const h  = s.hour;
    const hl = homeLoadKw(h);
    const pv = 0; // AB sim 不校准 PV，保持简单一致
    const net = hl - pv;

    const gridHeadroom = BREAKER_KW - Math.max(0, net) - CHARGE_BUFFER;
    const maxChargeKw  = parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom)).toFixed(2));

    const usableKwh = Math.max(0, socKwh - SOC_MIN * BATT_KWH);
    const maxSellKw = parseFloat(Math.min(MAX_SELL_KW, usableKwh / 0.5).toFixed(2));

    let action = 'self-use', chargeKw = 0, sellKw = 0;

    if (s.dw) {
      action = 'standby';
    } else if (s.buyC <= buyThreshold && socKwh < SOC_TARGET * BATT_KWH && maxChargeKw >= 0.5 && h < SOC_TARGET_BY) {
      action   = 'charge';
      chargeKw = maxChargeKw;
    } else if (s.feedInC >= SELL_MIN_C && maxSellKw >= 0.5) {
      action = 'sell';
      sellKw = maxSellKw;
    }

    const deltaKwh = action === 'charge'
      ? chargeKw * 0.5 * 0.95
      : action === 'sell'
        ? -sellKw * 0.5
        : (net < 0 ? (-net) * 0.5 * 0.9 : -net * 0.5 * 0.85);

    socKwh = Math.min(BATT_KWH, Math.max(SOC_MIN * BATT_KWH, socKwh + deltaKwh));

    plan.push({ key: s.key, hour: h, buyC: s.buyC, feedInC: s.feedInC, action,
      chargeKw: parseFloat(chargeKw.toFixed(2)), sellKw: parseFloat(sellKw.toFixed(2)),
      socPct: Math.round(socKwh / BATT_KWH * 100) });
  }

  // 汇总统计
  const chargeSlots = plan.filter(s => s.action === 'charge');
  const sellSlots   = plan.filter(s => s.action === 'sell');

  const simChargeKwh  = parseFloat(chargeSlots.reduce((s,x) => s + x.chargeKw * 0.5, 0).toFixed(2));
  const simChargeAvgC = chargeSlots.length
    ? parseFloat((chargeSlots.reduce((s,x) => s + x.buyC, 0) / chargeSlots.length).toFixed(2)) : 0;
  const simChargeCost = parseFloat((simChargeKwh * simChargeAvgC).toFixed(2));

  const simSellKwh    = parseFloat(sellSlots.reduce((s,x) => s + x.sellKw * 0.5, 0).toFixed(2));
  const simSellAvgC   = sellSlots.length
    ? parseFloat((sellSlots.reduce((s,x) => s + x.feedInC, 0) / sellSlots.length).toFixed(2)) : 0;
  const simSellRev    = parseFloat((simSellKwh * simSellAvgC).toFixed(2));

  const simNetC = parseFloat((simChargeCost - simSellRev).toFixed(2));
  const finalSoc = plan.at(-1)?.socPct ?? currentSocPct;

  return {
    algo: algoName,
    buyThreshold,
    simChargeKwh, simChargeAvgC, simChargeCost,
    simSellKwh,   simSellAvgC,   simSellRev,
    simNetC, finalSoc, plan,
  };
}

// ── 打印对比 ──────────────────────────────────────────────────
function printComparison(a, b) {
  console.log('\n📊 A/B 算法模拟对比（仅参考，不执行）');
  console.log('─────────────────────────────────────────────────');
  console.log(`算法               ${a.algo.padEnd(15)} ${b.algo}`);
  console.log(`买电阈值           ${a.buyThreshold.toFixed(1)}¢               ${b.buyThreshold.toFixed(1)}¢`);
  console.log(`模拟充电           ${a.simChargeKwh}kWh @ ${a.simChargeAvgC}¢    ${b.simChargeKwh}kWh @ ${b.simChargeAvgC}¢`);
  console.log(`模拟卖电           ${a.simSellKwh}kWh @ ${a.simSellAvgC}¢    ${b.simSellKwh}kWh @ ${b.simSellAvgC}¢`);
  console.log(`净成本（充-卖）    ${a.simNetC.toFixed(2)}¢               ${b.simNetC.toFixed(2)}¢`);
  console.log(`收盘 SOC           ${a.finalSoc}%               ${b.finalSoc}%`);
  const winner = a.simNetC <= b.simNetC ? a.algo : b.algo;
  console.log(`\n🏆 模拟赢家: ${winner}（净成本更低）`);
  console.log('─────────────────────────────────────────────────');
  console.log('⚠️  此结果仅供参考，实际执行按 v2-rules 计划运行');
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  const today = sydneyDate();
  const syd = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', hour:'2-digit', minute:'2-digit', hour12:false });
  console.log(`\n===== plan-ab-sim.js  ${today} ${syd} Sydney =====`);

  // 读当前 SOC
  const db = new Database(DB_PATH);
  const lastLog = db.prepare("SELECT soc FROM energy_log ORDER BY ts DESC LIMIT 1").get();
  const currentSocPct = lastLog?.soc ?? 30;
  console.log(`[SOC] 当前: ${currentSocPct}%`);

  // 拉取价格
  console.log('[Amber] 拉取价格预测...');
  const slots = await fetchAmberSlots();
  console.log(`[Amber] ${slots.length} 个半小时槽`);

  if (slots.length < 10) {
    console.warn('[警告] 价格槽太少，跳过模拟');
    db.close(); return;
  }

  // ── 算法 A: v2-rules（30%分位 + 保底 BUY_MIN_C）─────────────
  const buySorted = slots.map(s => s.buyC).filter(c => c > 0).sort((a,b) => a-b);
  const p30idx = Math.floor(buySorted.length * 0.30);
  const thresholdA = Math.min(BUY_MAX_C, Math.max(BUY_MIN_C, buySorted[p30idx] ?? BUY_MAX_C));

  // ── 算法 B: v2-spread（峰值价 × SPREAD_RATIO）───────────────
  const peakBuyC    = Math.max(...slots.map(s => s.buyC));
  const thresholdB  = Math.min(BUY_MAX_C, parseFloat((peakBuyC * SPREAD_RATIO).toFixed(2)));

  console.log(`[A] v2-rules  阈值: ${thresholdA.toFixed(1)}¢  (30%分位=${buySorted[p30idx]?.toFixed(1)}¢, 保底=${BUY_MIN_C}¢)`);
  console.log(`[B] v2-spread 阈值: ${thresholdB.toFixed(1)}¢  (峰值=${peakBuyC.toFixed(1)}¢ × ${SPREAD_RATIO})`);

  const resultA = simulate(slots, thresholdA, currentSocPct, 'v2-rules');
  const resultB = simulate(slots, thresholdB, currentSocPct, 'v2-spread');

  printComparison(resultA, resultB);

  // ── 存入 DB（UPSERT，每天每个 algo 一行）────────────────────
  const upsert = db.prepare(`
    INSERT INTO plan_ab_sim
      (date, algo, generated_at, buy_threshold_c, sell_min_c,
       sim_charge_kwh, sim_charge_avg_c, sim_charge_cost,
       sim_sell_kwh,   sim_sell_avg_c,   sim_sell_revenue,
       sim_net_c, sim_final_soc, intervals_json, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date, algo) DO UPDATE SET
      generated_at=excluded.generated_at,
      buy_threshold_c=excluded.buy_threshold_c,
      sim_charge_kwh=excluded.sim_charge_kwh,
      sim_charge_avg_c=excluded.sim_charge_avg_c,
      sim_charge_cost=excluded.sim_charge_cost,
      sim_sell_kwh=excluded.sim_sell_kwh,
      sim_sell_avg_c=excluded.sim_sell_avg_c,
      sim_sell_revenue=excluded.sim_sell_revenue,
      sim_net_c=excluded.sim_net_c,
      sim_final_soc=excluded.sim_final_soc,
      intervals_json=excluded.intervals_json,
      notes=excluded.notes
  `);

  for (const r of [resultA, resultB]) {
    upsert.run(
      today, r.algo, new Date().toISOString(),
      r.buyThreshold, SELL_MIN_C,
      r.simChargeKwh, r.simChargeAvgC, r.simChargeCost,
      r.simSellKwh,   r.simSellAvgC,   r.simSellRev,
      r.simNetC, r.finalSoc,
      JSON.stringify(r.plan),
      JSON.stringify({ peakBuyC: peakBuyC.toFixed(1), spreadRatio: SPREAD_RATIO, p30: buySorted[p30idx]?.toFixed(1) })
    );
  }
  console.log(`\n✅ A/B 模拟已存入 DB (plan_ab_sim, date=${today})`);
  db.close();
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
