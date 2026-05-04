#!/usr/bin/env node
/**
 * v2/plan-today-v3.js — 简化卖电策略
 *
 * 核心逻辑：
 *   1. 过夜保底 35%（16:00→次日07:00 自用，实测24%/15.5h ≈ 10.1kWh）
 *   2. 卖电每小时消耗 ≈ 5kWh ≈ 12% SOC
 *   3. 从晚间(16:00-21:00)选最高卖电价的槽位填满
 *   4. 充电目标 = 35% + 卖电槽数 × 12%（上限100%）
 *   5. 三点前充满到目标（用最便宜的时段）
 *
 * 输入：Amber 价格、当前 SOC、PV 预测
 * 输出：daily_plan 表 + 逆变器设置 + 打印计划
 */
'use strict';

process.env.TZ = 'Australia/Sydney';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https    = require('https');
const path     = require('path');
const Database = require('better-sqlite3');

// ── 环境变量 ──────────────────────────────────────────────────
const AMBER_TOKEN   = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID;
const ESS_TOKEN     = process.env.ESS_TOKEN;
const ESS_MAC_HEX   = process.env.ESS_MAC_HEX;
const GW_PORT       = process.env.OPENCLAW_GATEWAY_PORT || '18789';

if (!AMBER_TOKEN || !AMBER_SITE_ID) throw new Error('Missing AMBER_API_TOKEN or AMBER_SITE_ID');
if (!ESS_TOKEN || !ESS_MAC_HEX)     throw new Error('Missing ESS_TOKEN or ESS_MAC_HEX');

// ── 常量 ──────────────────────────────────────────────────────
const e = (key, def) => parseFloat(process.env[key] || def);
const BATT_KWH       = e('BATT_KWH', 42);
const MAX_CHARGE_KW  = e('MAX_CHARGE_KW', 5.0);
const MAX_SELL_KW    = e('MAX_SELL_KW', 5.0);
const BREAKER_KW     = e('BREAKER_KW', 7.7);
const CHARGE_BUFFER  = e('CHARGE_BUFFER_KW', 0.5);
const PV_SCALE       = e('PV_SCALE', 0.0032);
const HW_LOAD_KW     = e('HW_LOAD_KW', 5.0);
const DB_PATH        = path.join(__dirname, '..', 'data', 'energy.db');

// ── 新策略常量 ────────────────────────────────────────────────
const OVERNIGHT_RESERVE_PCT = 35;     // 过夜保底 35%
const SELL_KWH_PER_HOUR    = 5.0;    // 每小时卖电约5kWh
const SELL_PCT_PER_HOUR    = 12;     // ≈ 5/42 × 100 ≈ 12%
const SELL_WINDOW_START    = 16;     // 卖电窗口起始 16:00
const SELL_WINDOW_END      = 21;     // 卖电窗口结束 21:00（最晚）
const CHARGE_DEADLINE_HOUR = 15;     // 充电截止时间 15:00（之后转 self-use 等卖电）
const SELL_MIN_FEEDIN_C    = e('SELL_FLOOR_C', 5.0); // 最低卖电价 5¢
// 不再用固定 BUY_MAX_C 硬性限制——只要卖电利润覆盖买入成本就值得充

// ── 工具函数 ──────────────────────────────────────────────────
function sydneyNow() {
  const s = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const [datePart, timePart] = s.split(', ');
  const [dd, mm, yyyy] = datePart.split('/');
  const [hh, mi, ss]   = timePart.split(':').map(Number);
  return { yyyy, mm, dd, hh, mi, ss, date: `${yyyy}-${mm}-${dd}` };
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject); req.end();
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

