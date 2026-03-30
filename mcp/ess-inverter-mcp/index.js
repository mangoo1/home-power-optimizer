#!/usr/bin/env node
/**
 * ess-inverter-mcp — ESS-Link Inverter Control MCP server
 *
 * Config (via env or .env file two levels up):
 *   ESS_BASE_URL     Base URL (default: https://eu.ess-link.com)
 *   ESS_TOKEN        JWT bearer token (required)
 *   ESS_MAC_HEX      Device MAC address hex (required, e.g. AABBCCDDEEFF)
 *   ESS_STATION_SN   Station serial number (required for web API calls)
 */

// Load .env from project root (two levels up from mcp/ess-inverter-mcp/)
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
 *
 * Inverter modes (index 0x300C):
 *   0 = Self-use       (default — use solar/battery, buy only when needed)
 *   1 = Timed          (scheduled charge/discharge windows)
 *   3 = Backup         (force charge battery from grid)
 *   5 = PV Priority    (solar first, excess to grid)
 *   6 = Selling        (discharge battery + solar to grid aggressively)
 */
 *   6 = Selling        (discharge battery + solar to grid aggressively)
 *
 * Read endpoints:
 *   getBatteryInfo       — SOC, voltage, current, power, charge/discharge totals
 *   getLoadInfo          — home load power (kW)
 *   getMeterInfo         — grid import/export power + cumulative kWh
 *   getPhotovoltaicInfo  — PV cumulative energy (kWh)
 *   getDeviceInfo        — device metadata, firmware, model
 *   getInverterInfo      — inverter AC output, frequency, temperature
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL    = (process.env.ESS_BASE_URL || "https://eu.ess-link.com").replace(/\/$/, "");
const TOKEN       = process.env.ESS_TOKEN;
const MAC_HEX     = process.env.ESS_MAC_HEX     || "";
const STATION_SN  = process.env.ESS_STATION_SN  || "";

if (!TOKEN)   { console.error("[ess-inverter-mcp] ESS_TOKEN is required");   process.exit(1); }
if (!MAC_HEX) { console.error("[ess-inverter-mcp] ESS_MAC_HEX is required"); process.exit(1); }

// Web API uses Bearer prefix + cookie-style token; App API uses raw JWT
const WEB_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Referer: `${BASE_URL}/appViews/appHome`,
  lang: "en",
  showloading: "false",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36",
};

// ESS requires these headers on every request
const ESS_HEADERS = {
  lang: "en", platform: "linux", projectType: "1", source: "app",
  "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  Origin: `${BASE_URL.replace("eu.", "euapp.")}`,
  Referer: `${BASE_URL.replace("eu.", "euapp.")}/`,
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function essRequest(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const headers = { Authorization: TOKEN, ...ESS_HEADERS };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Parse error: ${text.slice(0, 200)}`); }
}

const httpsGet  = (path)        => essRequest("GET",  path, null);
const httpsPost = (path, body)  => essRequest("POST", path, body);

// Web API helper (different base path + Bearer header)
async function webGet(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { method: "GET", headers: WEB_HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Parse error: ${text.slice(0, 200)}`); }
}

// ── ESS helpers ───────────────────────────────────────────────────────────────
async function essGet(endpoint, macHex = MAC_HEX) {
  const res = await httpsGet(`/api/app/deviceInfo/${endpoint}?macHex=${macHex}`);
  if (res.code !== 200) throw new Error(`ESS API error ${res.code}: ${res.msg}`);
  return res.data;
}

function findVal(items, index) {
  if (!items) return null;
  const item = Array.isArray(items) ? items.find(i => i.index === index) : items[index];
  return item ? { value: item.value, unit: item.unit, label: item.label, valueStr: item.valueStr } : null;
}

