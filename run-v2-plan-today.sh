#!/bin/bash
set -a
source /home/deven/.openclaw/workspace/home-power-optimizer/.env
set +a
cd /home/deven/.openclaw/workspace/home-power-optimizer
/usr/bin/node v2/plan-today.js >> data/plan-today-v2.log 2>&1
