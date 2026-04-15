#!/usr/bin/env python3
"""
ESS Status Display - Sense HAT 8x8 LED Matrix
Reads energy.db and shows: SOC bar, mode, price, PV power
Refreshes every 30 seconds.

Joystick controls yabot car via HTTP:
  UP    → forward
  DOWN  → backward
  LEFT  → turn left
  RIGHT → turn right
  MIDDLE → stop
"""

import sqlite3
import time
import os
import sys
import threading
import urllib.request
import json
from sense_hat import SenseHat

DB_PATH      = os.environ.get("DB_PATH", "/home/pi/ess-data/energy.db")
YABOT_URL    = os.environ.get("YABOT_URL", "http://192.168.31.187:5000")
CAR_SPEED    = int(os.environ.get("CAR_SPEED", "20"))
REFRESH_SEC  = 30

s = SenseHat()
s.low_light = True  # easier on the eyes indoors

# Color palette
OFF    = (0, 0, 0)
RED    = (200, 0, 0)
ORANGE = (200, 80, 0)
YELLOW = (180, 150, 0)
GREEN  = (0, 180, 0)
BLUE   = (0, 80, 220)
WHITE  = (150, 150, 150)
CYAN   = (0, 150, 150)
PURPLE = (120, 0, 180)


# ── Yabot car control ────────────────────────────────────────────────────────

# Track last car action for LED feedback
_car_action = "stop"
_car_lock   = threading.Lock()

# Direction arrow pixels (8x8, shown briefly on joystick press)
_ARROW = {
    "forward": [
        0,0,0,1,1,0,0,0,
        0,0,1,1,1,1,0,0,
        0,1,1,0,0,1,1,0,
        0,0,0,1,1,0,0,0,
        0,0,0,1,1,0,0,0,
        0,0,0,1,1,0,0,0,
        0,0,0,1,1,0,0,0,
        0,0,0,0,0,0,0,0,
    ],
    "backward": [
        0,0,0,0,0,0,0,0,
        0,0,0,1,1,0,0,0,
        0,0,0,1,1,0,0,0,
        0,0,0,1,1,0,0,0,
        0,0,0,1,1,0,0,0,
        0,1,1,0,0,1,1,0,
        0,0,1,1,1,1,0,0,
        0,0,0,1,1,0,0,0,
    ],
    "left": [
        0,0,0,0,0,0,0,0,
        0,0,1,0,0,0,0,0,
        0,1,0,0,0,0,0,0,
        1,1,1,1,1,1,1,0,
        1,1,1,1,1,1,1,0,
        0,1,0,0,0,0,0,0,
        0,0,1,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
    ],
    "right": [
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,1,0,0,
        0,0,0,0,0,0,1,0,
        0,1,1,1,1,1,1,1,
        0,1,1,1,1,1,1,1,
        0,0,0,0,0,0,1,0,
        0,0,0,0,0,1,0,0,
        0,0,0,0,0,0,0,0,
    ],
    "stop": [
        0,0,0,0,0,0,0,0,
        0,1,1,1,1,1,1,0,
        0,1,0,0,0,0,1,0,
        0,1,0,1,1,0,1,0,
        0,1,0,1,1,0,1,0,
        0,1,0,0,0,0,1,0,
        0,1,1,1,1,1,1,0,
        0,0,0,0,0,0,0,0,
    ],
}

def send_car_cmd(action):
    """POST /cmd to yabot. Non-blocking, best-effort."""
    try:
        payload = json.dumps({"action": action, "speed": CAR_SPEED}).encode()
        req = urllib.request.Request(
            f"{YABOT_URL}/cmd",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=1.5)
        print(f"[CAR] → {action}")
    except Exception as e:
        print(f"[CAR] {action} failed: {e}", file=sys.stderr)


def flash_arrow(action):
    """Show direction arrow for 0.6s then restore ESS display."""
    color = {
        "forward":  GREEN,
        "backward": RED,
        "left":     CYAN,
        "right":    YELLOW,
        "stop":     WHITE,
    }.get(action, WHITE)
    mask = _ARROW.get(action, _ARROW["stop"])
    frame = [color if v else OFF for v in mask]
    s.set_pixels(frame)
    time.sleep(0.6)


def joystick_thread():
    """Background thread: listen for Sense HAT joystick events."""
    global _car_action
    joy_map = {
        "up":    "forward",
        "down":  "backward",
        "left":  "left",
        "right": "right",
        "middle":"stop",
    }
    print("[JOY] Joystick listener started")
    for event in s.stick.get_events():
        # Only act on 'pressed' (ignore held/released to avoid repeat spam)
        if event.action != "pressed":
            continue
        action = joy_map.get(event.direction)
        if not action:
            continue
        with _car_lock:
            _car_action = action
        # Send HTTP in a fire-and-forget thread so joystick stays responsive
        threading.Thread(target=send_car_cmd, args=(action,), daemon=True).start()
        threading.Thread(target=flash_arrow, args=(action,), daemon=True).start()


# ── ESS data helpers ─────────────────────────────────────────────────────────

def soc_color(soc):
    if soc >= 60:
        return GREEN
    elif soc >= 30:
        return YELLOW
    else:
        return RED


def price_color(price_c):
    """price in cents"""
    if price_c < 8:
        return GREEN
    elif price_c < 15:
        return YELLOW
    elif price_c < 25:
        return ORANGE
    else:
        return RED


