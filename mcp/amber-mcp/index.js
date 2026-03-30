#!/usr/bin/env node
/**
 * amber-mcp — Amber Electric API MCP server
 *
 * Config (via env or .env file two levels up):
 *   AMBER_BASE_URL   Base URL (default: https://api.amber.com.au/v1)
 *   AMBER_API_TOKEN  Bearer token (required)
 *   AMBER_SITE_ID    Default site ID (optional — can be passed per-call)
 */

// Load .env from project root (two levels up from mcp/amber-mcp/)
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL  = (process.env.AMBER_BASE_URL || "https://api.amber.com.au/v1").replace(/\/$/, "");
const TOKEN     = process.env.AMBER_API_TOKEN;
const SITE_ID   = process.env.AMBER_SITE_ID || "";

if (!TOKEN) { console.error("[amber-mcp] AMBER_API_TOKEN is required"); process.exit(1); }

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function amberGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${path}`);
  return res.json();
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "amber_get_sites",
    description: "List all Amber sites/NMIs on this account. Returns id, nmi, channels, network.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "amber_get_current_price",
    description: [
      "Get current interval prices (buy + feed-in). Includes perKwh (all-up c/kWh),",
      "spotPerKwh (wholesale), renewables %, descriptor (extremelyLow…spike),",
      "demandWindow flag, and optional N forecast intervals.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        site_id:    { type: "string",  description: "Site ID (omit to use default)" },
        resolution: { type: "number",  description: "Interval resolution in minutes: 5 or 30 (default 30)" },
        next:       { type: "number",  description: "Number of forecast intervals to include (default 8)" },
        previous:   { type: "number",  description: "Number of previous intervals to include (default 0)" },
      },
    },
  },
  {
    name: "amber_get_prices",
    description: [
      "Get price schedule for a date range (actual + forecast). If no dates given,",
      "returns today's schedule. Useful for day-ahead planning.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        site_id:    { type: "string", description: "Site ID (omit to use default)" },
        start_date: { type: "string", description: "YYYY-MM-DD (default: today)" },
        end_date:   { type: "string", description: "YYYY-MM-DD (default: today)" },
        resolution: { type: "number", description: "5 or 30 (default 30)" },
      },
    },
  },
  {
    name: "amber_get_usage",
    description: "Get actual consumption data for a date range. Returns per-interval kWh, cost, and prices.",
    inputSchema: {
      type: "object",
      required: ["start_date", "end_date"],
      properties: {
        site_id:    { type: "string", description: "Site ID (omit to use default)" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date:   { type: "string", description: "YYYY-MM-DD" },
        resolution: { type: "number", description: "5 or 30 (default 30)" },
      },
    },
  },
  {
    name: "amber_get_renewables",
    description: "Get current grid renewables percentage and descriptor for the site's region.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: { type: "string", description: "Site ID (omit to use default)" },
      },
    },
  },
];

// ── Server ────────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "amber-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const siteId     = args.site_id || SITE_ID;
  const resolution = args.resolution || 30;

  try {
    let data;

    switch (name) {

      case "amber_get_sites":
        data = await amberGet("/sites");
        break;

      case "amber_get_current_price": {
        const next     = args.next     ?? 8;
        const previous = args.previous ?? 0;
        data = await amberGet(
          `/sites/${siteId}/prices/current?resolution=${resolution}&next=${next}&previous=${previous}`
        );
        break;
      }

      case "amber_get_prices": {
        const today = new Date().toISOString().slice(0, 10);
        const start = args.start_date || today;
        const end   = args.end_date   || today;
        data = await amberGet(
          `/sites/${siteId}/prices?startDate=${start}&endDate=${end}&resolution=${resolution}`
        );
        break;
      }

      case "amber_get_usage": {
        data = await amberGet(
          `/sites/${siteId}/usage?startDate=${args.start_date}&endDate=${args.end_date}&resolution=${resolution}`
        );
        break;
      }

      case "amber_get_renewables": {
        // Renewables is embedded in the current price response — extract it
        const raw = await amberGet(
          `/sites/${siteId}/prices/current?resolution=30&next=0&previous=0`
        );
        const general = Array.isArray(raw) ? raw.find(p => p.channelType === "general") : null;
        data = general
          ? { renewables: general.renewables, descriptor: general.descriptor, nemTime: general.nemTime }
          : raw;
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
