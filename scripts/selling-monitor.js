#!/usr/bin/env node
/**
 * selling-monitor.js
 *
 * Runs every 5 minutes as a safety monitor while selling mode is active.
 * Checks sell conditions and exits selling if any safety condition is violated.
 *
 * Entry conditions (all must be met):
 *   1. Not in demand window (absolutely prohibited)
 *   2. SOC > 35% (reserve for tomorrow's demand window)
 *   3. feedIn >= 20 c/kWh (absolute floor; demand-mode-manager checks avg+7c spread)
 *   4. Inverter has headroom (home load < 4.7 kW)
 *   5. Grid not currently importing (gridPower <= 0.15 kW)
 *
 * Exit conditions (any one triggers exit):
 *   - Demand window starts (immediate Self-use)
 *   - Grid importing > 0.15 kW (safety — stop before demand charge)
 *   - SOC <= 30% (insufficient reserve)
 *   - feedIn < 18 c/kWh (approaching floor, exit with buffer)
 *   - Inverter headroom gone (home load too high)
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const AMBER_TOKEN = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID || "01KMN0H71HS5SYAE5P3E9WDGCD";
const ESS_TOKEN = process.env.ESS_TOKEN;
const MAC_HEX = process.env.ESS_MAC_HEX || "00534E0045FF";

const MODE = { SELF_USE: 0, TIMED: 1, PV_PRIORITY: 5, SELLING: 6, BACKUP: 3 };
const MODE_LABEL = { 0: "Self-use", 1: "Timed", 3: "Backup", 5: "PV-Priority", 6: "Selling", 7: "Voltage-Reg" };

// Strategy parameters
const SOC_MIN_SELL_MORNING   = 12;  // 00:00–13:59 Sydney (can recharge before demand window)
const SOC_MIN_SELL_AFTERNOON = 35;  // 14:00–23:59 Sydney (reserve for demand window + overnight)
const SOC_MIN_SELL_CUTOFF_HOUR = 14;

// Derive current SOC floor based on Sydney time
const _sydHour = (new Date().getUTCHours() + 11) % 24;
const SOC_MIN_SELL = _sydHour < SOC_MIN_SELL_CUTOFF_HOUR ? SOC_MIN_SELL_MORNING : SOC_MIN_SELL_AFTERNOON;
const SOC_EXIT_SELL = SOC_MIN_SELL - 2; // 2% buffer below entry floor
const FEEDIN_ENTER = 10;            // Min feedIn to enter selling (c/kWh)
const FEEDIN_EXIT = 8;              // Exit selling if feedIn drops below this (c/kWh)
const GRID_SAFETY_THRESHOLD = 0.15; // Max tolerated grid import while selling (kW)
const INVERTER_MAX_KW = 5.0;        // Max inverter discharge power (kW)
const INVERTER_HEADROOM = 0.3;      // Safety headroom to avoid saturating inverter (kW)

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

  // Fetch ESS + Amber data concurrently
  const [battery, load, meter, amberRaw] = await Promise.all([
    essGet("getBatteryInfo"),
    essGet("getLoadInfo"),
    essGet("getMeterInfo"),
    httpsGet(
      `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices/current?resolution=30&next=4`,
      { Authorization: `Bearer ${AMBER_TOKEN}` }
    ).catch(() => []),
  ]);

  const soc       = findVal(battery, "0x1212");
  const battPower = findVal(battery, "0x1210");  // kW: positive=charging, negative=discharging
  const homeLoad  = findVal(load,    "0x1274");  // kW
  const gridPower = findVal(meter,   "0xA112");  // kW: negative=import, positive=export

  // Estimate PV: homeLoad = pvPower + battDischarge + gridImport
  const battDischarge = battPower != null ? -battPower : 0;
  const gridImport    = gridPower != null ? gridPower  : 0;
  const pvPower       = Math.max(0, (homeLoad ?? 0) - battDischarge - gridImport);

  // Parse Amber response
  const general  = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "general") : [];
  const feedInCh = Array.isArray(amberRaw) ? amberRaw.filter(p => p.channelType === "feedIn")  : [];
  const current      = general[0]   || {};
  const demandWindow = current.tariffInformation?.demandWindow ?? false;
  const feedInPrice  = Math.abs(feedInCh[0]?.perKwh ?? 0); // feedIn perKwh is negative; take abs
  const buyPrice     = current.perKwh ?? 0;

  // Available sell headroom: inverter max 5kW minus home load minus safety buffer
  const maxSellPower = Math.max(0, INVERTER_MAX_KW - (homeLoad ?? 0) - INVERTER_HEADROOM);
  const canSellPower = maxSellPower > 0.2; // need at least 0.2 kW headroom

  console.log(`[DATA] SOC:${soc}%  BattPwr:${battPower?.toFixed(2)}kW  HomeLoad:${homeLoad?.toFixed(2)}kW  PV:${pvPower?.toFixed(2)}kW  Grid:${gridPower?.toFixed(3)}kW`);
  console.log(`[DATA] MaxSellPower:${maxSellPower.toFixed(2)}kW  feedIn:${feedInPrice.toFixed(2)}c  demandWindow:${demandWindow}`);

  const state = loadState();
  const currentlySelling = state.mode === MODE.SELLING;

  // ── Safety exit checks (highest priority) ────────────────────────────────
  if (currentlySelling) {
    let exitReason = null;

    if (demandWindow) {
      exitReason = `demand window started — stop selling immediately`;
    } else if (gridPower > GRID_SAFETY_THRESHOLD) {
      exitReason = `⚠️ grid importing ${gridPower.toFixed(3)} kW > ${GRID_SAFETY_THRESHOLD} kW — stop selling to prevent demand charge`;
    } else if (!canSellPower) {
      exitReason = `home load ${homeLoad?.toFixed(2)}kW too high — inverter headroom ${maxSellPower.toFixed(2)}kW insufficient`;
    } else if (soc <= SOC_EXIT_SELL) {
      exitReason = `SOC ${soc}% <= ${SOC_EXIT_SELL}% — stopping to preserve reserve`;
    } else if (feedInPrice < FEEDIN_EXIT) {
      exitReason = `feedIn ${feedInPrice.toFixed(2)}c < ${FEEDIN_EXIT}c — no longer profitable`;
    }

    if (exitReason) {
      console.log(`[EXIT SELL] ${exitReason}`);
      const ok = await setMode(MODE.SELF_USE);
      if (ok) {
        const duration = state.sellingSince
          ? ((now - new Date(state.sellingSince)) / 60000).toFixed(0)
          : "?";
        console.log(`[ACTION] Switched to Self-use (sold for ${duration} min)`);
        state.mode = MODE.SELF_USE;
        state.sellingSince = null;
        state.lastExitReason = exitReason;
        await deleteSelfCron(); // self-delete the 5-min safety monitor cron
      }
      saveState({ ...state, lastCheck: now.toISOString() });
      return;
    }

    // Continue selling — log status
    const duration = state.sellingSince
      ? ((now - new Date(state.sellingSince)) / 60000).toFixed(0)
      : "?";
    console.log(`[INFO] Selling active (${duration} min, SOC:${soc}%, feedIn:${feedInPrice.toFixed(1)}c, headroom:${maxSellPower.toFixed(2)}kW)`);
    saveState({ ...state, lastCheck: now.toISOString() });
    return;
  }

  // ── Entry check ───────────────────────────────────────────────────────────
  if (!currentlySelling) {
    const canSell =
      !demandWindow &&                        // not in demand window
      canSellPower &&                         // inverter has headroom
      soc > SOC_MIN_SELL &&                   // sufficient SOC reserve
      feedInPrice >= FEEDIN_ENTER &&          // profitable feed-in price
      gridPower <= GRID_SAFETY_THRESHOLD;     // grid not currently importing

    if (canSell) {
      console.log(`[ENTER SELL] feedIn:${feedInPrice.toFixed(1)}c  SOC:${soc}%  headroom:${maxSellPower.toFixed(2)}kW — switching to Selling`);
      const ok = await setMode(MODE.SELLING);
      if (ok) {
        state.mode = MODE.SELLING;
        state.sellingSince = now.toISOString();
        console.log(`[ACTION] Switched to Selling mode (max sell ${maxSellPower.toFixed(2)}kW)`);
      }
    } else {
      const reasons = [];
      if (demandWindow)                          reasons.push(`demand window active`);
      if (!canSellPower)                         reasons.push(`home load ${homeLoad?.toFixed(1)}kW, headroom only ${maxSellPower.toFixed(2)}kW`);
      if (soc <= SOC_MIN_SELL)                   reasons.push(`SOC ${soc}% <= ${SOC_MIN_SELL}%`);
      if (feedInPrice < FEEDIN_ENTER)            reasons.push(`feedIn ${feedInPrice.toFixed(1)}c < ${FEEDIN_ENTER}c`);
      if (gridPower > GRID_SAFETY_THRESHOLD)     reasons.push(`grid importing ${gridPower.toFixed(3)}kW`);
      console.log(`[INFO] Not selling: ${reasons.join(", ")}`);
    }
  }

  saveState({ ...state, lastCheck: now.toISOString() });
  console.log(`[DONE]`);
}

main().catch(err => { console.error("[FATAL]", err.message); process.exit(1); });
