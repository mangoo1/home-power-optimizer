#!/usr/bin/env node
/**
 * v2/plan-today.js — Clean-room daily planner
 *
 * 输入：
 *   1. Amber API 价格预测（24h，含 demandWindow）
 *   2. Open-Meteo 太阳辐射预测（solar_forecast 表）
 *   3. 过去14天实际 vs 预测 PV 校准系数
 *   4. 当前 SOC（energy_log 最新记录）
 *
 * 输出：
 *   daily_plan 表（v2 格式）
 *   逆变器充电/卖电时间窗口直接写入
 *   控制台打印计划供人工确认
 *
 * 所有 token 均从环境变量读取，无硬编码。
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https    = require('https');
const path     = require('path');
const Database = require('better-sqlite3');

// ── 环境变量（全部从 .env 读取，绝不硬编码）─────────────────────
const AMBER_TOKEN   = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID;
const ESS_TOKEN     = process.env.ESS_TOKEN;
const ESS_MAC_HEX   = process.env.ESS_MAC_HEX;
const ESS_STATION   = process.env.ESS_STATION_SN;
const GW_PORT       = process.env.OPENCLAW_GATEWAY_PORT || '18789';

if (!AMBER_TOKEN || !AMBER_SITE_ID) throw new Error('Missing AMBER_API_TOKEN or AMBER_SITE_ID in .env');
if (!ESS_TOKEN   || !ESS_MAC_HEX)   throw new Error('Missing ESS_TOKEN or ESS_MAC_HEX in .env');

// ── 系统常量 ──────────────────────────────────────────────────
const BATT_KWH       = 42;      // 电池总容量 kWh
const SOC_MIN        = 0.20;    // 最低 SOC（不放电到这以下）
const SOC_TARGET     = 0.85;    // 充电目标（15:00前达到）
const SOC_TARGET_BY  = 15;      // 目标达到时间（Sydney 小时，15:00）
const MAX_CHARGE_KW  = 5.0;     // 逆变器最大充电功率
const MAX_SELL_KW    = 5.0;     // 逆变器最大放电功率
const BREAKER_KW     = 7.7;     // 主断路器限制
const PANEL_KWP      = 4.3;     // 系统峰值功率
const MAX_DAILY_KWH  = 22.0;    // 晴天理论上限（4.3kWp × ~5h 有效日照）
const CHARGE_BUFFER  = 0.5;     // 充电安全余量 kW
const BUY_MAX_C      = 12.0;    // 买电上限（超过不充）
const BUY_MIN_C      = parseFloat(process.env.BUY_THRESHOLD_C || '8.0'); // 买电阈值下限（.env 可覆盖）
const SELL_MIN_C     = 13.5;    // 卖电下限（低于不卖）
const DB_PATH        = path.join(__dirname, '..', 'data', 'energy.db');

// ── 工具函数 ──────────────────────────────────────────────────
function sydneyNow() {
  const s = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  // "dd/mm/yyyy, hh:mm:ss"
  const [datePart, timePart] = s.split(', ');
  const [dd, mm, yyyy] = datePart.split('/');
  const [hh, mi, ss]   = timePart.split(':').map(Number);
  return { yyyy, mm, dd, hh, mi, ss,
    date: `${yyyy}-${mm}-${dd}`,
    hhmm: `${String(hh).padStart(2,'0')}${String(mi).padStart(2,'0')}` };
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.end();
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
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Step 1: 获取 Amber 价格预测 ───────────────────────────────
async function fetchAmberPrices() {
  const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=288`;
  const data = await httpsGet(url, { Authorization: `Bearer ${AMBER_TOKEN}` });
  if (!Array.isArray(data)) throw new Error('Amber API error: ' + JSON.stringify(data).slice(0, 200));
  return data;
}

// 把5分钟 Amber 数据聚合成30分钟槽
function aggregateAmberTo30min(raw, today) {
  const slots = {};
  for (const p of raw) {
    // 只要今天的（Sydney 日期）
    const nemDate = p.nemTime?.substring(0, 10); // "2026-04-20"
    if (nemDate !== today) continue;

    // 取半小时 key：nemTime "2026-04-20T09:30:00+10:00" → "09:30"
    const hh = p.nemTime.substring(11, 13);
    const mm = parseInt(p.nemTime.substring(14, 16)) < 30 ? '00' : '30';
    const key = `${hh}:${mm}`;

    if (!slots[key]) slots[key] = { buySum: 0, feedInSum: 0, count: 0, demandWindow: false, nemTime: p.nemTime };
    if (p.channelType === 'general') { slots[key].buySum += p.perKwh; slots[key].count++; }
    if (p.channelType === 'feedIn')  slots[key].feedInSum += Math.abs(p.perKwh);
    if (p.tariffInformation?.demandWindow) slots[key].demandWindow = true;
  }

  return Object.entries(slots)
    .map(([key, v]) => ({
      key,
      nemTime: v.nemTime,
      buyC:    v.count > 0 ? parseFloat((v.buySum    / v.count).toFixed(2)) : 0,
      feedInC: v.count > 0 ? parseFloat((v.feedInSum / v.count).toFixed(2)) : 0,
      dw:      v.demandWindow,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ── Step 2: 计算 PV 校准系数（过去14天实际/预测比值）────────────
function calcPvCalibration(db) {
  // 从 solar_forecast 取预测，从 energy_log 取实际
  const forecasts = db.prepare(`
    SELECT date, today_kwh_est
    FROM solar_forecast
    WHERE date >= date('now', '-15 days')
    ORDER BY date
  `).all();

  // 用每小时平均值×1h 计算实际发电量（避免5分钟积分的重复计算误差）
  const actuals = db.prepare(`
    WITH hourly AS (
      SELECT 
        date(ts, '+11 hours') as day,
        CAST(strftime('%H', ts, '+11 hours') AS INTEGER) as hour,
        AVG(pv_power) as avg_kw
      FROM energy_log
      WHERE ts >= datetime('now', '-15 days')
        AND pv_power IS NOT NULL
      GROUP BY date(ts, '+11 hours'), CAST(strftime('%H', ts, '+11 hours') AS INTEGER)
    )
    SELECT day, SUM(avg_kw) as actual_kwh
    FROM hourly
    GROUP BY day
  `).all();

  const actualMap = {};
  for (const r of actuals) actualMap[r.day] = r.actual_kwh;

  let ratioSum = 0, ratioCount = 0;
  const calibLog = [];
  for (const f of forecasts) {
    const actual = actualMap[f.date];
    if (actual != null && f.today_kwh_est > 2 && actual > 0.5) {
      const ratio = actual / f.today_kwh_est;
      // 过滤异常值（比值在 0.1–2.0 之间）
      if (ratio >= 0.1 && ratio <= 2.0) {
        ratioSum += ratio;
        ratioCount++;
        calibLog.push(`  ${f.date}: forecast=${f.today_kwh_est.toFixed(1)}kWh actual=${actual.toFixed(1)}kWh ratio=${ratio.toFixed(2)}`);
      }
    }
  }

  const calibFactor = ratioCount > 0 ? ratioSum / ratioCount : 0.6;
  console.log(`\n[PV校准] 过去${ratioCount}天有效数据，校准系数: ${calibFactor.toFixed(3)}`);
  calibLog.forEach(l => console.log(l));
  return Math.min(1.0, Math.max(0.3, calibFactor)); // 限制在 0.3–1.0
}

// ── Step 3: 从 solar_forecast 获取今天逐小时 PV 预测 ───────────
function getPvForecast(db, today, calibFactor) {
  const row = db.prepare(`
    SELECT forecast_json FROM solar_forecast WHERE date=? ORDER BY fetched_at DESC LIMIT 1
  `).get(today);

  if (!row) {
    console.log('[PV预测] 无今日预测数据，使用默认值');
    return {};
  }

  const fc = JSON.parse(row.forecast_json);
  const pvByHour = {};

  for (let i = 0; i < fc.time.length; i++) {
    const t = fc.time[i];
    if (!t.startsWith(today)) continue;
    const h = parseInt(t.substring(11, 13));
    const swRad = fc.sw[i] ?? 0;      // W/m²
    const cloud = fc.cloud[i] ?? 0;   // %

    // PV 估算：系统峰值 4.3kWp，辐射转换 + 云量折减
    const cloudFactor = 1 - (cloud / 100) * 0.7;  // 100%云 = 30%辐射
    const pvKw = (swRad / 1000) * 4.3 * cloudFactor * calibFactor;
    pvByHour[h] = parseFloat(Math.max(0, pvKw).toFixed(2));
  }

  return pvByHour;
}

// 把小时 PV 插值成30分钟
function pvAt30min(pvByHour, hh) {
  const h = parseInt(hh);
  return pvByHour[h] ?? 0;
}

// ── Step 4: 估算家庭负载 ──────────────────────────────────────
function homeLoadKw(hour) {
  if (hour >= 6  && hour < 10) return 1.2;   // 早晨（无热水器——单独处理）
  if (hour >= 17 && hour < 21) return 1.5;   // 傍晚高峰
  if (hour >= 21 || hour < 6)  return 0.35;  // 夜间待机
  return 0.6;                                 // 白天普通
}

// ── Step 5: 生成半小时充放电计划 ─────────────────────────────
function buildPlan(slots, pvByHour, currentSoc, hasDW) {
  // 买电阈值：取所有槽中便宜的30%分位
  const buySorted = slots.map(s => s.buyC).filter(c => c > 0).sort((a,b) => a-b);
  const p30idx = Math.floor(buySorted.length * 0.30);
  const buyThreshold = Math.min(BUY_MAX_C, Math.max(BUY_MIN_C, buySorted[p30idx] ?? BUY_MAX_C));

  console.log(`\n[计划] 买电阈值: ${buyThreshold.toFixed(1)}¢ | 卖电下限: ${SELL_MIN_C}¢ | DW: ${hasDW}`);

  let socKwh = currentSoc / 100 * BATT_KWH;
  const plan = [];

  for (const s of slots) {
    const h   = parseInt(s.key.split(':')[0]);
    const pv  = pvAt30min(pvByHour, h);
    const hl  = homeLoadKw(h);
    const net = hl - pv; // 正=需要外部补给，负=PV有剩余

    // 可用充电功率（受断路器限制）
    const gridHeadroom = BREAKER_KW - Math.max(0, net) - CHARGE_BUFFER;
    const maxChargeKw  = parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, gridHeadroom)).toFixed(2));

    // 当前可卖电量（保留 SOC_MIN）
    const usableKwh  = socKwh - SOC_MIN * BATT_KWH;
    const maxSellKwh = Math.max(0, usableKwh);
    const maxSellKw  = parseFloat(Math.min(MAX_SELL_KW, maxSellKwh / 0.5).toFixed(2));

    let action, chargeKw = 0, sellKw = 0, reason = '';

    if (s.dw) {
      // Demand Window：绝不充电，尽量少用电
      action = 'standby';
      reason = 'DW';
    } else if (s.buyC <= buyThreshold && socKwh < SOC_TARGET * BATT_KWH && maxChargeKw >= 0.5 && h < SOC_TARGET_BY) {
      // 低价充电，且在 15:00 前（15:00 后不再从电网充）
      // 低价充电
      action   = 'charge';
      chargeKw = maxChargeKw;
      reason   = `buy=${s.buyC}c ≤ ${buyThreshold.toFixed(1)}c`;
    } else if (s.feedInC >= SELL_MIN_C && maxSellKw >= 0.5) {
      // 高价卖电
      action = 'sell';
      sellKw = maxSellKw;
      reason = `feedIn=${s.feedInC}c ≥ ${SELL_MIN_C}c`;
    } else {
      action = 'self-use';
      reason = `buy=${s.buyC}c feedIn=${s.feedInC}c`;
    }

    // SOC 模拟
    const deltaKwh = action === 'charge'
      ? chargeKw * 0.5 * 0.95
      : action === 'sell'
        ? -sellKw * 0.5
        : (net < 0 ? (-net) * 0.5 * 0.9 : -net * 0.5 * 0.85);

    socKwh = Math.min(BATT_KWH, Math.max(SOC_MIN * BATT_KWH, socKwh + deltaKwh));

    plan.push({
      key:      s.key,
      nemTime:  s.nemTime,
      hour:     h,
      buyC:     s.buyC,
      feedInC:  s.feedInC,
      pvKw:     pv,
      homeLoad: hl,
      dw:       s.dw,
      action,
      chargeKw: parseFloat(chargeKw.toFixed(2)),
      sellKw:   parseFloat(sellKw.toFixed(2)),
      socPct:   Math.round(socKwh / BATT_KWH * 100),
      reason,
    });
  }

  return { plan, buyThreshold };
}

// ── Step 6: 逆变器控制 ────────────────────────────────────────
const ESS_HEADERS = {
  Authorization: ESS_TOKEN,
  lang: 'en', showloading: 'false',
  Referer: 'https://eu.ess-link.com/appViews/appHome',
  'User-Agent': 'Mozilla/5.0',
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

function fmt2(n) { return String(n).padStart(2, '0'); }
function hhmm(h, m = 0) { return fmt2(h) + fmt2(m); }

async function applyToInverter(plan, today) {
  console.log('\n[逆变器] 写入充放电窗口...');

  const chargeSlots = plan.filter(s => s.action === 'charge' && s.key.startsWith(today.substring(0,5) || ''));
  // 修正：用 nemTime 前10位匹配今天
  const todaySlots  = plan.filter(s => s.nemTime?.substring(0,10) === today);
  const chargePlan  = todaySlots.filter(s => s.action === 'charge');
  const sellPlan    = todaySlots.filter(s => s.action === 'sell');

  // 充电窗口
  let chargeStartHHMM = '0000', chargeEndHHMM = '0000', chargeKw = 0;
  if (chargePlan.length > 0) {
    const fh = parseInt(chargePlan[0].nemTime.substring(11,13));
    const fm = parseInt(chargePlan[0].nemTime.substring(14,16));
    const lh = parseInt(chargePlan[chargePlan.length-1].nemTime.substring(11,13));
    const lm = parseInt(chargePlan[chargePlan.length-1].nemTime.substring(14,16));
    const endMins = lh*60+lm+30;
    chargeStartHHMM = hhmm(fh, fm);
    chargeEndHHMM   = hhmm(Math.floor(endMins/60), endMins%60);
    chargeKw = Math.min(...chargePlan.map(s => s.chargeKw || 5));
    chargeKw = Math.max(0.5, parseFloat(chargeKw.toFixed(2)));
    console.log(`[逆变器] 充电: ${chargeStartHHMM}–${chargeEndHHMM}, ${chargeKw}kW`);
  } else {
    console.log('[逆变器] 今天无充电计划');
  }

  // 卖电窗口：取充电结束后的第一段卖电
  let sellStartHHMM = '0000', sellEndHHMM = '0000', sellKw = 5;
  if (sellPlan.length > 0) {
    const chargeEndMins = chargeEndHHMM === '0000' ? 0
      : parseInt(chargeEndHHMM.substring(0,2))*60 + parseInt(chargeEndHHMM.substring(2,4));
    const eveningSell = sellPlan.find(s => {
      const sh = parseInt(s.nemTime.substring(11,13));
      const sm = parseInt(s.nemTime.substring(14,16));
      return sh*60+sm >= chargeEndMins;
    }) ?? sellPlan[0];
    const fh = parseInt(eveningSell.nemTime.substring(11,13));
    const fm = parseInt(eveningSell.nemTime.substring(14,16));
    sellStartHHMM = hhmm(fh, fm);
    sellEndHHMM   = '2100';
    console.log(`[逆变器] 卖电: ${sellStartHHMM}–${sellEndHHMM}, ${sellKw}kW`);
  } else {
    console.log('[逆变器] 今天无卖电计划');
  }

  const yd = new Date(); yd.setDate(yd.getDate()-1);
  const td = new Date(); td.setDate(td.getDate()+1);
  const yesterday = yd.toISOString().substring(0,10);
  const tomorrow  = td.toISOString().substring(0,10);

  const steps = [
    ['mode=Timed(1)',                  () => setParam('0x300C', 1)],
    [`chargeStart=${chargeStartHHMM}`, () => setParam('0xC014', chargeStartHHMM)],
    [`chargeEnd=${chargeEndHHMM}`,     () => setParam('0xC016', chargeEndHHMM)],
    [`chargeKw=${chargeKw}`,           () => setParam('0xC0BA', chargeKw)],
    [`sellStart=${sellStartHHMM}`,     () => setParam('0xC018', sellStartHHMM)],
    [`sellEnd=${sellEndHHMM}`,         () => setParam('0xC01A', sellEndHHMM)],
    [`sellKw=${sellKw}`,               () => setParam('0xC0BC', sellKw)],
    ['discharge=0 (initial)',          () => setParam('0xC0BC', chargePlan.length > 0 ? 0 : sellKw)],
    ['otherMode=0',                    () => setParam('0x314E', 0)],
    ['weekdays=all',                   () => setWeekParam('0xC0B4', [1,2,3,4,5,6,0])],
    [`startDate=${yesterday}`,         () => setDateParam('0xC0B6', yesterday)],
    [`endDate=${tomorrow}`,            () => setDateParam('0xC0B8', tomorrow)],
  ];

  let allOk = true;
  for (const [label, fn] of steps) {
    const ok = await fn();
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) allOk = false;
    await new Promise(r => setTimeout(r, 350));
  }
  return allOk;
}

// ── Step 7: 保存到 DB ─────────────────────────────────────────
function savePlan(db, today, plan, meta) {
  db.prepare('UPDATE daily_plan SET is_active=0 WHERE date=? AND is_active=1').run(today);
  const lastVer = db.prepare('SELECT MAX(version) as v FROM daily_plan WHERE date=?').get(today);
  const version = (lastVer?.v ?? 0) + 1;

  // 找充电窗口摘要
  const chargeSlots = plan.filter(s => s.action === 'charge');
  const chargeWindows = chargeSlots.length > 0 ? [{
    startHour: parseInt(chargeSlots[0].key),
    endHour:   parseInt(chargeSlots[chargeSlots.length-1].key) + 1,
    avgBuyC:   parseFloat((chargeSlots.reduce((s,x)=>s+x.buyC,0)/chargeSlots.length).toFixed(1)),
  }] : [];

  db.prepare(`
    INSERT INTO daily_plan
      (date, version, generated_at, source, created_by, soc_at_gen,
       has_demand_window, charge_cutoff_hour,
       pv_forecast_kwh, pv_peak_kw,
       charge_windows_json, intervals_json, notes, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    today, version, new Date().toISOString(), 'v2-rules', 'v2/plan-today.js',
    meta.currentSocPct,
    meta.hasDW ? 1 : 0,
    17,
    parseFloat(meta.pvForecastKwh.toFixed(2)),
    parseFloat(meta.pvPeakKw.toFixed(2)),
    JSON.stringify(chargeWindows),
    JSON.stringify(plan),
    JSON.stringify({ buyThreshold: meta.buyThreshold, sellMinC: SELL_MIN_C, calibFactor: meta.calibFactor }),
  );

  console.log(`\n✅ 计划 v${version} 已存入 DB (source=v2-rules)`);
  return version;
}

// ── Step 8: 打印计划 ──────────────────────────────────────────
function printPlan(plan, currentSocPct, today) {
  const lines = [
    `\n🔋 充放电计划（v2）— ${today}  当前SOC: ${currentSocPct}%`,
    `时间   动作       充电  卖电   买¢    卖¢   SOC   PV`,
    `${'─'.repeat(60)}`,
  ];

  let prevAction = null;
  for (const s of plan) {
    const action = {
      'charge':   '⚡充电',
      'sell':     '💰卖电',
      'self-use': '🔋自用',
      'standby':  '⏸待机',
    }[s.action] ?? s.action;

    const chKw = s.chargeKw > 0 ? `${s.chargeKw.toFixed(1)}kW` : '    -';
    const slKw = s.sellKw   > 0 ? `${s.sellKw.toFixed(1)}kW`   : '    -';
    const dw   = s.dw ? '⚠️' : '';

    if (prevAction && prevAction !== s.action) lines.push('');
    lines.push(
      `${s.key}  ${action.padEnd(6)} ${chKw.padStart(6)} ${slKw.padStart(6)}  ${String(s.buyC.toFixed(1)).padStart(5)}¢ ${String(s.feedInC.toFixed(1)).padStart(5)}¢  ${String(s.socPct).padStart(3)}%  ${s.pvKw.toFixed(1)}kW ${dw}`
    );
    prevAction = s.action;
  }

  const last = plan[plan.length-1];
  lines.push(`${'─'.repeat(60)}`);
  lines.push(`收盘预计: SOC ${last?.socPct ?? '?'}% (${((last?.socPct??0)/100*BATT_KWH).toFixed(1)}kWh)`);

  return lines.join('\n');
}

// ── 发送 WhatsApp ─────────────────────────────────────────────
async function sendWhatsApp(message) {
  try {
    const body = JSON.stringify({ message });
    await new Promise((resolve) => {
      const http = require('http');
      const req = http.request({
        hostname: 'localhost', port: GW_PORT, path: '/send', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(); });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
  } catch { /* silent */ }
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  const syd   = sydneyNow();
  const today = syd.date;
  console.log(`\n===== v2/plan-today.js  ${today} ${syd.hh}:${String(syd.mi).padStart(2,'0')} Sydney =====`);

  const db = new Database(DB_PATH);

  // 1. 当前 SOC
  const latest = db.prepare('SELECT soc FROM energy_log ORDER BY ts DESC LIMIT 1').get();
  const currentSocPct = latest?.soc ?? 50;
  console.log(`[SOC] 当前: ${currentSocPct}%`);

  // 2. PV 校准系数
  const calibFactor = calcPvCalibration(db);

  // 3. 今日 PV 预测（按小时）
  const pvByHour = getPvForecast(db, today, calibFactor);
  const pvForecastKwh = Math.min(MAX_DAILY_KWH, Object.values(pvByHour).reduce((s, v) => s + v, 0));
  const pvPeakKw = Math.max(...Object.values(pvByHour), 0);
  console.log(`[PV预测] 今日预计: ${pvForecastKwh.toFixed(1)}kWh, 峰值: ${pvPeakKw.toFixed(2)}kW`);

  // 4. Amber 价格预测
  console.log('\n[Amber] 拉取价格预测...');
  const rawAmber = await fetchAmberPrices();
  const slots    = aggregateAmberTo30min(rawAmber, today);
  const hasDW    = slots.some(s => s.dw);
  console.log(`[Amber] ${slots.length} 个半小时槽, DW: ${hasDW}`);

  // 5. 生成计划
  const { plan, buyThreshold } = buildPlan(slots, pvByHour, currentSocPct, hasDW);

  // 6. 打印
  const report = printPlan(plan, currentSocPct, today);
  console.log(report);

  // 7. 存 DB
  const version = savePlan(db, today, plan, {
    currentSocPct, hasDW, pvForecastKwh, pvPeakKw, calibFactor, buyThreshold
  });
  db.close();

  // 8. 写逆变器
  await applyToInverter(plan, today);

  // 9. 发 WhatsApp
  await sendWhatsApp(report);
  console.log('\n[完成] 计划已发送到 WhatsApp');
}

main().catch(async e => {
  console.error('[ERROR]', e.message);
  try {
    const http = require('http');
    const msg = `⚠️ v2/plan-today.js 失败：${e.message}`;
    const body = JSON.stringify({ message: msg });
    await new Promise(resolve => {
      const req = http.request({ hostname:'localhost', port:GW_PORT, path:'/send', method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} },
        res=>{res.resume();resolve();});
      req.on('error',()=>resolve()); req.write(body); req.end();
    });
  } catch {}
  process.exit(1);
});
