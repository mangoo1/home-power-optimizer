#!/bin/bash
export PATH="/home/deven/.npm-global/bin:/home/deven/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
set -a
source /home/deven/.openclaw/workspace/home-power-optimizer/.env
set +a
cd /home/deven/.openclaw/workspace/home-power-optimizer
echo "[$(date '+%Y-%m-%d %H:%M:%S')] === plan-today-v3 cron start ===" >> data/plan-today-v3.log
/usr/bin/node v2/plan-today-v3.js >> data/plan-today-v3.log 2>&1
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FAILED exit=$EXIT_CODE" >> data/plan-today-v3.log
fi
