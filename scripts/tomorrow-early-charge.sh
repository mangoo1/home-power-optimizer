#!/bin/bash
# 明天 04:00-06:00 充电，06:00 结束后跑 plan-today
# 一次性任务，用 at 或 cron 触发

set -a
source /home/deven/.openclaw/workspace/home-power-optimizer/.env
set +a
cd /home/deven/.openclaw/workspace/home-power-optimizer

echo "[$(date)] Starting early charge 04:00-06:00"

# 设置 Timed 模式充电
node -e "
const api = require('./v2/ess-api.js');
api.restoreTimedMode({
  startHHMM: 400,
  endHHMM: 600,
  chargeKw: 5,
  sellStartHHMM: 0,
  sellEndHHMM: 0,
  sellKw: 0
}, 'early-charge-0400-0600', 'scheduled').then(() => console.log('OK: Timed charge 04:00-06:00 set'));
"

# 写 manual_override_until 防止 executor 覆盖
node -e "
const Database = require('better-sqlite3');
const db = new Database('./data/energy.db');
// 如果明天计划已存在，设 override；否则 executor 无计划时默认 self-use 不会干扰 Timed
const row = db.prepare(\"SELECT id FROM daily_plan WHERE date='2026-06-12' AND is_active=1\").get();
if (row) {
  db.prepare(\"UPDATE daily_plan SET manual_override_until='2026-06-12T06:01:00+10:00' WHERE id=?\").run(row.id);
  console.log('manual_override_until set to 06:01');
} else {
  console.log('No plan for 2026-06-12 yet, Timed mode will hold');
}
db.close();
"

echo "[$(date)] Early charge configured, waiting until 06:01 to run plan-today"
