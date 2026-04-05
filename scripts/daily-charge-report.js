#!/usr/bin/env node
/**
 * daily-charge-report.js
 *
 * 生成基于规则的半小时充放电计划，发送到 WhatsApp。
 * 原则：最低电费 = 低价充电 + 高价卖电 + 20% SOC 保底
 *
 * 用法：node scripts/daily-charge-report.js
 */
'use strict';

const https    = require('https');
const path     = require('path');
const Database = require('better-sqlite3');

const AMBER_TOKEN   = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID;
const DB_PATH       = path.join(__dirname, '..', 'data', 'energy.db');

// ── 系统参数 ──────────────────────────────────────────────────
const BATT_KWH      = 42;
const BREAKER       = 7.7;
const CHARGE_BUFFER = 1.0;   // kW 空开安全余量
const MAX_CH        = 5.0;   // kW 最大充电
const MAX_DIS       = 5.0;   // kW 最大放电
const CHARGE_MAX_C  = 10.0;  // ¢ 充电买价上限
const SELL_MIN_C    = 5.0;   // ¢ 卖电最低 feedIn
const SOC_MIN_PCT   = 20;    // % 最低余量保留
const SOC_TARGET    = 85;    // % 充电目标

// ── 今晚预计消耗（保留量） ────────────────────────────────────
// 傍晚(19-23) 4h×1.5kW + 过夜(23-06:30) 7.5h×0.35kW + 20%保底
const OVERNIGHT_KWH = 4 * 1.5 + 7.5 * 0.35 + (SOC_MIN_PCT / 100) * BATT_KWH; // ~17 kWh

// ── 工具函数 ──────────────────────────────────────────────────
function getSydneyNow() {
  const now = new Date();
  const offset = parseInt(now.toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney', timeZoneName: 'shortOffset'
  }).match(/([+-]\d+)/)?.[1] || '10', 10);
  return new Date(now.getTime() + offset * 3600 * 1000);
}

function getSydneyHour() {
  return parseInt(new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney', hour: 'numeric', hour12: false
  }), 10);
}