// ── Amber 价格 ────────────────────────────────────────────────
async function fetchAmberPrices() {
  const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=288`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const data = await httpsGet(url, { Authorization: `Bearer ${AMBER_TOKEN}` });
    if (Array.isArray(data)) return data;
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 30000));
    else throw new Error('Amber API failed: ' + JSON.stringify(data).slice(0, 200));
  }
}

function aggregateAmberTo30min(raw, today) {
  const slots = {};
  for (const p of raw) {
    const sydStart = new Date(new Date(p.startTime).getTime() + 10 * 3600 * 1000);
    const sydDate  = sydStart.toISOString().substring(0, 10);
    if (sydDate !== today) continue;
    const hh  = sydStart.toISOString().substring(11, 13);
    const mm  = parseInt(sydStart.toISOString().substring(14, 16)) < 30 ? '00' : '30';
    const key = `${hh}:${mm}`;
    if (!slots[key]) slots[key] = { buySum: 0, feedInSum: 0, count: 0, demandWindow: false };
    if (p.channelType === 'general') { slots[key].buySum += p.perKwh; slots[key].count++; }
    if (p.channelType === 'feedIn')  slots[key].feedInSum += Math.abs(p.perKwh);
    if (p.tariffInformation?.demandWindow) slots[key].demandWindow = true;
  }
  return Object.entries(slots)
    .map(([key, v]) => ({
      key,
      buyC:    v.count > 0 ? parseFloat((v.buySum / v.count).toFixed(2)) : 0,
      feedInC: v.count > 0 ? parseFloat((v.feedInSum / v.count).toFixed(2)) : 0,
      dw:      v.demandWindow,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ── PV 预测 ───────────────────────────────────────────────────
function getPvForecast(db, today) {
  const row = db.prepare('SELECT forecast_json FROM solar_forecast WHERE date=? ORDER BY fetched_at DESC LIMIT 1').get(today);
  if (!row) return {};
  const fc = JSON.parse(row.forecast_json);
  const pvByHour = {};
  for (let i = 0; i < fc.time.length; i++) {
    if (!fc.time[i].startsWith(today)) continue;
    const h = parseInt(fc.time[i].substring(11, 13));
    const swRad = fc.sw[i] ?? 0;
    const cloud = fc.cloud[i] ?? 0;
    const cloudFactor = 1 - (cloud / 100) * 0.7;
    pvByHour[h] = parseFloat(Math.max(0, swRad * PV_SCALE * cloudFactor).toFixed(2));
  }
  return pvByHour;
}

// ── 家庭负载估算 ──────────────────────────────────────────────
function homeLoadKw(hour) {
  if (hour >= 6  && hour < 10) return 1.2;
  if (hour >= 17 && hour < 21) return 1.5;
  if (hour >= 21 || hour < 6)  return 0.35;
  return 0.6;
}

// ── 核心：新卖电策略 ──────────────────────────────────────────
function planSellSlots(slots) {
  // 从 16:00-21:00 选所有 feedIn >= SELL_MIN_FEEDIN_C 的槽，按价格从高到低
  const candidates = slots
    .filter(s => {
      const h = parseInt(s.key.split(':')[0]);
      return h >= SELL_WINDOW_START && h < SELL_WINDOW_END && !s.dw && s.feedInC >= SELL_MIN_FEEDIN_C;
    })
    .sort((a, b) => b.feedInC - a.feedInC);

  // 可用卖电时间：(100% - 35%) / 12% per hour = 最多 ~5.4 小时 = 10.8 个半小时槽
  // 但实际受限于电池最大放电和 SELL_WINDOW
  const maxSellSlots = Math.floor((100 - OVERNIGHT_RESERVE_PCT) / (SELL_PCT_PER_HOUR / 2)); // 每半小时6%
  const sellSlots = candidates.slice(0, maxSellSlots);

  return sellSlots;
}

function calcChargeTarget(sellSlotCount) {
  // 每个半小时槽消耗 6% SOC（= 12% / 2）
  const sellPct = sellSlotCount * (SELL_PCT_PER_HOUR / 2);
  const target = Math.min(100, OVERNIGHT_RESERVE_PCT + sellPct);
  return target;
}

// ── 生成完整计划 ──────────────────────────────────────────────
function buildPlan(slots, pvByHour, currentSocPct, sellSlots) {
  const sellKeys = new Set(sellSlots.map(s => s.key));
  const chargeTargetPct = calcChargeTarget(sellSlots.length);
  const chargeTargetKwh = chargeTargetPct / 100 * BATT_KWH;
  const currentKwh = currentSocPct / 100 * BATT_KWH;
  const neededKwh = Math.max(0, chargeTargetKwh - currentKwh);

  console.log(`\n[策略] 过夜保底: ${OVERNIGHT_RESERVE_PCT}% | 卖电槽: ${sellSlots.length}个(${sellSlots.length * 0.5}h) | 充电目标: ${chargeTargetPct}% (${chargeTargetKwh.toFixed(1)}kWh)`);
  console.log(`[策略] 当前: ${currentSocPct}% (${currentKwh.toFixed(1)}kWh) | 需充: ${neededKwh.toFixed(1)}kWh`);

  // 选充电槽：15:00前最便宜的时段，充到目标
  // 不设硬性价格上限——只要卖电价 > 买入价就有利润，值得充
  // 按价格从低到高选，自然优先选便宜的
  const chargeCandidates = slots
    .filter(s => {
      const h = parseInt(s.key.split(':')[0]);
      return h < CHARGE_DEADLINE_HOUR && !s.dw && s.buyC > 0;
    })
    .sort((a, b) => a.buyC - b.buyC);

  const chargeKeys = new Set();
  let accKwh = 0;
  for (const s of chargeCandidates) {
    if (accKwh >= neededKwh) break;
    const h = parseInt(s.key.split(':')[0]);
    const pv = pvByHour[h] ?? 0;
    const hl = homeLoadKw(h);
    const gridHeadroom = BREAKER_KW - Math.max(0, hl - pv) - CHARGE_BUFFER;
    const maxKw = Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom));
    const slotKwh = maxKw * 0.5 * 0.95;
    if (slotKwh < 0.5) continue;
    chargeKeys.add(s.key);
    accKwh += slotKwh;
  }

  // 填充电连续性：首到尾之间所有非DW槽都补上（避免中间空洞导致切换）
  const sortedCK = [...chargeKeys].sort();
  if (sortedCK.length >= 2) {
    const first = sortedCK[0], last = sortedCK[sortedCK.length - 1];
    for (const s of slots) {
      const h = parseInt(s.key.split(':')[0]);
      if (!chargeKeys.has(s.key) && s.key >= first && s.key <= last && !s.dw && h < CHARGE_DEADLINE_HOUR) {
        chargeKeys.add(s.key);
      }
    }
  }

  console.log(`[充电] 选中 ${chargeKeys.size} 槽, 预计充入 ${accKwh.toFixed(1)}kWh`);
  if (sellSlots.length > 0) {
    const sortedSell = [...sellKeys].sort();
    const prices = sellSlots.map(s => s.feedInC);
    console.log(`[卖电] ${sortedSell[0]}–${sortedSell[sortedSell.length-1]} | feedIn ${Math.min(...prices).toFixed(1)}–${Math.max(...prices).toFixed(1)}¢`);
  }

  // 生成逐槽计划
  let socKwh = currentKwh;
  const plan = [];

  for (const s of slots) {
    const h = parseInt(s.key.split(':')[0]);
    const pv = pvByHour[h] ?? 0;
    const hl = homeLoadKw(h);
    const net = hl - pv; // 正=需供电，负=PV有余

    const gridHeadroom = BREAKER_KW - Math.max(0, net) - CHARGE_BUFFER;
    const maxChargeKw = parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom)).toFixed(2));

    let action = 'self-use', chargeKw = 0, sellKw = 0, reason = '';

    if (s.dw) {
      action = 'standby';
      reason = 'DW';
    } else if (chargeKeys.has(s.key) && socKwh < chargeTargetKwh) {
      action = 'charge';
      chargeKw = maxChargeKw;
      reason = `buy=${s.buyC}¢ → 充到${chargeTargetPct}%`;
    } else if (sellKeys.has(s.key) && socKwh > OVERNIGHT_RESERVE_PCT / 100 * BATT_KWH) {
      action = 'sell';
      sellKw = MAX_SELL_KW;
      reason = `feedIn=${s.feedInC}¢`;
    } else if (pv > 0.2 && socKwh < chargeTargetKwh) {
      // PV 消纳
      action = 'charge';
      chargeKw = parseFloat(Math.min(maxChargeKw, Math.max(0, pv - hl)).toFixed(2));
      if (chargeKw < 0.2) { action = 'self-use'; chargeKw = 0; reason = `pv=${pv.toFixed(1)}kW self`; }
      else reason = `pv=${pv.toFixed(1)}kW absorb`;
    } else {
      action = 'self-use';
      reason = `buy=${s.buyC}¢ feedIn=${s.feedInC}¢`;
    }

    // SOC 变化
    const deltaKwh = action === 'charge'
      ? chargeKw * 0.5 * 0.95
      : action === 'sell'
        ? -sellKw * 0.5
        : net > 0
          ? -net * 0.5 * 0.85
          : (-net) * 0.5 * 0.9;

    socKwh = Math.min(BATT_KWH, Math.max(BATT_KWH * 0.10, socKwh + deltaKwh));

    plan.push({
      key: s.key, hour: h, buyC: s.buyC, feedInC: s.feedInC, pvKw: pv, homeLoad: hl, dw: s.dw,
      action, chargeKw: parseFloat(chargeKw.toFixed(2)), sellKw: parseFloat(sellKw.toFixed(2)),
      socPct: Math.round(socKwh / BATT_KWH * 100), reason,
    });
  }

  return { plan, chargeTargetPct, sellSlotCount: sellSlots.length };
}

// ── 打印计划 ──────────────────────────────────────────────────
function printPlan(plan, currentSocPct, today, chargeTargetPct, sellSlotCount) {
  const lines = [
    `\n🔋 充放电计划 v3 — ${today}  SOC: ${currentSocPct}%`,
    `策略: 保底${OVERNIGHT_RESERVE_PCT}% + 卖电${sellSlotCount}×30min(${sellSlotCount*6}%) = 充到${chargeTargetPct}%`,
    `时间   动作      充电   卖电    买¢    卖¢   SOC   PV`,
    `${'─'.repeat(62)}`,
  ];

  let prevAction = null;
  for (const s of plan) {
    const icon = { charge: '⚡', sell: '💰', 'self-use': '🔋', standby: '⏸' }[s.action] ?? ' ';
    const act = { charge: '充电', sell: '卖电', 'self-use': '自用', standby: '待机' }[s.action] ?? s.action;
    const chKw = s.chargeKw > 0 ? `${s.chargeKw.toFixed(1)}kW` : '   -';
    const slKw = s.sellKw > 0   ? `${s.sellKw.toFixed(1)}kW`   : '   -';
    const dw = s.dw ? '⚠️DW' : '';
    if (prevAction && prevAction !== s.action) lines.push('');
    lines.push(`${s.key} ${icon}${act} ${chKw.padStart(6)} ${slKw.padStart(6)}  ${String(s.buyC.toFixed(1)).padStart(5)}¢ ${String(s.feedInC.toFixed(1)).padStart(5)}¢  ${String(s.socPct).padStart(3)}%  ${s.pvKw.toFixed(1)}kW ${dw}`);
    prevAction = s.action;
  }

  const last = plan[plan.length - 1];
  lines.push(`${'─'.repeat(62)}`);

  // 摘要
  const chargeSlots = plan.filter(s => s.action === 'charge');
  const sellSlots   = plan.filter(s => s.action === 'sell');
  const totalChargeKwh = chargeSlots.reduce((s, x) => s + x.chargeKw * 0.5 * 0.95, 0);
  const totalSellKwh   = sellSlots.reduce((s, x) => s + x.sellKw * 0.5, 0);
  const avgBuyC  = chargeSlots.length > 0 ? chargeSlots.reduce((s,x) => s + x.buyC, 0) / chargeSlots.length : 0;
  const avgSellC = sellSlots.length > 0 ? sellSlots.reduce((s,x) => s + x.feedInC, 0) / sellSlots.length : 0;

  lines.push(`\n📊 摘要:`);
  lines.push(`  充电: ${chargeSlots.length}槽 ${totalChargeKwh.toFixed(1)}kWh 均价${avgBuyC.toFixed(1)}¢`);
  lines.push(`  卖电: ${sellSlots.length}槽 ${totalSellKwh.toFixed(1)}kWh 均价${avgSellC.toFixed(1)}¢`);
  if (avgSellC > avgBuyC && sellSlots.length > 0) {
    const profit = (avgSellC - avgBuyC) * totalSellKwh;
    lines.push(`  利润: ~${profit.toFixed(0)}¢ (${(avgSellC - avgBuyC).toFixed(1)}¢/kWh × ${totalSellKwh.toFixed(1)}kWh)`);
  }
  lines.push(`  收盘: SOC ${last?.socPct ?? '?'}% (${((last?.socPct??0)/100*BATT_KWH).toFixed(1)}kWh)`);

  return lines.join('\n');
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  const syd   = sydneyNow();
  const today = syd.date;
  console.log(`\n===== v3/plan-today  ${today} ${syd.hh}:${String(syd.mi).padStart(2,'0')} Sydney =====`);

  const db = new Database(DB_PATH);

  // 当前 SOC
  const latest = db.prepare('SELECT soc FROM energy_log ORDER BY ts DESC LIMIT 1').get();
  const currentSocPct = latest?.soc ?? 50;
  console.log(`[SOC] 当前: ${currentSocPct}%`);

  // PV 预测
  const pvByHour = getPvForecast(db, today);
  const pvTotal = Object.values(pvByHour).reduce((s, v) => s + v, 0);
  console.log(`[PV] 今日预计: ${pvTotal.toFixed(1)}kWh`);

  // Amber 价格
  console.log('[Amber] 拉取价格...');
  const rawAmber = await fetchAmberPrices();
  const slots = aggregateAmberTo30min(rawAmber, today);
  console.log(`[Amber] ${slots.length} 个半小时槽, DW: ${slots.some(s => s.dw)}`);

  // 核心：选卖电槽
  const sellSlots = planSellSlots(slots);

  // 生成计划
  const { plan, chargeTargetPct, sellSlotCount } = buildPlan(slots, pvByHour, currentSocPct, sellSlots);

  // 打印
  const report = printPlan(plan, currentSocPct, today, chargeTargetPct, sellSlotCount);
  console.log(report);

  // ── 写入 DB ─────────────────────────────────────────────────
  // 确保表结构
  try { db.prepare('ALTER TABLE daily_plan ADD COLUMN hw_window_json TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE daily_plan ADD COLUMN gf_window_json TEXT').run(); } catch {}

  db.prepare('UPDATE daily_plan SET is_active=0 WHERE date=? AND is_active=1').run(today);
  const lastVer = db.prepare('SELECT MAX(version) as v FROM daily_plan WHERE date=?').get(today);
  const version = (lastVer?.v ?? 0) + 1;

  const chargeSlots = plan.filter(s => s.action === 'charge');
  const chargeWindows = chargeSlots.length > 0 ? [{
    startHour: parseInt(chargeSlots[0].key),
    endHour:   parseInt(chargeSlots[chargeSlots.length-1].key) + 1,
    avgBuyC:   parseFloat((chargeSlots.reduce((s,x)=>s+x.buyC,0)/chargeSlots.length).toFixed(1)),
  }] : [];

  const notes = JSON.stringify({
    strategy: 'v3-sell',
    overnightReservePct: OVERNIGHT_RESERVE_PCT,
    sellSlotCount,
    chargeTargetPct,
  });

  db.prepare(`
    INSERT INTO daily_plan
      (date, version, generated_at, source, created_by, soc_at_gen,
       has_demand_window, charge_cutoff_hour,
       pv_forecast_kwh, pv_peak_kw,
       charge_windows_json, intervals_json, notes,
       buy_threshold_c, sell_min_c, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    today, version, new Date().toISOString(), 'v3-sell', 'v2/plan-today-v3.js',
    currentSocPct,
    slots.some(s => s.dw) ? 1 : 0,
    CHARGE_DEADLINE_HOUR,
    parseFloat(pvTotal.toFixed(2)),
    parseFloat(Math.max(...Object.values(pvByHour), 0).toFixed(2)),
    JSON.stringify(chargeWindows),
    JSON.stringify(plan),
    notes,
    chargeSlots.length > 0 ? parseFloat(Math.max(...chargeSlots.map(s=>s.buyC)).toFixed(2)) : 0,
    SELL_MIN_FEEDIN_C,
  );
  console.log(`\n✅ 计划 v${version} 已存入 DB (source=v3-sell)`);

  // ── 逆变器设置 ─────────────────────────────────────────────
  const ESS_HEADERS = {
    Authorization: ESS_TOKEN, lang: 'en', showloading: 'false',
    Referer: 'https://eu.ess-link.com/appViews/appHome', 'User-Agent': 'Mozilla/5.0',
  };
  async function setParam(index, data) {
    const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceParam',
      { macHex: ESS_MAC_HEX, index, data }, ESS_HEADERS).catch(() => ({}));
    return r.code === 200;
  }
  async function setWeekParam(index, data) {
    const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceWeekParam',
      { macHex: ESS_MAC_HEX, index, data }, ESS_HEADERS).catch(() => ({}));
    return r.code === 200;
  }
  async function setDateParam(index, data) {
    const r = await httpsPost('https://eu.ess-link.com/api/app/deviceInfo/setDeviceDateOrTimeParam',
      { macHex: ESS_MAC_HEX, index, data }, ESS_HEADERS).catch(() => ({}));
    return r.code === 200;
  }
  function hhmm(h, m=0) { return String(h).padStart(2,'0') + String(m).padStart(2,'0'); }

  // 充电窗口
  let chargeStartHHMM = '0000', chargeEndHHMM = '0000';
  if (chargeSlots.length > 0) {
    const [fh, fm] = chargeSlots[0].key.split(':').map(Number);
    const [lh, lm] = chargeSlots[chargeSlots.length-1].key.split(':').map(Number);
    chargeStartHHMM = hhmm(fh, fm);
    const endMins = lh*60+lm+30;
    chargeEndHHMM = hhmm(Math.floor(endMins/60), endMins%60);
  }

  // 卖电窗口
  const sellPlan = plan.filter(s => s.action === 'sell');
  let sellStartHHMM = '0000', sellEndHHMM = '0000';
  if (sellPlan.length > 0) {
    const [fh, fm] = sellPlan[0].key.split(':').map(Number);
    const [lh, lm] = sellPlan[sellPlan.length-1].key.split(':').map(Number);
    sellStartHHMM = hhmm(fh, fm);
    const endMins = lh*60+lm+30;
    sellEndHHMM = hhmm(Math.floor(endMins/60), endMins%60);
  }

  console.log(`[逆变器] 充电: ${chargeStartHHMM}–${chargeEndHHMM} | 卖电: ${sellStartHHMM}–${sellEndHHMM}`);

  const sydNowMs = Date.now() + 11*3600*1000;
  const yesterday = new Date(sydNowMs - 86400*1000).toISOString().slice(0,10);
  const tomorrow  = new Date(sydNowMs + 86400*1000).toISOString().slice(0,10);

  const steps = [
    ['mode=Timed(1)',                  () => setParam('0x300C', 1)],
    [`chargeStart=${chargeStartHHMM}`, () => setParam('0xC014', chargeStartHHMM)],
    [`chargeEnd=${chargeEndHHMM}`,     () => setParam('0xC016', chargeEndHHMM)],
    [`chargeKw=${MAX_CHARGE_KW}`,      () => setParam('0xC0BA', MAX_CHARGE_KW)],
    [`sellStart=${sellStartHHMM}`,     () => setParam('0xC018', sellStartHHMM)],
    [`sellEnd=${sellEndHHMM}`,         () => setParam('0xC01A', sellEndHHMM)],
    [`sellKw=${MAX_SELL_KW}`,          () => setParam('0xC0BC', MAX_SELL_KW)],
    ['otherMode=0',                    () => setParam('0x314E', 0)],
    ['weekdays=all',                   () => setWeekParam('0xC0B4', [1,2,3,4,5,6,0])],
    [`startDate=${yesterday}`,         () => setDateParam('0xC0B6', yesterday)],
    [`endDate=${tomorrow}`,            () => setDateParam('0xC0B8', tomorrow)],
  ];

  for (const [label, fn] of steps) {
    const ok = await fn();
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    await new Promise(r => setTimeout(r, 350));
  }

  // ── Turso 同步 ─────────────────────────────────────────────
  try {
    const { execSync } = require('child_process');
    execSync('node scripts/turso-sync.js', {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env },
      timeout: 30000,
    });
    console.log('✅ Turso 同步完成');
  } catch(e) {
    console.warn('[turso-sync] 同步失败:', e.message);
  }

  db.close();
}

main().catch(e => {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