const MODE_LABEL = { 0: "Self-use", 1: "Timed", 3: "Backup", 5: "PV-Priority", 6: "Selling" };
const MODE_BY_NAME = { "self-use": 0, "timed": 1, "backup": 3, "pv-priority": 5, "selling": 6 };

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "ess_get_battery",
    description: [
      "Read battery state: SOC (%), voltage (V), current (A), power (kW, +charge/-discharge),",
      "lifetime charge/discharge totals (kWh). Index map:",
      "0x1212=SOC, 0x1210=power, 0x120C=voltage, 0x120E=current,",
      "0x125E=charge total, 0x1260=discharge total.",
    ].join(" "),
    inputSchema: { type: "object", properties: { mac_hex: { type: "string", description: "Device MAC (omit for default)" } } },
  },
  {
    name: "ess_get_load",
    description: "Read home load power (kW). Index 0x1274 = total home consumption.",
    inputSchema: { type: "object", properties: { mac_hex: { type: "string" } } },
  },
  {
    name: "ess_get_meter",
    description: [
      "Read grid meter data: grid power (kW, +import/-export), cumulative buy/sell kWh.",
      "Index map: 0xA112=grid power, 0x1240=total bought (kWh), 0x1242=total sold (kWh).",
    ].join(" "),
    inputSchema: { type: "object", properties: { mac_hex: { type: "string" } } },
  },
  {
    name: "ess_get_pv",
    description: "Read PV (solar) data: cumulative generation (kWh). Index 0x125C = total PV energy.",
    inputSchema: { type: "object", properties: { mac_hex: { type: "string" } } },
  },
  {
    name: "ess_get_inverter",
    description: "Read inverter AC output, frequency, temperature, and operating status.",
    inputSchema: { type: "object", properties: { mac_hex: { type: "string" } } },
  },
  {
    name: "ess_get_device_info",
    description: "Read device metadata: model, firmware version, serial number, online status.",
    inputSchema: { type: "object", properties: { mac_hex: { type: "string" } } },
  },
  {
    name: "ess_get_all",
    description: [
      "Read all key data at once (battery + load + meter + PV) and return a parsed summary.",
      "Returns: soc, battPower, homeLoad, gridPower, pvEnergyTotal, battVoltage, battCurrent,",
      "purchasedTotal, feedTotal.",
    ].join(" "),
    inputSchema: { type: "object", properties: { mac_hex: { type: "string" } } },
  },
  {
    name: "ess_set_mode",
    description: [
      "Set inverter operating mode. Modes: self-use (0), timed (1), backup (3), pv-priority (5), selling (6).",
      "Pass mode as a name string (e.g. 'backup') or numeric value.",
      "WARNING: this immediately changes inverter behaviour.",
    ].join(" "),
    inputSchema: {
      type: "object",
      required: ["mode"],
      properties: {
        mode:    { description: "Mode name: self-use | timed | backup | pv-priority | selling — or numeric 0/1/3/5/6" },
        mac_hex: { type: "string", description: "Device MAC (omit for default)" },
      },
    },
  },
  {
    name: "ess_get_running_info",
    description: [
      "Get device running info via web API (/api/web/deviceInfo/getDevicRunningInfo).",
      "Returns current inverter mode (x300C: 0=Self-use,1=Timed,3=Backup,5=PV-Priority,6=Selling),",
      "today's energy breakdown (kWh): x1264=PV, x1266=batt-charge, x1268=batt-discharge,",
      "x126A=grid-buy, x126C=grid-sell, x126E=home-load,",
      "carbon savings (kg CO2), and 7-day carbon history.",
      "Requires ESS_STATION_SN env var (e.g. YOUR_STATION_SN).",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        station_sn: { type: "string", description: "Station serial number (omit to use ESS_STATION_SN default)" },
      },
    },
  },
  {
    name: "ess_get_flow",
    description: [
      "Get realtime energy flow diagram data (/api/web/station/totalFlowDiagram).",
      "Single call returns all power flows in kW:",
      "totalPVPower (solar), totalGridPower (negative=export/selling, positive=import/buying),",
      "totalBatteryPower (positive=charging, negative=discharging),",
      "totalLoadPower (home AC load), totalGeneratorPower, totalChargerPower, isFlow.",
      "This is the data source for the ESS portal energy flow animation.",
      "Most efficient single-call snapshot of current system state.",
      "Requires ESS_STATION_SN env var.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        station_sn: { type: "string", description: "Station serial number (omit to use ESS_STATION_SN default)" },
      },
    },
  },
  {
    name: "ess_get_income",
    description: [
      "Get station income/earnings via web API (/api/web/station/getIncome).",
      "Returns financial income data if configured in ESS portal (FIT/feed-in tariff setup required).",
      "Note: may return empty data if income tracking is not configured for this station.",
      "Requires ESS_STATION_SN env var.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        station_sn: { type: "string", description: "Station serial number (omit to use ESS_STATION_SN default)" },
      },
    },
  },
  {
    name: "ess_get_battery_details",
    description: [
      "Get battery summary via web API (/api/web/deviceInfo/getBatteryDetailsInfo).",
      "Returns: soc (%), totalpower (kW realtime), todaycharge/todaydischarge (kWh today),",
      "totalcharge/totaldischarge (kWh lifetime), and per-device SOC list.",
      "Requires ESS_STATION_SN env var.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        station_sn: { type: "string", description: "Station serial number (omit to use ESS_STATION_SN default)" },
      },
    },
  },
  {
    name: "ess_get_mode",
    description: "Read the current inverter operating mode (0x300C). Returns numeric value and label.",
    inputSchema: { type: "object", properties: { mac_hex: { type: "string" } } },
  },
  {
    name: "ess_set_param",
    description: [
      "Low-level: write any device parameter by index and value.",
      "Use ess_set_mode for mode changes; use this for other params.",
      "Known writable params: 0x300C=mode, 0x300E=backup SOC target (%), 0x3006=timed charge SOC.",
    ].join(" "),
    inputSchema: {
      type: "object",
      required: ["index", "value"],
      properties: {
        index:   { type: "string", description: "Parameter index hex string e.g. '0x300C'" },
        value:   { description: "Value to write (number)" },
        mac_hex: { type: "string" },
      },
    },
  },
];

