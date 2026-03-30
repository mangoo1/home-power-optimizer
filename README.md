# home-power-optimizer

Home solar + battery optimizer for **Amber Electric** + **Sungrow ESS-Link** inverters.

Automatically monitors electricity prices and switches the inverter mode to minimise grid costs, protect against demand charges, and sell excess energy at the right price.

---

## Features

- 🔋 **Smart charging** — charges during cheap/negative price periods; respects SOC limits
- ⚡ **Demand window protection** — blocks all grid charging during peak demand windows; selling still allowed
- 💰 **Dynamic sell threshold** — sells only when `feedIn > today's avg buy price + 5c` (min 14c floor)
- 📊 **Data logging** — SQLite + JSONL at :00/:30 or on mode change; includes meter delta, cost accounting
- 🌞 **Real-time data** — SOC, PV, grid, home load, battery voltage/current via ESS-Link API
- 🛡️ **API fault protection** — skips decision if Amber returns invalid/zero data

---

## Quick Start

```bash
git clone <repo>
cd home-power-optimizer
cp .env.example .env
# Edit .env with your credentials

npm install

# Run once
node scripts/demand-mode-manager.js

# Schedule every 5 minutes via cron (e.g. OpenClaw cron)
# expr: "*/5 * * * *", tz: "Australia/Sydney"
```

---

## Decision Tree (Priority Order)

### Priority 1 — Demand Window Active
- **Charging blocked** (grid import = demand charge)
- **Selling allowed** (grid export does not trigger demand charge)
- If currently in Backup → switch to Self-use immediately
- Otherwise fall through to sell check

### Priority 2 — Demand Window Imminent (≤ 10 min)
- Switch to Self-use and hold — stops any active charging before DW begins

### Priority 2.5 — Pre-Demand Window Forced Charge (10–60 min before DW)
- If `SOC < 60%` → force Backup regardless of price
- If `SOC ≥ 60%` → sufficient reserve, apply normal rules

### Priority 3 — Free / Negative-Price Charging
- `spot ≤ 0` AND `SOC < 90%` AND outside DW → Backup (free charging)

### Priority 4 — Cheap Rate Charging
- `buy < 10c` AND `SOC < 90%` AND outside DW → Backup

### Priority 4b — Extremely Low Descriptor
- `descriptor = extremelyLow` AND `buy < 10c` AND `SOC < 90%` AND outside DW → Backup
- Relaxed ceiling for periods Amber flags as extremely cheap

### Priority 5 — Sell to Grid
- `feedIn ≥ effective_sell_min` AND `SOC > 35%` AND inverter headroom > 0.2 kW → Selling
- `effective_sell_min = max(14c, today_avg_buy_price + 5c)`
- Allowed **inside and outside** demand window

### Default — Self-use
- Battery covers home load from solar + stored energy
- No grid import unless home load exceeds battery discharge limit (5 kW)

---

## Charging Rules Summary

| Rule | Price ceiling | SOC limit | During DW? |
|---|---|---|---|
| Negative price (spot ≤ 0) | — | < 90% | No |
| Cheap rate | < 10c | < 90% | No |
| extremelyLow descriptor | < 10c | < 90% | No |
| Pre-DW forced charge | any | < 60% | No |
| PV charging (Self-use) | — | no limit | Yes (inverter hardware) |

> All grid charging requires `SOC < 90%`.
> PV charging is handled by the inverter in Self-use mode and is not subject to the 90% cap.

---

## Sell Threshold — Dynamic Average Buy Price

```
effective_sell_min = max(14c, today_avg_buy_price + 5c)
```

`today_avg_buy_price` is calculated from actual meter readings:

```sql
SELECT SUM(meter_buy_delta * buy_price / 100.0) / SUM(meter_buy_delta) * 100
FROM energy_log
WHERE date(ts) = today AND meter_buy_delta > 0
```

**Edge case protection** (falls back to 14c floor when):
- Today's grid purchases < 1 kWh (e.g. midnight, no data yet)
- Calculated avg < 1c (data anomaly)
- DB unavailable

---

## Demand Charge

Amber charges a demand fee based on the **peak grid import during demand windows**.

- Demand window: typically **15:00–20:00 AEST** on weekdays
- Rate: ~$0.61/kW/day
- Goal: keep grid import = 0 kW during all demand windows
- Alert: grid import > 0.5 kW during DW triggers user notification

---

## Requirements

- Node.js 18+
- [Amber Electric](https://www.amber.com.au/) account + API token
- Sungrow ESS-Link inverter (eu.ess-link.com) + JWT token

---

## Configuration

Copy `.env.example` to `.env`:

```env
AMBER_API_TOKEN=psk_...
AMBER_SITE_ID=01K...
ESS_TOKEN=eyJ...
ESS_MAC_HEX=00534E...
ESS_STATION_SN=EU177...
```

---

## Data Schema

SQLite tables: `energy_log` + `daily_summary`

### energy_log — key columns

| Column | Type | Description |
|---|---|---|
| `ts` | TEXT | ISO timestamp (primary key) |
| `soc` | REAL | Battery state of charge (%) |
| `batt_power` | REAL | Battery power kW (+ = charging) |
| `batt_voltage` | REAL | Battery voltage (V) |
| `batt_current` | REAL | Battery current (A) |
| `pv_power` | REAL | Solar generation (kW) |
| `home_load` | REAL | Home consumption (kW) |
| `grid_power` | REAL | Grid power kW (− = import, + = export) |
| `buy_price` | REAL | Amber buy price (c/kWh) |
| `feedin_price` | REAL | Amber feed-in price (c/kWh) |
| `spot_price` | REAL | NEM spot price (c/kWh) |
| `demand_window` | INTEGER | 1 if demand window active |
| `amber_descriptor` | TEXT | Price descriptor (extremelyLow / veryLow / low / neutral / high / spike) |
| `meter_buy_delta` | REAL | Actual kWh imported since last record (meter cumulative diff) |
| `meter_sell_delta` | REAL | Actual kWh exported since last record |
| `interval_buy_aud` | REAL | Cost this interval (AUD) |
| `interval_sell_aud` | REAL | Revenue this interval (AUD) |
| `interval_net_aud` | REAL | Net cost this interval (AUD) |
| `mode` | INTEGER | Inverter mode set (0=Self-use, 3=Backup, 6=Selling) |
| `mode_reason` | TEXT | Human-readable reason for mode decision |
| `record_trigger` | TEXT | `scheduled` or `mode_change` |

### daily_summary — key columns

| Column | Description |
|---|---|
| `date` | Date (YYYY-MM-DD) |
| `home_kwh` | Total home consumption |
| `grid_buy_kwh` | Total grid import |
| `grid_sell_kwh` | Total grid export |
| `cost_aud` | Total electricity cost |
| `earnings_aud` | Total feed-in revenue |
| `demand_peak_kw` | Peak grid import during demand windows |
| `demand_charge_est` | Estimated demand charge for the day |
| `avg_soc` / `min_soc` / `max_soc` | Battery SOC statistics |

---

## License

MIT
