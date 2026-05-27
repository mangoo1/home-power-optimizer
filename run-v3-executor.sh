#!/bin/bash
# flock prevents multiple executor instances from running simultaneously
exec 200>/tmp/plan-executor-v3.lock
flock -n 200 || { echo "[$(date)] Another executor already running, skipping" >> /home/deven/.openclaw/workspace/home-power-optimizer/data/executor-v3.log; exit 0; }

export PATH="/home/deven/.npm-global/bin:/home/deven/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
set -a
source /home/deven/.openclaw/workspace/home-power-optimizer/.env
set +a
cd /home/deven/.openclaw/workspace/home-power-optimizer
/usr/bin/node v2/plan-executor-v3.js >> data/executor-v3.log 2>&1
