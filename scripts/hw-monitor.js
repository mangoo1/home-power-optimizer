/**
 * hw-monitor.js — 监控热水器功率，每5分钟记录到 hw_log 表
 * 通过 phase_a base64 解码实时功率（W）、电压（V）、电流（A）
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'energy.db');
const DEVICES = [
  { id: 'bf3c28e8181e5e980eoobm', name: 'GF Hot Water' },
  { id: 'bf160bbe78f4f1ce6dpkdp', name: 'Main Hot Water' },
];

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS hw_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT,
    online INTEGER,
    switch_on INTEGER,
    voltage_v REAL,
    current_a REAL,
    power_w REAL,
    total_kwh REAL
  )
`);

// 解码 Tuya phase_a: voltage(2B)/10V, current(3B)/1000A, power(3B)/10W
function decodePhase(b64) {
  try {
    const b = Buffer.from(b64, 'base64');
    return {
      voltage: b.readUInt16BE(0) / 10,
      current: (b[2] * 65536 + b[3] * 256 + b[4]) / 1000,
      power:   (b[5] * 65536 + b[6] * 256 + b[7]) / 10,
    };
  } catch { return { voltage: 0, current: 0, power: 0 }; }
}

function getStatus(deviceId) {
  try {
    const out = execSync(
      `npx mcporter call tuya tuya_get_device_status ${deviceId}`,
      { cwd: '/home/deven/.openclaw/workspace', timeout: 15000 }
    ).toString();
    const r = JSON.parse(out);
    if (!r.success) return null;
    const phase = decodePhase(r.data?.phase_a || '');
    return {
      online:     1,
      switch_on:  r.data?.switch ? 1 : 0,
      voltage_v:  phase.voltage,
      current_a:  phase.current,
      power_w:    phase.power,
      total_kwh:  (r.data?.total_forward_energy || 0) / 100,
    };
  } catch { return null; }
}

const now = new Date().toISOString();

for (const dev of DEVICES) {
  const s = getStatus(dev.id);
  if (!s) {
    db.prepare(`INSERT INTO hw_log (ts,device_id,device_name,online,switch_on,power_w) VALUES (?,?,?,0,0,0)`)
      .run(now, dev.id, dev.name);
    console.log(`[${dev.name}] OFFLINE`);
    continue;
  }

  db.prepare(`
    INSERT INTO hw_log (ts,device_id,device_name,online,switch_on,voltage_v,current_a,power_w,total_kwh)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(now, dev.id, dev.name, s.online, s.switch_on, s.voltage_v, s.current_a, s.power_w, s.total_kwh);

  const heating = s.power_w > 100 ? `🔥 加热中 ${s.power_w}W` : `💤 待机 ${s.power_w}W`;
  console.log(`[${dev.name}] ${heating} | ${s.voltage_v}V ${s.current_a}A | 累计${s.total_kwh}kWh`);
}

db.close();