def mode_color(mode_int, charge_kw=0, discharge_kw=0):
    """
    mode: 0=Self-use, 1=Timed(charge or backup), 5=PV_Priority, 6=Selling
    Use charge_kw/discharge_kw to disambiguate Timed mode.
    """
    m = int(mode_int or 0)
    if m == 6:
        return ORANGE   # Selling / feed-in
    elif m == 1:
        if (charge_kw or 0) > 0:
            return BLUE     # Charging
        elif (discharge_kw or 0) > 0:
            return PURPLE   # Backup/discharge
        else:
            return CYAN     # Timed standby
    elif m == 0:
        return GREEN    # Self-use
    elif m == 5:
        return YELLOW   # PV Priority
    else:
        return WHITE


def pv_color(pv_kw):
    ratio = min(pv_kw / 5.0, 1.0)
    r = int(180 * ratio)
    g = int(120 * ratio)
    return (r, g, 0)


def get_latest():
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""
            SELECT soc, buy_price, feedin_price, pv_power, home_load,
                   batt_power, mode, charge_kw, discharge_kw
            FROM energy_log
            ORDER BY ts DESC LIMIT 1
        """)
        row = c.fetchone()
        conn.close()
        if row:
            return {
                "soc":          row[0] or 0,
                "buy_price":    row[1] or 0,
                "feedin_price": abs(row[2] or 0),
                "pv_kw":        (row[3] or 0) / 1000.0,
                "home_kw":      (row[4] or 0) / 1000.0,
                "bat_kw":       (row[5] or 0) / 1000.0,
                "mode":         int(row[6] or 0),
                "charge_kw":    row[7] or 0,
                "discharge_kw": row[8] or 0,
            }
    except Exception as e:
        print(f"DB error: {e}", file=sys.stderr)
    return None


def build_frame(d):
    """
    Layout (8 cols x 8 rows):
    Row 0:   SOC bar — 8 pixels = 0–100%, colour by level
    Row 1:   Mode indicator — full row, colour by mode
    Row 2:   blank
    Row 3:   Buy price bar — left half (4px), FeedIn bar — right half (4px)
    Row 4:   blank
    Row 5-7: PV power bar — bottom 3 rows, filled left→right (8px = 5kW max)
             colour by pv output level
    """
    frame = [OFF] * 64  # 8x8

    soc  = max(0, min(100, d["soc"]))
    buy  = d["buy_price"]      # cents
    fin  = d["feedin_price"]   # cents (positive)
    pv   = d["pv_kw"]
    mode  = d["mode"]

    # Row 0: SOC bar
    lit = round(soc / 100 * 8)
    sc  = soc_color(soc)
    for i in range(8):
        frame[i] = sc if i < lit else OFF

    # Row 1: mode full row
    mc = mode_color(mode, d.get("charge_kw", 0), d.get("discharge_kw", 0))
    for i in range(8):
        frame[8 + i] = mc

    # Row 2: blank (already OFF)

    # Row 3: buy price (left 4 cols) + feedin (right 4 cols)
    # scale: 0¢=0px, 30¢=4px
    buy_lit = min(4, round(buy / 30 * 4))
    fin_lit = min(4, round(fin / 30 * 4))
    bc = price_color(buy)
    fc = price_color(fin) if fin > 0 else OFF
    for i in range(4):
        frame[24 + i] = bc if i < buy_lit else OFF
    for i in range(4):
        frame[28 + i] = fc if i < fin_lit else OFF

    # Row 4: blank

    # Rows 5-7: PV power bar (3 rows × 8 cols = 24 cells, each = 5/24 kW ≈ 0.208kW)
    pv_cells = min(24, round(pv / 5.0 * 24))
    pc = pv_color(pv)
    for i in range(24):
        frame[40 + i] = pc if i < pv_cells else OFF

    return frame


def show_error():
    """Flash red X on DB read failure"""
    X = [
        1,0,0,0,0,0,0,1,
        0,1,0,0,0,0,1,0,
        0,0,1,0,0,1,0,0,
        0,0,0,1,1,0,0,0,
        0,0,0,1,1,0,0,0,
        0,0,1,0,0,1,0,0,
        0,1,0,0,0,0,1,0,
        1,0,0,0,0,0,0,1,
    ]
    frame = [RED if v else OFF for v in X]
    s.set_pixels(frame)


def main():
    print("ESS Sense HAT display started")
    print(f"[CAR] Yabot URL: {YABOT_URL}  speed={CAR_SPEED}")

    # Start joystick listener in background
    joy = threading.Thread(target=joystick_thread, daemon=True)
    joy.start()

    blink = False
    tick  = 0

    while True:
        d = get_latest()
        if d is None:
            show_error()
            time.sleep(5)
            continue

        frame = build_frame(d)

        # Mode row blink for charging (blue)
        if d["mode"] == 1 and (d.get("charge_kw") or 0) > 0:
            if blink:
                # dim the mode row on odd ticks
                for i in range(8):
                    frame[8 + i] = (0, 20, 80)
            blink = not blink

        s.set_pixels(frame)

        # Print status to console for journalctl debugging
        print(
            f"SOC={d['soc']:.0f}% buy={d['buy_price']:.1f}¢ "
            f"feedin={d['feedin_price']:.1f}¢ pv={d['pv_kw']:.2f}kW "
            f"mode={d['mode']} chg={d.get('charge_kw',0)}kW dis={d.get('discharge_kw',0)}kW"
        )

        time.sleep(REFRESH_SEC)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        s.clear()
        print("Display stopped.")
