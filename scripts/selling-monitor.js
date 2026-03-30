#!/usr/bin/env node
/**
 * selling-monitor.js
 *
 * 每 5 分钟执行一次，专门管理卖电逻辑：
 *
 * 卖电安全条件（必须全部满足）：
 *   1. 不在 demand window（绝对禁止）
 *   2. PV 发电 >= 家庭用电（家用完全由光伏覆盖，电网进出 = 0）
 *   3. SOC > 55%（保留足够 demand window 用量）
 *   4. feedIn >= 15 c/kWh（卖电有利润）
 *   5. 不是夜间（PV 为 0，卖电 = 纯放电 + 电网补家用）
 *
 * 退出卖电条件（任一满足即退出）：
 *   - PV < 家庭用电（电网开始补电，立即停）
 *   - 进入 demand window（立即切 Self-use）
 *   - SOC <= 55%（电量不足）
 *   - feedIn < 10c（无利润）
 *   - gridPower > 0.1 kW（实测电网在补电，立即停）
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// Load .env from project root (one level up from scripts/)
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const AMBER_TOKEN = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID || "YOUR_AMBER_SITE_ID";
const ESS_TOKEN = process.env.ESS_TOKEN;
const MAC_HEX = process.env.ESS_MAC_HEX || "YOUR_ESS_MAC_HEX";

const MODE = { SELF_USE: 0, TIMED: 1, PV_PRIORITY: 5, SELLING: 6, BACKUP: 3 };
const MODE_LABEL = { 0: "Self-use", 1: "Timed", 3: "Backup", 5: "PV-Priority", 6: "Selling", 7: "Voltage-Reg" };

// 策略参数
const SOC_MIN_SELL = 35;           // 卖电 SOC 底线（保留给明天 demand window ~35% = 14.7kWh）
const SOC_EXIT_SELL = 30;          // 退出卖电的 SOC（留 5% 缓冲）
const FEEDIN_ENTER = 10;           // 进入卖电最低 feedIn（c/kWh）
const FEEDIN_EXIT = 8;             // 退出卖电最低 feedIn（c/kWh）
const GRID_SAFETY_THRESHOLD = 0.15; // 电网进口容忍值（kW），超过立即停卖电
const INVERTER_MAX_KW = 5.0;       // 逆变器最大放电功率（kW）
const INVERTER_HEADROOM = 0.3;     // 安全余量（kW），防止边缘情况

const STATE_FILE = "/tmp/selling-monitor-state.json";
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || "18789";
const SELLING_MONITOR_CRON_NAME = "selling-monitor-active";

const ESS_HEADERS = {
  lang: "en", platform: "linux", projectType: "1", source: "app",
  Origin: "https://euapp.ess-link.com", Referer: "https://euapp.ess-link.com/",
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
    }, res => {
      let resp = "";
      res.on("data", c => resp += c);
      res.on("end", () => { try { resolve(JSON.parse(resp)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

// ── ESS helpers ───────────────────────────────────────────────────────────────
async function essGet(ep) {
  if (!ESS_TOKEN) return null;
  try {
    const d = await httpsGet(
      `https://eu.ess-link.com/api/app/deviceInfo/${ep}?macHex=${MAC_HEX}`,
      { Authorization: ESS_TOKEN, ...ESS_HEADERS }
    );
    return d.code === 200 ? d.data : null;
  } catch { return null; }
}

function findVal(items, index) {
  if (!items) return null;
  const item = Array.isArray(items) ? items.find(i => i.index === index) : items[index];
  return item?.value ?? null;
}

async function setMode(mode) {
  if (!ESS_TOKEN) { console.log(`[SKIP] No ESS_TOKEN`); return false; }
  try {
    const r = await httpsPost(
      "https://eu.ess-link.com/api/app/deviceInfo/setDeviceParam",
      { data: mode, macHex: MAC_HEX, index: "0x300C" },
      { Authorization: ESS_TOKEN, ...ESS_HEADERS }
    );
    return r.code === 200;
  } catch { return false; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { mode: null, sellingSince: null, lastCheck: null }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function httpLocal(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = require("http").request({
      hostname: "localhost", port: parseInt(GATEWAY_PORT),
      path, method,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function deleteSelfCron() {
  try {
    const r = await httpLocal("GET", "/api/cron/jobs", null);
    const job = (r.jobs || []).find(j => j.name === SELLING_MONITOR_CRON_NAME && j.enabled);
    if (job) {
      await httpLocal("DELETE", `/api/cron/jobs/${job.id}`, null);
      console.log(`[INFO] self-deleted selling-monitor cron (${job.id})`);
    }
  } catch (e) { console.error(`[ERROR] deleteSelfCron: ${e.message}`); }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  console.log(`[${now.toISOString()}] === selling-monitor ===`);

  // 并发获取数据
  const [battery, load, meter, amberRaw] = await Promise.all([
    essGet("getBatteryInfo"),
    essGet("getLoadInfo"),
    essGet("getMeterInfo"),
    httpsGet(
      `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?resolution=30&next=4`,
      { Authorization: `Bearer ${AMBER_TOKEN}` }
    ).catch(() => []),
  ]);

  const soc = findVal(battery, "0x1212");
  const battPower = findVal(battery, "0x1210");   // + 充电 / - 放电
  const homeLoad = findVal(load, "0x1274");        // kW
  const gridPower = findVal(meter, "0xA112");      // + 买电 / - 卖电

  // 推算 PV：homeLoad = pvPower + battDischarge + gridImport
  const battDischarge = battPower != null ? -battPower : 0;
  const gridImport = gridPower != null ? gridPower : 0;
  const pvPower = Math.max(0, (homeLoad ?? 0) - battDischarge - gridImport);

  // Amber
  const general = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "general") : [];
  const feedInCh = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "feedIn") : [];
  const current = general[0] || {};
  const demandWindow = current.tariffInformation?.demandWindow ?? false;
  const feedInPrice = Math.abs(feedInCh[0]?.perKwh ?? 0); // Amber feedIn perKwh 为负数，取绝对值
  const spotPrice = current.spotPerKwh ?? 0;
  const buyPrice = current.perKwh ?? 0;

  // 可卖电余量：逆变器最大 5kW - 当前家用，剩余给卖电
  // 卖电时：电池放电 = homeLoad + sellPower，总计 ≤ 5kW
  const maxSellPower = Math.max(0, INVERTER_MAX_KW - (homeLoad ?? 0) - INVERTER_HEADROOM);
  const canSellPower = maxSellPower > 0.2; // 至少有 0.2kW 余量才值得卖

  console.log(`[DATA] SOC:${soc}%  BattPwr:${battPower?.toFixed(2)}kW  HomeLoad:${homeLoad?.toFixed(2)}kW  PV:${pvPower?.toFixed(2)}kW  Grid:${gridPower?.toFixed(3)}kW`);
  console.log(`[DATA] MaxSellPower:${maxSellPower.toFixed(2)}kW  feedIn:${feedInPrice.toFixed(2)}c  demandWindow:${demandWindow}`);

  const state = loadState();
  const currentlySelling = state.mode === MODE.SELLING;

  // ── 安全退出检查（优先级最高）──────────────────────────────────────────
  if (currentlySelling) {
    let exitReason = null;

    if (demandWindow) {
      exitReason = `进入 demand window，立即停止卖电`;
    } else if (gridPower > GRID_SAFETY_THRESHOLD) {
      exitReason = `⚠️ 检测到电网进口 ${gridPower.toFixed(3)} kW > ${GRID_SAFETY_THRESHOLD} kW，立即停止卖电防 demand charge`;
    } else if (!canSellPower) {
      exitReason = `家用 ${homeLoad?.toFixed(2)}kW 过高，逆变器无余量卖电（最大 ${INVERTER_MAX_KW}kW）`;
    } else if (soc <= SOC_EXIT_SELL) {
      exitReason = `SOC ${soc}% ≤ ${SOC_EXIT_SELL}%，停止卖电保留明天用量`;
    } else if (feedInPrice < FEEDIN_EXIT) {
      exitReason = `feedIn ${feedInPrice.toFixed(2)}c < ${FEEDIN_EXIT}c，卖电无利润`;
    }

    if (exitReason) {
      console.log(`[EXIT SELL] ${exitReason}`);
      const ok = await setMode(MODE.SELF_USE);
      if (ok) {
        const duration = state.sellingSince
          ? ((now - new Date(state.sellingSince)) / 60000).toFixed(0)
          : "?";
        console.log(`[ACTION] 切换到 Self-use（卖电持续了 ${duration} 分钟）`);
        state.mode = MODE.SELF_USE;
        state.sellingSince = null;
        state.lastExitReason = exitReason;
        await deleteSelfCron(); // 自删 5 分钟 cron
      }
      saveState({ ...state, lastCheck: now.toISOString() });
      return;
    }

    // 继续卖电
    const duration = state.sellingSince
      ? ((now - new Date(state.sellingSince)) / 60000).toFixed(0)
      : "?";
    console.log(`[INFO] 继续卖电（已卖 ${duration} 分钟，SOC:${soc}%，feedIn:${feedInPrice.toFixed(1)}c，PV surplus:${pvSurplus.toFixed(2)}kW）`);
    saveState({ ...state, lastCheck: now.toISOString() });
    return;
  }

  // ── 进入卖电检查 ──────────────────────────────────────────────────────────
  if (!currentlySelling) {
    const canSell =
      !demandWindow &&                        // 不在 demand window
      canSellPower &&                         // 逆变器有余量（家用 < 4.7kW）
      soc > SOC_MIN_SELL &&                   // SOC 充裕，保留明天用量
      feedInPrice >= FEEDIN_ENTER &&          // 卖电有利润
      gridPower <= GRID_SAFETY_THRESHOLD;     // 电网当前不进口

    if (canSell) {
      console.log(`[ENTER SELL] feedIn:${feedInPrice.toFixed(1)}c  SOC:${soc}%  MaxSellPower:${maxSellPower.toFixed(2)}kW → 切换到 Selling Mode`);
      const ok = await setMode(MODE.SELLING);
      if (ok) {
        state.mode = MODE.SELLING;
        state.sellingSince = now.toISOString();
        console.log(`[ACTION] ✅ 已切换到 Selling Mode（最大可卖 ${maxSellPower.toFixed(2)}kW）`);
      }
    } else {
      const reasons = [];
      if (demandWindow) reasons.push(`在 demand window`);
      if (!canSellPower) reasons.push(`家用 ${homeLoad?.toFixed(1)}kW，逆变器余量仅 ${maxSellPower.toFixed(2)}kW`);
      if (soc <= SOC_MIN_SELL) reasons.push(`SOC ${soc}% ≤ ${SOC_MIN_SELL}%`);
      if (feedInPrice < FEEDIN_ENTER) reasons.push(`feedIn ${feedInPrice.toFixed(1)}c < ${FEEDIN_ENTER}c`);
      if (gridPower > GRID_SAFETY_THRESHOLD) reasons.push(`电网进口 ${gridPower.toFixed(3)}kW`);
      console.log(`[INFO] 不卖电：${reasons.join("，")}`);
    }
  }

  saveState({ ...state, lastCheck: now.toISOString() });
  console.log(`[DONE]`);
}

main().catch(err => { console.error("[FATAL]", err.message); process.exit(1); });