// ── Server ────────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "ess-inverter-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  // mcporter may pass empty-object positional args — normalise to undefined
  const mac = (typeof args.mac_hex === "string" && args.mac_hex) ? args.mac_hex : MAC_HEX;

  try {
    let result;

    switch (name) {

      case "ess_get_battery": {
        const data = await essGet("getBatteryInfo", mac);
        result = {
          soc:            findVal(data, "0x1212"),
          power_kw:       findVal(data, "0x1210"),   // + charge / - discharge
          voltage_v:      findVal(data, "0x120C"),
          current_a:      findVal(data, "0x120E"),
          charge_total:   findVal(data, "0x125E"),   // kWh lifetime
          discharge_total: findVal(data, "0x1260"),  // kWh lifetime
          raw: data,
        };
        break;
      }

      case "ess_get_load": {
        const data = await essGet("getLoadInfo", mac);
        result = {
          home_load_kw: findVal(data, "0x1274"),
          raw: data,
        };
        break;
      }

      case "ess_get_meter": {
        const data = await essGet("getMeterInfo", mac);
        const gridRaw = findVal(data, "0xA112");
        result = {
          // 0xA112 sign convention (inverter perspective):
          //   negative = buying from grid (import)
          //   positive = selling to grid (export)
          grid_power_kw:   gridRaw,
          grid_import_kw:  gridRaw ? -gridRaw.value : null,  // positive = buying
          purchased_total: findVal(data, "0x1240"),           // kWh cumulative buy
          feed_total:      findVal(data, "0x1242"),           // kWh cumulative sell
          raw: data,
        };
        break;
      }

      case "ess_get_pv": {
        const data = await essGet("getPhotovoltaicInfo", mac);
        // 0x1270 = Total PV power realtime (kW); value may decode to 0 — use parseFloat(valueStr)
        const pvPowerRaw = findVal(data, "0x1270");
        result = {
          pv_power_kw:     pvPowerRaw ? parseFloat(pvPowerRaw.valueStr) : null,  // realtime kW
          pv_energy_total: findVal(data, "0x125C"),  // kWh cumulative
          pv1_voltage:     findVal(data, "0x1200"),
          pv1_current:     findVal(data, "0x1202"),
          pv2_voltage:     findVal(data, "0x1206"),
          pv2_current:     findVal(data, "0x1208"),
          raw: data,
        };
        break;
      }

      case "ess_get_inverter": {
        const data = await essGet("getInverterInfo", mac);
        result = { raw: data };
        break;
      }

      case "ess_get_device_info": {
        const data = await essGet("getDeviceInfo", mac);
        result = { raw: data };
        break;
      }

      case "ess_get_all": {
        const [battery, load, meter, pv] = await Promise.all([
          essGet("getBatteryInfo", mac),
          essGet("getLoadInfo", mac),
          essGet("getMeterInfo", mac),
          essGet("getPhotovoltaicInfo", mac),
        ]);
        const g    = (d, idx) => findVal(d, idx)?.value ?? null;
        const gStr = (d, idx) => { const f = findVal(d, idx); return f ? parseFloat(f.valueStr) : null; };
        // 0xA112: negative = buying from grid, positive = selling to grid (inverter perspective)
        const gridRaw = g(meter, "0xA112");
        // 0x1270: PV realtime kW — value field may be 0 due to float encoding, use valueStr
        const pvPowerKw = gStr(pv, "0x1270");
        result = {
          soc:                  g(battery, "0x1212"),  // %
          batt_power_kw:        g(battery, "0x1210"),  // + charging / - discharging
          batt_voltage_v:       g(battery, "0x120C"),
          batt_current_a:       g(battery, "0x120E"),
          batt_charge_total:    g(battery, "0x125E"),  // kWh lifetime
          batt_discharge_total: g(battery, "0x1260"),  // kWh lifetime
          home_load_kw:         g(load, "0x1274"),
          pv_power_kw:          pvPowerKw,             // kW realtime (0x1270)
          pv_energy_total:      g(pv, "0x125C"),       // kWh cumulative
          grid_power_kw:        gridRaw,               // negative=buying, positive=selling
          grid_import_kw:       gridRaw !== null ? -gridRaw : null,  // positive = buying from grid
          purchased_total:      g(meter, "0x1240"),    // kWh lifetime buy
          feed_total:           g(meter, "0x1242"),    // kWh lifetime sell
        };
        break;
      }

      case "ess_get_flow": {
        const sn = (typeof args.station_sn === "string" && args.station_sn) ? args.station_sn : STATION_SN;
        if (!sn) throw new Error("station_sn required (or set ESS_STATION_SN env var)");
        const raw = await webGet(`/api/web/station/totalFlowDiagram?stationSn=${sn}`);
        if (raw.code !== 200) throw new Error(`ESS web API error ${raw.code}: ${raw.msg}`);
        const d = raw.data;
        result = {
          pv_power_kw:        d.totalPVPower,        // kW solar generating now
          grid_power_kw:      d.totalGridPower,      // kW: negative=selling/export, positive=buying/import
          grid_import_kw:     d.totalGridPower !== null ? -d.totalGridPower : null,  // positive=buying
          battery_power_kw:   d.totalBatteryPower,   // kW: positive=charging, negative=discharging
          load_power_kw:      d.totalLoadPower,      // kW home AC load
          generator_power_kw: d.totalGeneratorPower,
          charger_power_kw:   d.totalChargerPower,
          is_flow:            d.isFlow,              // 1 = energy flowing
        };
        break;
      }

      case "ess_get_income": {
        const sn = (typeof args.station_sn === "string" && args.station_sn) ? args.station_sn : STATION_SN;
        if (!sn) throw new Error("station_sn required (or set ESS_STATION_SN env var)");
        const raw = await webGet(`/api/web/station/getIncome?stationSn=${sn}`);
        if (raw.code !== 200) throw new Error(`ESS web API error ${raw.code}: ${raw.msg}`);
        // Note: data may be null if FIT/income tracking not configured in ESS portal
        result = raw.data ?? { note: "No income data returned — FIT configuration may be required in ESS portal" };
        break;
      }

      case "ess_get_battery_details": {
        const sn = (typeof args.station_sn === "string" && args.station_sn) ? args.station_sn : STATION_SN;
        if (!sn) throw new Error("station_sn required (or set ESS_STATION_SN env var)");
        const raw = await webGet(`/api/web/deviceInfo/getBatteryDetailsInfo?stationSn=${sn}`);
        if (raw.code !== 200) throw new Error(`ESS web API error ${raw.code}: ${raw.msg}`);
        const d = raw.data;
        result = {
          soc:               d.soc,            // % current
          power_kw:          d.totalpower,     // kW realtime (+ charging / - discharging)
          today_charge_kwh:  d.todaycharge,    // kWh charged today
          today_discharge_kwh: d.todaydischarge, // kWh discharged today
          total_charge_kwh:  d.totalcharge,    // kWh lifetime charged
          total_discharge_kwh: d.totaldischarge, // kWh lifetime discharged
          device_soc:        d.deviceSOC,      // per-device SOC list [{deviceSn, soc}]
        };
        break;
      }

      case "ess_get_running_info": {
        const sn = (typeof args.station_sn === "string" && args.station_sn) ? args.station_sn : STATION_SN;
        if (!sn) throw new Error("station_sn required (or set ESS_STATION_SN env var)");
        const raw = await webGet(`/api/web/deviceInfo/getDevicRunningInfo?stationSn=${sn}`);
        if (raw.code !== 200) throw new Error(`ESS web API error ${raw.code}: ${raw.msg}`);
        const d = raw.data;
        result = {
          // Current inverter mode (0=Self-use, 1=Timed, 3=Backup, 5=PV-Priority, 6=Selling)
          mode:          d.x300C,
          mode_label:    MODE_LABEL[d.x300C] ?? "unknown",
          // Today's energy (kWh) — field names are hex index without 0x prefix
          today_pv_kwh:          d.x1264,   // PV generated today
          today_batt_charge_kwh: d.x1266,   // battery charged today
          today_batt_discharge_kwh: d.x1268, // battery discharged today
          today_grid_buy_kwh:    d.x126A,   // bought from grid today
          today_grid_sell_kwh:   d.x126C,   // sold to grid today
          today_home_kwh:        d.x126E,   // home consumption today
          // Carbon
          today_carbon_kg:       d.carbon,
          total_carbon_kg:       d.totalCarbonSum,
          carbon_history:        d.carbonList,
          // Status
          status:      d.status,
          is_offline:  d.isOffline,
          raw: d,
        };
        break;
      }

      case "ess_get_mode": {
        const data = await essGet("getDeviceRunningInfo", mac);
        // mode is typically in running info; fallback to raw
        result = { raw: data };
        break;
      }

      case "ess_set_mode": {
        let modeVal = args.mode;
        if (typeof modeVal === "string") {
          const resolved = MODE_BY_NAME[modeVal.toLowerCase()];
          if (resolved === undefined) throw new Error(`Unknown mode "${modeVal}". Valid: ${Object.keys(MODE_BY_NAME).join(", ")}`);
          modeVal = resolved;
        }
        const res = await httpsPost("/api/app/deviceInfo/setDeviceParam", {
          data: modeVal, macHex: mac, index: "0x300C",
        });
        if (res.code !== 200) throw new Error(`ESS set mode failed: ${JSON.stringify(res)}`);
        result = { ok: true, mode: modeVal, modeLabel: MODE_LABEL[modeVal] ?? "unknown", response: res };
        break;
      }

      case "ess_set_param": {
        const res = await httpsPost("/api/app/deviceInfo/setDeviceParam", {
          data: args.value, macHex: mac, index: args.index,
        });
        if (res.code !== 200) throw new Error(`ESS set param failed: ${JSON.stringify(res)}`);
        result = { ok: true, index: args.index, value: args.value, response: res };
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
