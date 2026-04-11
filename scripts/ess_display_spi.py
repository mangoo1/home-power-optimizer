#!/usr/bin/env python3
"""ESS Display via direct SPI + gpiod v2 - bypasses DRM entirely"""

import spidev, gpiod
from gpiod.line import Direction, Value, Edge, Bias
import sqlite3, time, struct, sys
from datetime import datetime, timezone, timedelta
import zoneinfo
from PIL import Image, ImageDraw, ImageFont

SPI_BUS, SPI_DEV = 0, 0
DC_PIN    = 25
RESET_PIN = 27
GPIO_CHIP = "/dev/gpiochip4"  # display pins
KEY_CHIP  = "/dev/gpiochip0"  # button pins
BL_PIN    = 24  # backlight
KEY1_PIN  = 21  # page switch
KEY2_PIN  = 20  # manual refresh
KEY3_PIN  = 16  # backlight toggle
W, H = 128, 128   # physical dims after rotation

DB_PATH     = "/home/pi/ess-data/energy.db"
REFRESH_SEC = 30

# ST7735R commands
ST7735_SWRESET = 0x01
ST7735_SLPOUT  = 0x11
ST7735_COLMOD  = 0x3A
ST7735_MADCTL  = 0x36
ST7735_CASET   = 0x2A
ST7735_RASET   = 0x2B
ST7735_RAMWR   = 0x2C
ST7735_DISPON  = 0x29
ST7735_FRMCTR1 = 0xB1
ST7735_PWCTR1  = 0xC0
ST7735_PWCTR2  = 0xC1
ST7735_VMCTR1  = 0xC5
ST7735_GMCTRP1 = 0xE0
ST7735_GMCTRN1 = 0xE1

BLACK  = (0,   0,   0)
WHITE  = (255, 255, 255)
GREEN  = (0,   220, 80)
ORANGE = (255, 160, 0)
RED    = (255, 60,  60)
BLUE   = (80,  160, 255)
YELLOW = (255, 230, 0)
GRAY   = (120, 120, 120)
DGRAY  = (40,  40,  40)
NAVY   = (20,  20,  60)
MODE_NAMES = {0:"Self-use", 1:"Charging", 2:"Selling", 3:"Backup"}

spi = spidev.SpiDev()
gpio_req = None

def dc_low():  gpio_req.set_value(DC_PIN,    Value.INACTIVE)
def dc_high(): gpio_req.set_value(DC_PIN,    Value.ACTIVE)
def rst_low(): gpio_req.set_value(RESET_PIN, Value.INACTIVE)
def rst_high():gpio_req.set_value(RESET_PIN, Value.ACTIVE)

def cmd(c):
    dc_low()
    spi.xfer2([c])

def data(d):
    dc_high()
    if isinstance(d, int): d = [d]
    for i in range(0, len(d), 4096):
        spi.xfer2(list(d[i:i+4096]))

def init_display():
    rst_low();  time.sleep(0.1)
    rst_high(); time.sleep(0.1)

    cmd(ST7735_SWRESET); time.sleep(0.15)
    cmd(ST7735_SLPOUT);  time.sleep(0.5)

    cmd(ST7735_FRMCTR1); data([0x01,0x2C,0x2D])
    cmd(0xB2); data([0x01,0x2C,0x2D])
    cmd(0xB3); data([0x01,0x2C,0x2D,0x01,0x2C,0x2D])
    cmd(0xB4); data([0x07])
    cmd(ST7735_PWCTR1); data([0xA2,0x02,0x84])
    cmd(ST7735_PWCTR2); data([0xC5])
    cmd(0xC2); data([0x0A,0x00])
    cmd(0xC3); data([0x8A,0x2A])
    cmd(0xC4); data([0x8A,0xEE])
    cmd(ST7735_VMCTR1); data([0x0E])
    cmd(0x20)  # INVOFF

    # MADCTL: MX+MV = 90deg rotation, BGR order
    cmd(ST7735_MADCTL); data([0x60])
    cmd(ST7735_COLMOD); data([0x05])  # RGB565

    cmd(ST7735_GMCTRP1)
    data([0x02,0x1c,0x07,0x12,0x37,0x32,0x29,0x2d,
          0x29,0x25,0x2B,0x39,0x00,0x01,0x03,0x10])
    cmd(ST7735_GMCTRN1)
    data([0x03,0x1d,0x07,0x06,0x2E,0x2C,0x29,0x2D,
          0x2E,0x2E,0x37,0x3F,0x00,0x00,0x02,0x10])

    cmd(ST7735_DISPON); time.sleep(0.1)
    print("Display initialized", flush=True)