function fetchAmberPrices() {
  return new Promise((resolve, reject) => {
    const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?next=336`;
    https.get(url, { headers: { Authorization: `Bearer ${AMBER_TOKEN}` } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function getESSData() {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare(
      'SELECT soc, pv_power, home_load FROM energy_log ORDER BY ts DESC LIMIT 1'
    ).get();
    db.close();
    return row || { soc: null, pv_power: 0, home_load: 1.0 };
  } catch { return { soc: null, pv_power: 0, home_load: 1.0 }; }
}

function getActualPV() {
  // 拿今天实测 PV 按半小时聚合
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.prepare(
      "SELECT ts, pv_power FROM energy_log WHERE ts >= datetime('now','start of day','-10 hours') ORDER BY ts"
    ).all();
    db.close();
    const slots = {};
    rows.forEach(r => {
      const t = new Date(r.ts);
      // ts is UTC ISO string; convert to Sydney
      const offsetMs = (() => {
        const h = parseInt(new Date(r.ts).toLocaleString('en-AU', {
          timeZone: 'Australia/Sydney', hour: 'numeric', hour12: false
        }), 10);
        return (h - new Date(r.ts).getUTCHours() + 24) % 24 * 3600000;
      })();
      const aest  = new Date(t.getTime() + offsetMs);
      const h     = aest.getUTCHours();
      const slot  = aest.getUTCMinutes() < 30 ? 0 : 30;
      const key   = String(h).padStart(2,'0') + ':' + String(slot).padStart(2,'0');
      if (!slots[key]) slots[key] = [];
      slots[key].push(r.pv_power || 0);
    });
    const result = {};
    Object.entries(slots).forEach(([k, v]) => {
      result[k] = parseFloat((v.reduce((a,b) => a+b,0) / v.length).toFixed(2));
    });
    return result;
  } catch { return {}; }
}

function homeLoadEstimate(hourAEST) {
  if (hourAEST >= 6 && hourAEST < 10) return 5.5;  // 热水器时段
  if (hourAEST >= 17 && hourAEST < 21) return 1.5;  // 傍晚
  return 1.0;
}

async function main() {
  const ess       = getESSData();
  const socPct    = ess.soc ?? 50;
  let   socKwh    = socPct / 100 * BATT_KWH;
  const sydNow    = getSydneyNow();
  const nowH      = getSydneyHour();
  const nowMin    = sydNow.getUTCMinutes();
  const nowSlot   = nowMin < 30 ? 0 : 30;
  const pvActual  = getActualPV();

  // 拉价格
  const raw = await fetchAmberPrices();
  if (!Array.isArray(raw)) throw new Error('Amber API error: ' + JSON.stringify(raw).slice(0,100));

  // 按半小时聚合
  const priceSlots = {};
  raw.forEach(p => {
    const t    = new Date(p.startTime);
    // Convert to Sydney time properly
    const sydStr = t.toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', hour12: false
    });
    const parts = sydStr.match(/(\d+)\/(\d+)\/(\d+),\s*(\d+):(\d+)/);
    if (!parts) return;
    const [, dd, mm, yyyy, hh, min] = parts;
    const todaySyd = sydNow.toISOString().slice(0,10).split('-').reverse().join('/');
    // only today
    if (`${dd}/${mm}/${yyyy}` !== todaySyd.split('-').reverse().join('/') &&
        `${dd}/${mm}/${yyyy}` !== `${String(sydNow.getUTCDate()).padStart(2,'0')}/${String(sydNow.getUTCMonth()+1).padStart(2,'0')}/${sydNow.getUTCFullYear()}`) return;

    const slotMin = parseInt(min) < 30 ? 0 : 30;
    const key     = hh + ':' + String(slotMin).padStart(2,'0');
    if (!priceSlots[key]) priceSlots[key] = { buyN:0, buyS:0, fiS:0, dw:false };
    if (p.channelType === 'general') { priceSlots[key].buyS += p.perKwh; priceSlots[key].buyN++; }
    if (p.channelType === 'feedIn')  priceSlots[key].fiS += Math.abs(p.perKwh);
    if (p.tariffInformation?.demandWindow) priceSlots[key].dw = true;
  });

  // 只取当前时间之后的 slot
  const slots = Object.entries(priceSlots)
    .map(([k, v]) => ({
      time: k,
      buy:  v.buyN > 0 ? v.buyS / v.buyN : 0,
      fi:   v.buyN > 0 ? v.fiS  / v.buyN : 0,
      dw:   v.dw
    }))
    .filter(s => {
      const [h, m] = s.time.split(':').map(Number);
      return h > nowH || (h === nowH && m >= nowSlot);
    })
    .sort((a, b) => a.time.localeCompare(b.time));

  // ── 生成计划 ──────────────────────────────────────────────
  const rows = [];
  for (const s of slots) {
    const [h, m]  = s.time.split(':').map(Number);
    const pv      = pvActual[s.time] ?? 0;  // 实测优先，无则 0
    const hl      = homeLoadEstimate(h);
    const net     = hl - pv;                 // 净家用需求

    // 充电余量
    const headroom = BREAKER - Math.max(0, net) - CHARGE_BUFFER;
    const chargeKw = parseFloat(Math.min(MAX_CH, Math.max(0, headroom)).toFixed(2));

    // 安全可卖电量（保留 OVERNIGHT_KWH）
    const safeKwh   = socKwh - OVERNIGHT_KWH;
    const maxSellKw = parseFloat(Math.min(MAX_DIS, MAX_DIS - hl).toFixed(2));
    const sellKw    = safeKwh > 0
      ? parseFloat(Math.min(maxSellKw, (safeKwh / 0.5) * 0.9).toFixed(2))
      : 0;

    let action, powerKw, deltaKwh;

    if (s.dw) {
      action   = 'DW自用';
      powerKw  = 0;
      deltaKwh = net > 0 ? -net * 0.5 * 0.3 : (-net) * 0.5 * 0.9;
    } else if (s.buy <= CHARGE_MAX_C && chargeKw >= 1.0 && socKwh < BATT_KWH * (SOC_TARGET/100)) {
      action   = '⚡充电';
      powerKw  = chargeKw;
      deltaKwh = chargeKw * 0.5 * 0.95;
    } else if (s.fi >= SELL_MIN_C && sellKw >= 0.5) {
      action   = '💰卖电';
      powerKw  = sellKw;
      deltaKwh = -sellKw * 0.5;
    } else {
      action   = '🔋自用';
      powerKw  = 0;
      deltaKwh = net < 0 ? (-net) * 0.5 * 0.9 : -net * 0.5 * 0.3;
    }

    socKwh = Math.min(BATT_KWH, Math.max(BATT_KWH * SOC_MIN_PCT/100, socKwh + deltaKwh));
    rows.push({
      time:    s.time,
      buy:     s.buy.toFixed(1),
      fi:      s.fi.toFixed(1),
      pv:      pv.toFixed(2),
      hl:      hl.toFixed(1),
      dw:      s.dw,
      action,
      powerKw: powerKw > 0 ? powerKw.toFixed(2) : '-',
      soc:     Math.round(socKwh / BATT_KWH * 100),
    });
  }

  // ── 格式化输出 ─────────────────────────────────────────────
  const timeStr = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney', hour:'2-digit', minute:'2-digit', hour12: false
  });

  const lines = [
    `🔋 充放电计划 ${timeStr} AEST（SOC ${socPct}%）`,
    `保留底线: ${OVERNIGHT_KWH.toFixed(0)}kWh | 无DW | 充电≤${CHARGE_MAX_C}¢ | 卖电≥${SELL_MIN_C}¢`,
    '',
    '时间  动作    功率  买¢   卖¢   SOC',
    '─────────────────────────────────',
  ];

  for (const r of rows) {
    const act  = r.action.padEnd(6);
    const pw   = r.powerKw.padStart(5) + 'kW';
    const buy  = r.buy.padStart(5) + '¢';
    const fi   = r.fi.padStart(5) + '¢';
    const soc  = String(r.soc).padStart(3) + '%';
    const dw   = r.dw ? '⚠️' : '';
    lines.push(`${r.time}  ${act} ${pw}  ${buy}  ${fi}  ${soc} ${dw}`);
  }

  const finalSoc = rows[rows.length-1]?.soc ?? socPct;
  lines.push('─────────────────────────────────');
  lines.push(`收盘预计: SOC ${finalSoc}%（${(finalSoc/100*BATT_KWH).toFixed(1)}kWh）`);

  const report = lines.join('\n');
  console.log(report);
  return report;
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
