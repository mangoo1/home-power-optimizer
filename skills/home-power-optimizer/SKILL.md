# home-power-optimizer — SKILL.md

## Overview

Home solar + battery optimizer for Amber Electric + ESS-Link inverters.
Automatically reads real-time energy data and switches inverter modes based on electricity prices, SOC, and demand window schedules.

## Tools

### amber-mcp
```bash
mcporter call amber-mcp amber_get_current_price '{}'
mcporter call amber-mcp amber_get_prices '{"start_date": "2026-03-30"}'
mcporter call amber-mcp amber_get_renewables '{}'
```

### ess-inverter-mcp
```bash
mcporter call ess-inverter-mcp ess_get_all '{}'           # realtime snapshot
mcporter call ess-inverter-mcp ess_get_flow '{}'          # energy flow diagram
mcporter call ess-inverter-mcp ess_get_running_info '{}'  # today's totals + mode
mcporter call ess-inverter-mcp ess_get_battery_details '{}' # battery kWh today
mcporter call ess-inverter-mcp ess_set_mode '{"mode": "backup"}'
```

## Decision Rules (demand-mode-manager.js)

| Priority | Condition | Mode |
|----------|-----------|------|
| 1 | Demand window active | Self-use (0) — protect demand charge |
| 2 | Demand window in ≤5 min | Self-use (0) — pre-emptive |
| 3 | spot ≤ 0c AND SOC < 90% | Backup (3) — free charging |
| 4 | buy < 10c AND SOC < 95% | Backup (3) — cheap charging |
| 5 | feedIn ≥ 10c AND SOC > 35% | Selling (6) — export revenue |
| — | Default | Self-use (0) |

## Data

- SQLite: `data/energy.db` — table `energy_log` (one row per 30min interval)
- JSONL backup: `data/energy-log.jsonl`
- Key columns: `soc`, `pv_power`, `grid_power`, `buy_price`, `amber_cl_price`, `amber_feedin_price`, `interval_buy_aud`, `interval_sell_aud`, `interval_net_aud`, `meter_buy_delta`, `meter_sell_delta`

## Setup

```bash
cp .env.example .env
# fill in .env with your tokens
npm install
cd mcp/amber-mcp && npm install
cd mcp/ess-inverter-mcp && npm install
```

## Running

```bash
# One-shot
node scripts/demand-mode-manager.js

# Or via cron (every 30min at :00 and :30)
# cron expr: 0,30 * * * * (Australia/Sydney)
```

## Environment Variables

See `.env.example` for all required variables:
- `AMBER_API_TOKEN`, `AMBER_SITE_ID`, `AMBER_BASE_URL`
- `ESS_TOKEN`, `ESS_MAC_HEX`, `ESS_STATION_SN`, `ESS_BASE_URL`
- `OPENCLAW_GATEWAY_PORT`

## Compatibility

- Amber Electric (Australia) — any site
- ESS-Link inverters (EU region) — tested with S-SL model
- Node.js 18+
