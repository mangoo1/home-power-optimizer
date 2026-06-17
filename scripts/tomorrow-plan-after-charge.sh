#!/bin/bash
# 06:01 跑 plan-today 生成当天计划
set -a
source /home/deven/.openclaw/workspace/home-power-optimizer/.env
set +a
cd /home/deven/.openclaw/workspace/home-power-optimizer

echo "[$(date)] Running plan-today-v3 after early charge"
node v2/plan-today-v3.js >> data/executor-v3.log 2>&1
echo "[$(date)] plan-today done"
