# ESS Smart Dispatch — README

## Overview

Automated battery dispatch system for a Sungrow ESS + Amber Electric setup in Sydney, Australia.

Runs every 5 minutes via OpenClaw cron. Fetches real-time data from the Sungrow ESS inverter and Amber API, then applies a priority-based decision tree to switch the inverter between modes (Self-use / Timed-charge / Timed-sell).

---

## Hardware

| Component | Details |
|---|---|
| Inverter | Sungrow ESS |
| Battery | 42 kWh, min SOC 10%, max charge/discharge 5 kW |
| Solar | ~15 kWh/day typical |
| Main breaker | 32A @ 240V = 7.68 kW physical max |
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

secrets/
  amber-api.env            API keys and config (gitignored)
```

---

## Environment Variables

```bash
AMBER_API_TOKEN=psk_...          # Amber API key
AMBER_SITE_ID=...                # Amber site ID
ESS_TOKEN=eyJ...                 # Sungrow ESS JWT token
ESS_MAC_HEX=00534E0045FF         # Inverter MAC address
ESS_STATION_SN=EU...             # Station serial number
MAIN_BREAKER_KW=7.7              # Main breaker limit (kW) — used for charge power calculation
```

`MAIN_BREAKER_KW` defaults to `7.7` if not set. Change this value in `secrets/amber-api.env` to match your breaker without touching the code.

---

## Decision Tree (Priority Order)

### Priority 1 — Demand Window Active
- **No charging allowed** (any grid import = demand charge)
- **Selling IS allowed** (grid export does not create demand charge)
- If currently in Backup/charging mode → immediately switch to Self-use
- Otherwise fall through to Priority 5 (sell check)

### Priority 2 — Demand Window Imminent (≤ 10 min)
- Switch to Self-use and hold
- Stops any active charging before DW begins

### Priority 2.5 — Pre-Demand Window Forced Charge (10–60 min before DW)
- If SOC < 60% → force charging regardless of current price
- If SOC ≥ 60% → sufficient reserve, skip forced charge, apply normal rules

### Grid Headroom Check (all charging paths)
Before any charging decision, the script checks available grid headroom:
```
netHouseDraw = homeLoad - pvPower
availableChargeKw = MAIN_BREAKER_KW - netHouseDraw
```
If `availableChargeKw < MIN_CHARGE_KW (1.0 kW)` → skip charging / exit charging mode.
This prevents tripping the main breaker under heavy household load.

### Priority 3 — Free / Negative-Price Charging
- Condition: `spot ≤ 0` AND `SOC < 90%` AND outside DW AND grid headroom OK
- Charge battery at zero or negative cost

### Priority 4 — Cheap Rate Charging
- Condition: `buy < 10.4c` AND `SOC < 90%` AND outside DW AND grid headroom OK
- Enter Timed charge mode at dynamic power

### Priority 4b — Extremely Low Descriptor Charging
- Condition: `descriptor = extremelyLow` AND `buy < 10.4c` AND `SOC < 90%` AND outside DW AND grid headroom OK

### Priority 5 — Sell to Grid
- Condition: `feedIn ≥ max(14c, avg_buy_price + 5c)` AND `SOC > 35%` AND inverter headroom > 0.2 kW
- **Allowed inside and outside demand window**
- avg_buy_price = today's weighted average buy price (meter_buy_delta × buy_price method)

### Default — Self-use
- Battery covers home load from solar + stored energy
- SOC ≥ 90%: PV charges battery naturally, no grid charging

---

## Charging Rules Summary

| Rule | Price ceiling | SOC limit | Grid headroom check | DW allowed? |
|---|---|---|---|---|
| Negative price (spot ≤ 0) | — | < 90% | Yes | No |
| Cheap rate | < 10.4c | < 90% | Yes | No |
| extremelyLow descriptor | < 10.4c | < 90% | Yes | No |
| Pre-DW forced charge | any | < 60% | Yes | No |
| PV charging (Self-use) | — | no limit | N/A (hardware) | Yes |

> SOC ≥ 90%: grid charging stops, PV charges naturally via Self-use mode.

---

## Timed Mode — Buy & Sell via Inverter API

Both charging (buy) and selling (sell) use **Timed mode** (`0x300C = 1`) on the inverter.
Each has a dedicated register set for its time window and power. They are **mutually exclusive**:
when one is active, the other's time window is collapsed to `0000–0000` and power set to 0.

### Buy (Charge from Grid)

| Step | Register | Value | Description |
|---|---|---|---|
| 0 | `0x3050` | `"YYYY-MM-DD HH:MM:SS"` | Sync inverter clock |
| 1 | `0x300C` | `1` | Set Timed mode |
| 2 | `0xC014` | `HHMM` (now − 1 min) | Charge start time (already active) |
| 3 | `0xC016` | `HHMM` (now + 10 min) | Charge end time (rolling window) |
| 4 | `0xC0BA` | dynamic kW | **Charge power** (see formula below) |
| 5 | `0xC0BC` | `0` | Discharge power = 0 (no simultaneous discharge) |
| 6 | `0xC018` | `"0000"` | Sell start = 0000 (collapse sell window) |
| 7 | `0xC01A` | `"0000"` | Sell end = 0000 (collapse sell window) |
| 8 | `0x314E` | `0` | Other mode param (fixed) |
| 9 | `0xC0B4` | `[0-6]` | Active all days |
| 10 | `0xC0B6` | yesterday | Start date |
| 11 | `0xC0B8` | tomorrow | End date |

**Dynamic charge power formula (updated every 5 min):**
```
netHouseDraw = homeLoad - pvPower
chargeKw = min(MAX_CHARGE_KW=5, max(0, MAIN_BREAKER_KW - netHouseDraw))
```
- Total grid import = netHouseDraw + chargeKw ≤ MAIN_BREAKER_KW
- PV output offsets house load, freeing up headroom for charging
- If `chargeKw < MIN_CHARGE_KW=1.0`, charging is skipped

Examples (MAIN_BREAKER_KW = 7.7):
| homeLoad | PV | netHouseDraw | chargeKw | total grid |
|---|---|---|---|---|
| 0.5 kW | 3.0 kW | −2.5 kW | 5.0 kW | 2.5 kW ✓ |
| 4.5 kW | 2.0 kW | 2.5 kW | 5.0 kW | 7.5 kW ✓ |
| 6.0 kW | 1.0 kW | 5.0 kW | 2.7 kW | 7.7 kW ✓ |
| 7.0 kW | 0.5 kW | 6.5 kW | 1.2 kW | 7.7 kW ✓ |
| 7.5 kW | 0.0 kW | 7.5 kW | 0.2 kW | skipped (< 1 kW) |

### Sell (Discharge to Grid)

| Step | Register | Value | Description |
|---|---|---|---|
| 0 | `0x3050` | `"YYYY-MM-DD HH:MM:SS"` | Sync inverter clock |
| 1 | `0x300C` | `1` | Set Timed mode |
| 2 | `0xC018` | `HHMM` (now − 1 min) | Sell start time (already active) |
| 3 | `0xC01A` | `HHMM` (now + 10 min) | Sell end time (rolling window) |
| 4 | `0xC0BC` | `5` | **Discharge power** = 5 kW (fixed) |
| 5 | `0xC0BA` | `0` | Charge power = 0 (no simultaneous charging) |
| 6 | `0xC014` | `"0000"` | Charge start = 0000 (collapse charge window) |
| 7 | `0xC016` | `"0000"` | Charge end = 0000 (collapse charge window) |
| 8 | `0x314E` | `0` | Other mode param (fixed) |
| 9 | `0xC0B4` | `[0-6]` | Active all days |
| 10 | `0xC0B6` | yesterday | Start date |
| 11 | `0xC0B8` | tomorrow | End date |

### Rolling Updates (every 5 min while mode is active)

**While charging (Timed charge mode):**
- Roll `0xC014` (start) and `0xC016` (end) forward to current time ±
- Re-calculate `chargeKw` from latest homeLoad + pvPower → update `0xC0BA`
- Keep `0xC018/0xC01A = 0000` (sell window stays collapsed)

**While selling (Timed sell mode):**
- Roll `0xC01A` (sell end) forward +10 min
- Keep `0xC014/0xC016 = 0000` (charge window stays collapsed)

---

## Mode Switch Verification

Every mode switch goes through `setModeWithVerify()`:

| Target mode | Verify condition | Max attempts | Wait after cmd | Retry interval |
|---|---|---|---|---|
| Self-use (0) | `reported = 0` | 5 | 6 s | 5 s |
| Charging / Backup (3) | `reported = 1 or 3` | 2 | 4 s | 3 s |
| Selling (6) | `reported = 1` + grid exporting | 2 | 4 s | 3 s |

**Key rule:** Do NOT rely on Timed mode window expiry to exit charging/selling. Always explicitly send `setMode(0)` and verify `reported = 0` before considering Self-use confirmed.

---

## Sell Decision — Average Buy Price

Selling threshold is calculated dynamically each run:

```
effective_sell_min = max(14c, today_avg_buy_price + 5c)
```

`today_avg_buy_price` = `SUM(meter_buy_delta × buy_price) / SUM(meter_buy_delta)` for today.

**Edge case protection:**
- Today's grid purchases < 1 kWh → fall back to 14c floor
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

### energy_log — per-interval records

Written at:
- **Scheduled**: every :00 and :30 of each hour
- **On mode change**: immediately when the inverter mode switches

Key fields:

| Field | Description |
|---|---|
| `ts` | Timestamp (UTC ISO) |
| `soc` | Battery state of charge (%) |
| `batt_power` | Battery power (kW, + = charging, − = discharging) |
| `home_load` | Home consumption (kW) |
| `pv_power` | Solar generation (kW) |
| `grid_power` | Grid power (kW, − = import, + = export) |
| `buy_price` | Amber buy price (c/kWh) |
| `feedin_price` | Amber feed-in price (c/kWh) |
| `spot_price` | NEM spot price (c/kWh) |
| `demand_window` | 1 if demand window active |
| `mode` | Inverter mode after this interval (0=Self-use, 1=Timed, 3=Backup, 6=Selling) |
| `mode_from` | Mode before switch (null if no switch this interval) |
| `mode_to` | Mode after switch (null if no switch) |
| `mode_reason` | Human-readable reason for the mode decision |
| `mode_changed` | 1 if mode switched this interval |
| `mode_verify_ok` | 1 = switch confirmed, 0 = failed, null = no switch |
| `reported_mode` | Raw mode value reported by inverter at verify time |
| `charge_kw` | Charge power set (kW) when in charging mode, null otherwise |
| `discharge_kw` | Discharge power set (kW) when in selling mode, null otherwise |
| `meter_buy_delta` | Actual kWh imported since last record (from meter cumulative total) |
| `record_trigger` | `scheduled` or `mode_change` |
| `amber_descriptor` | Amber price descriptor (extremelyLow / veryLow / low / neutral / high / spike) |

### daily_summary — per-day aggregates

| Field | Description |
|---|---|
| `date` | Date (YYYY-MM-DD) |
| `home_kwh` | Total home consumption |
| `grid_buy_kwh` | Total grid import |
| `grid_sell_kwh` | Total grid export |
| `pv_kwh` | Total solar generation |
| `charge_grid_kwh` | kWh charged from grid (Timed charge mode) |
| `discharge_kwh` | kWh discharged to grid (Timed sell mode) |
| `cost_aud` | Total electricity cost ($) |
| `earnings_aud` | Total feed-in earnings ($) |
| `demand_peak_kw` | Peak grid import during demand windows |
| `demand_charge_est` | Estimated demand charge ($) |
| `avg_soc` | Average SOC for the day |
| `min_soc` / `max_soc` | SOC range |
| `mode_changes` | Total mode switches |
| `sell_sessions` | Number of times entered Selling mode |
| `charge_sessions` | Number of times entered Charging mode |

---

## Cron Schedule

```
1,6,11,16,21,26,31,36,41,46,51,56 * * * *   demand-mode-manager.js   Main dispatch (every 5 min, 1-min offset)
```

Selling safety monitor (`selling-monitor.js`) is created/deleted dynamically when entering/leaving Selling mode.

---

## Git Log (recent changes)

Key milestones:
- `2026-03-31` Self-use verify: explicit reported=0 check, 5 retries, 6s wait (no Timed window expiry dependency)
- `2026-03-31` mode_from, mode_to, mode_verify_ok fields in energy_log for full audit trail
- `2026-03-31` daily_summary: added pv_kwh, charge_grid_kwh, discharge_kwh, mode_changes, sell_sessions, charge_sessions
- `2026-03-31` charge_kw, discharge_kw logged per interval
- `2026-03-31` MAIN_BREAKER_KW read from .env (default 7.7 kW)
- `2026-03-31` Grid headroom check: availableChargeKw = MAIN_BREAKER_KW - netHouseDraw < 1 kW → skip charge
- `2026-03-31` Buy/sell mutual exclusion: collapse opposing window to 0000, zero opposing power
- `2026-03-31` Dynamic charge power: calcChargeKw = min(5, MAIN_BREAKER_KW - netHouseDraw), updated every 5 min
- `2026-03-31` Cron offset to :01,:06,:11... (1-min offset)
- `fb1f129` DW allows selling but blocks all charging; pre-DW force charge only if SOC < 60%
- `c44369b` Translate all code comments to English
- `5a7019f` Sell threshold: today avg buy price + 5c, abs floor 14c
- `1b9051f` Pre-DW forced charge (Priority 2.5) + extremelyLow relaxed ceiling (Priority 4b)
- `9eb04f8` Cheap charge exit SOC unified to 90%
- `7e37901` Pre-switch threshold 5 min → 10 min