def show_image(img):
    cmd(ST7735_CASET); data([0,2,0,W+1])
    cmd(ST7735_RASET); data([0,1,0,H])
    cmd(ST7735_RAMWR)
    pixels = list(img.getdata())
    buf = bytearray(W*H*2)
    for i,(r,g,b) in enumerate(pixels):
        v = ((r&0xF8)<<8)|((g&0xFC)<<3)|(b>>3)
        buf[i*2]   = (v>>8)&0xFF
        buf[i*2+1] = v&0xFF
    dc_high()
    for i in range(0, len(buf), 4096):
        spi.xfer2(list(buf[i:i+4096]))

def get_latest():
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM energy_log ORDER BY rowid DESC LIMIT 1").fetchone()
        conn.close()
        return dict(row) if row else None
    except: return None

def soc_color(v): return GREEN if v>=70 else (ORANGE if v>=30 else RED)
def mode_color(m): return {1:GREEN,2:YELLOW,0:BLUE}.get(m,GRAY)
def price_color(p): return GREEN if p<8 else (ORANGE if p<15 else RED)

def draw_bar(d,x,y,w,h,pct,color):
    d.rectangle([x,y,x+w,y+h],fill=DGRAY)
    fw=int(w*min(max(pct,0),100)/100)
    if fw>0: d.rectangle([x,y,x+fw,y+h],fill=color)

