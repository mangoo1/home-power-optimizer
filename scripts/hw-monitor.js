/**
 * hw-monitor.js — 监控热水器开关状态，记录到 hw_log 表
 * cron: 每5分钟跑一次，记录 GF / Main Hot Water 的 switch 状态变化
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

// 确保表存在
db.exec(`
  CREATE TABLE IF NOT EXISTS hw_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT,
    online INTEGER,
    switch_on INTEGER,
    duration_min REAL  -- 本次开启持续时间（关闭时计算）
  )
`);

function getStatus(deviceId) {
  try {
    const out = execSync(
      `npx mcporter call tuya tuya_get_device_status ${deviceId}`,
      { cwd: '/home/deven/.openclaw/workspace', timeout: 15000 }
    ).toString();
    const r = JSON.parse(out);
    return {
      online: r.success,
      switch_on: r.data?.switch === true ? 1 : 0,
    };
  } catch {
    return { online: 0, switch_on: 0 };
  }
}

const now = new Date().toISOString();

for (const dev of DEVICES) {
  const status = getStatus(dev.id);

  // 查上一条记录
  const prev = db.prepare(
    'SELECT * FROM hw_log WHERE device_id=? ORDER BY id DESC LIMIT 1'
  ).get(dev.id);

  // 状态有变化（或第一次记录）才写入
  const changed = !prev || prev.switch_on !== status.switch_on || prev.online !== status.online;

  // 计算持续时间：如果从 on→off，算这次开了多久
  let duration_min = null;
  if (prev && prev.switch_on === 1 && status.switch_on === 0) {
    const prevTs = new Date(prev.ts);
    const nowTs = new Date(now);
    duration_min = parseFloat(((nowTs - prevTs) / 60000).toFixed(1));
  }

  if (changed) {
    db.prepare(`
      INSERT INTO hw_log (ts, device_id, device_name, online, switch_on, duration_min)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(now, dev.id, dev.name, status.online ? 1 : 0, status.switch_on, duration_min);

    const stateStr = !status.online ? 'OFFLINE' : status.switch_on ? '🔴 ON' : '⚫ OFF';
    const durStr = duration_min != null ? ` (运行了 ${duration_min} 分钟)` : '';
    console.log(`[${dev.name}] ${stateStr}${durStr}`);
  } else {
    console.log(`[${dev.name}] 无变化 (${status.switch_on ? 'ON' : 'OFF'})`);
  }
}

db.close();
