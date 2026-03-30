# home-power-optimizer

Home solar + battery optimizer for **Amber Electric** + **ESS-Link** inverters.

Automatically monitors electricity prices and switches your inverter mode to minimize grid costs and maximize solar/battery value.

## Features

- 🔋 **Smart mode switching** — Backup (cheap charging), Selling (high feed-in), Self-use (default)
- ⚡ **Demand window protection** — never draws from grid during peak demand periods
- 📊 **30-min data logging** — SQLite + JSONL with prices, power flows, and cost accounting
- 🌞 **Real-time data** — SOC, PV, grid, home load, battery via ESS-Link API
- 💰 **Cost tracking** — per-interval buy/sell cost + meter delta columns

## Quick Start

```bash
git clone <repo>
cd home-power-optimizer
cp .env.example .env
# Edit .env with your Amber API token and ESS-Link credentials

npm install
cd mcp/amber-mcp && npm install && cd ../..
cd mcp/ess-inverter-mcp && npm install && cd ../..

# Run once
node scripts/demand-mode-manager.js

# Schedule every 30min at :00 and :30 (OpenClaw cron)
# expr: "0,30 * * * *", tz: "Australia/Sydney"
```

## MCP Servers

| Server | Tools | Description |
|--------|-------|-------------|
| `amber-mcp` | 5 tools | Electricity prices, forecasts, usage |
| `ess-inverter-mcp` | 13 tools | Inverter control, battery, flow data |

## Decision Logic

```
spot ≤ 0c → Backup (free charge)
buy < 10c + SOC < 95% → Backup (cheap charge)
feedIn ≥ 10c + SOC > 35% → Selling (export)
demand window → Self-use (always)
default → Self-use
```

## Requirements

- Node.js 18+
- [Amber Electric](https://www.amber.com.au/) account + API token
- ESS-Link inverter (eu.ess-link.com) + JWT token

## Configuration

Copy `.env.example` to `.env` and fill in:

```env
AMBER_API_TOKEN=psk_...
AMBER_SITE_ID=01K...
ESS_TOKEN=eyJ...
ESS_MAC_HEX=00534E...
ESS_STATION_SN=EU177...
```

## Data Schema

SQLite table `energy_log` — key columns:

| Column | Type | Description |
|--------|------|-------------|
| `ts` | TEXT | ISO timestamp |
| `soc` | REAL | Battery % |
| `pv_power` | REAL | Solar kW |
| `grid_power` | REAL | Grid kW (negative=import) |
| `buy_price` | REAL | General tariff c/kWh |
| `amber_cl_price` | REAL | Controlled load c/kWh |
| `amber_feedin_price` | REAL | Feed-in tariff c/kWh |
| `interval_buy_aud` | REAL | Cost this interval AUD |
| `interval_sell_aud` | REAL | Earnings this interval AUD |
| `interval_net_aud` | REAL | Net cost this interval AUD |
| `meter_buy_delta` | REAL | Actual import kWh (meter diff) |
| `meter_sell_delta` | REAL | Actual export kWh (meter diff) |

## License

MIT
