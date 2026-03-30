# ESS Smart Dispatch — README

## Overview

Automated battery dispatch system for a Sungrow ESS + Amber Electric setup in Sydney, Australia.

Runs every 5 minutes via OpenClaw cron. Fetches real-time data from the Sungrow ESS inverter and Amber API, then applies a priority-based decision tree to switch the inverter between modes (Backup/Self-use/Selling).

---

## Hardware

| Component | Details |
|---|---|
| Inverter | Sungrow ESS |
| Battery | 42 kWh, min SOC 10%, max discharge 5 kW |
| Solar | ~15 kWh/day typical |
| Tariff | Amber Electric (wholesale spot + demand charge) |
| Location | Sydney, NSW — AEST (UTC+11 DST) |

---

## Files

```
scripts/
  demand-mode-manager.js   Main dispatch script (runs every 5 min)
  selling-monitor.js       Safety monitor for selling mode (runs every 5 min when selling)

data/
  energy.db                SQLite database (energy_log + daily_summary tables)
  energy-log.jsonl         JSONL backup of every logged record
  dashboard.html           Interactive HTML chart (generated on demand)
```

---

## Decision Tree (Priority Order)

### Priority 1 — Demand Window Active
- **No charging allowed** (any grid import = demand charge)
- **Selling IS allowed** (grid export does not create demand charge)
- If currently in Backup mode → immediately switch to Self-use
- Otherwise fall through to Priority 5 (sell check)

### Priority 2 — Demand Window Imminent (≤ 10 min)
- Switch to Self-use and hold
- Stops any active charging before DW begins

### Priority 2.5 — Pre-Demand Window Forced Charge (10–60 min before DW)
- If SOC < 60% → force Backup charging regardless of current price
- If SOC ≥ 60% → sufficient reserve, skip forced charge, apply normal rules

### Priority 3 — Free / Negative-Price Charging
- Condition: `spot ≤ 0` AND `SOC < 90%` AND outside DW
- Charge battery at zero cost

### Priority 4 — Cheap Rate Charging
- Condition: `buy < 10c` AND `SOC < 90%` AND outside DW
- Enter Backup mode to charge at low price

### Priority 4b — Extremely Low Descriptor Charging
- Condition: `descriptor = extremelyLow` AND `buy < 12c` AND `SOC < 90%` AND outside DW
- Relaxed price ceiling (12c) when Amber signals an extremely low price period

### Priority 5 — Sell to Grid
- Condition: `feedIn > avg_buy_price + 5c` AND `feedIn ≥ 14c (abs floor)` AND `SOC > 35%` AND inverter headroom > 0.2 kW
- **Allowed inside and outside demand window**
- avg_buy_price = today's weighted average buy price (meter_buy_delta × buy_price method)

### Default — Self-use
- Battery covers home load from solar + stored energy
- No grid import unless home load exceeds battery discharge capacity (5 kW)

---

## Charging Rules Summary

| Rule | Price ceiling | SOC limit | DW allowed? |
|---|---|---|---|
| Negative price (spot ≤ 0) | — | < 90% | No |
| Cheap rate | < 10c | < 90% | No |
| extremelyLow descriptor | < 12c | < 90% | No |
| Pre-DW forced charge | any | < 60% | No |
| PV charging (Self-use) | — | no limit | Yes (hardware) |

> All grid charging requires `SOC < 90%`.  
> PV charging is handled by the inverter in Self-use mode and is not subject to the 90% cap.

---

## Sell Decision — Average Buy Price

Selling threshold is calculated dynamically each run:

```
effective_sell_min = max(14c, today_avg_buy_price + 5c)
```

`today_avg_buy_price` = `SUM(meter_buy_delta × buy_price) / SUM(meter_buy_delta)` for today.

**Edge case protection:**
- Today's grid purchases < 1 kWh (e.g. midnight, early morning) → fall back to 14c floor
- Calculated avg < 1c (data anomaly) → fall back to 14c floor
- DB unavailable → fall back to 14c floor

---

## Demand Charge

Amber charges a demand fee based on the **peak grid import during demand windows**.

- Demand window: typically 15:00–20:00 AEST on weekdays
- Demand charge rate: ~$0.61/kW/day
- Goal: keep grid import = 0 kW during all demand windows
- Alert threshold: any grid import > 0.5 kW during DW triggers a user notification

---

## Data Logging

Records are written to SQLite (`energy_log` table) at:
- **Scheduled**: every :00 and :30 of each hour
- **On mode change**: immediately when the inverter mode switches

Key fields logged per record:

| Field | Description |
|---|---|
| `soc` | Battery state of charge (%) |
| `batt_power` | Battery power (kW, + = charging) |
| `batt_voltage` | Battery voltage (V) |
| `batt_current` | Battery current (A) |
| `pv_power` | Solar generation (kW) |
| `home_load` | Home consumption (kW) |
| `grid_power` | Grid power (kW, − = import, + = export) |
| `buy_price` | Amber buy price (c/kWh) |
| `feedin_price` | Amber feed-in price (c/kWh) |
| `spot_price` | NEM spot price (c/kWh) |
| `demand_window` | Whether demand window is active |
| `amber_descriptor` | Amber price descriptor (extremelyLow / veryLow / low / neutral / high / spike) |
| `meter_buy_delta` | Actual kWh imported since last record (from meter cumulative total) |
| `mode` | Inverter mode set this interval |
| `mode_reason` | Human-readable reason for mode decision |
| `record_trigger` | `scheduled` or `mode_change` |

---

## Environment Variables

```bash
AMBER_API_TOKEN=psk_...          # Amber API key
AMBER_SITE_ID=...                # Amber site ID
ESS_TOKEN=eyJ...                 # Sungrow ESS JWT token
ESS_MAC_HEX=00534E0045FF         # Inverter MAC address
ESS_STATION_SN=EU...             # Station serial number
```

---

## Cron Schedule

```
*/5 * * * *   demand-mode-manager.js   Main dispatch (every 5 min)
```

Selling safety monitor (`selling-monitor.js`) is created/deleted dynamically when entering/leaving Selling mode.

---

## Git Log (recent changes)

Key milestones:
- `fb1f129` DW allows selling but blocks all charging; pre-DW force charge only if SOC < 60%
- `c44369b` Translate all code comments to English
- `d4bf159` Sell avg-price: triple protection (insufficient samples / anomaly / midnight → 12c floor)
- `92fb438` Sell absolute floor 10c → 12c
- `e4b0810` Sell absolute floor 12c → 14c
- `5a7019f` Sell threshold: today avg buy price (meter_buy_delta method) + 5c, remove 15c hard floor
- `1b9051f` Pre-DW forced charge (Priority 2.5) + extremelyLow relaxed ceiling (Priority 4b)
- `9eb04f8` Cheap charge exit SOC unified to 90% (was 95%)
- `7e37901` Pre-switch threshold 5 min → 10 min to avoid missing DW boundary