def make_frame(data, page=0):
    img = Image.new("RGB",(W,H),BLACK)
    d = ImageDraw.Draw(img)
    try:
        fn_lg=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",14)
        fn_md=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",11)
        fn_sm=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",9)
    except: fn_lg=fn_md=fn_sm=ImageFont.load_default()

    if not data:
        d.text((10,70),"No data",font=fn_lg,fill=RED); return img

    # Page 1: price detail
    if page == 1:
        d.rectangle([0,0,W,H],fill=NAVY)
        d.rectangle([0,0,W,16],fill=(20,40,80))
        d.text((2,2),"Price Detail",font=fn_sm,fill=WHITE)
        buy=data.get("buy_price",0)or 0
        feedin=abs(data.get("feed_in_price",0)or 0)
        dw=data.get("demand_window",0)or 0
        d.text((2,22),f"Buy:  {buy:.1f}c/kWh",font=fn_md,fill=price_color(buy))
        d.text((2,38),f"Sell: {feedin:.1f}c/kWh",font=fn_md,fill=YELLOW)
        d.text((2,54),f"DW: {'YES' if dw else 'NO'}",font=fn_md,fill=(RED if dw else GREEN))
        d.text((2,110),"KEY1=next KEY3=light",font=fn_sm,fill=GRAY)
        return img

    # Page 2: today stats
    if page == 2:
        d.rectangle([0,0,W,H],fill=NAVY)
        d.rectangle([0,0,W,16],fill=(20,40,80))
        d.text((2,2),"Today Stats",font=fn_sm,fill=WHITE)
        load=data.get("home_load",0)or 0
        pv=data.get("pv_power",0)or 0
        grid=data.get("grid_power",0)or 0
        d.text((2,22),f"Load:  {load:.2f} kW",font=fn_md,fill=WHITE)
        d.text((2,38),f"Solar: {pv:.2f} kW",font=fn_md,fill=YELLOW)
        d.text((2,54),f"Grid:  {grid:.2f} kW",font=fn_md,fill=(GREEN if grid<0 else ORANGE))
        d.text((2,110),"KEY1=next KEY3=light",font=fn_sm,fill=GRAY)
        return img

    soc=data.get("soc",0)or 0; mode=data.get("mode",0)or 0
    buy=data.get("buy_price",0)or 0; load=data.get("home_load",0)or 0
    pv=data.get("pv_power",0)or 0; dw=data.get("demand_window",0)or 0
    ts=data.get("ts","")

    d.rectangle([0,0,W,16],fill=NAVY)
    d.text((2,2),"ESS Monitor",font=fn_sm,fill=WHITE)
    sydney=datetime.now(zoneinfo.ZoneInfo("Australia/Sydney"))
    d.text((W-30,2),sydney.strftime("%H:%M"),font=fn_sm,fill=GRAY)

    sc=soc_color(soc)
    d.text((2,20),"SOC",font=fn_sm,fill=GRAY)
    d.text((28,18),f"{soc}%",font=fn_lg,fill=sc)
    draw_bar(d,2,36,W-4,8,soc,sc)

    mc=mode_color(mode)
    d.text((2,48),"Mode:",font=fn_sm,fill=GRAY)
    d.text((38,47),MODE_NAMES.get(mode,f"M{mode}"),font=fn_md,fill=mc)
    if dw:
        d.rectangle([W-30,47,W-2,60],fill=RED)
        d.text((W-28,48),"DW!",font=fn_sm,fill=WHITE)

    pc=price_color(buy)
    d.text((2,64),"Buy:",font=fn_sm,fill=GRAY)
    d.text((30,63),f"{buy:.1f}c",font=fn_md,fill=pc)
    pvc=GREEN if pv>0.1 else GRAY
    d.text((82,64),"PV:",font=fn_sm,fill=GRAY)
    d.text((100,65),f"{pv:.2f}kW",font=fn_sm,fill=pvc)

    d.text((2,80),"Load:",font=fn_sm,fill=GRAY)
    d.text((32,79),f"{load:.2f}kW",font=fn_md,fill=WHITE)
    d.line([0,96,W,96],fill=DGRAY,width=1)

    try:
        ts_dt=datetime.fromisoformat(ts.replace('Z','+00:00'))
        age_s=(datetime.now(timezone.utc)-ts_dt).total_seconds()
        age_str=f"Data: {int(age_s//60)}m ago"
    except: age_str="Data: ?"
    d.text((2,100),age_str,font=fn_sm,fill=GRAY)

    grid=data.get("grid_power",0)or 0
    gc=YELLOW if grid<0 else ORANGE
    d.text((2,114),f"Grid:{abs(grid):.2f}kW{'↑'if grid<0 else'↓'}",font=fn_sm,fill=gc)
    return img

def main():
    global gpio_req
    gpio_req = gpiod.request_lines(GPIO_CHIP, consumer="ess-display", config={
        DC_PIN:    gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.INACTIVE),
        RESET_PIN: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE),
        BL_PIN:    gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE),
    })
    key_req = gpiod.request_lines(KEY_CHIP, consumer="ess-keys", config={
        KEY1_PIN:  gpiod.LineSettings(direction=Direction.INPUT, edge_detection=Edge.FALLING, bias=Bias.PULL_UP),
        KEY2_PIN:  gpiod.LineSettings(direction=Direction.INPUT, edge_detection=Edge.FALLING, bias=Bias.PULL_UP),
        KEY3_PIN:  gpiod.LineSettings(direction=Direction.INPUT, edge_detection=Edge.FALLING, bias=Bias.PULL_UP),
    })

    spi.open(SPI_BUS, SPI_DEV)
    spi.max_speed_hz = 16000000
    spi.mode = 0

    init_display()

    while True:
        try:
            d = get_latest()
            show_image(make_frame(d))
            soc = d.get("soc","?") if d else "?"
            print(f"Updated SOC={soc}%", flush=True)
        except Exception as e:
            print(f"Error: {e}", flush=True)
        time.sleep(REFRESH_SEC)

if __name__=="__main__":
    try:
        main()
    finally:
        if gpio_req: gpio_req.release()
        spi.close()
