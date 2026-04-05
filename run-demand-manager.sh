#!/bin/bash
# run-demand-manager.sh — wrapper for cron
# Loads .env and runs demand-mode-manager.js

set -a
source /home/deven/.openclaw/workspace/home-power-optimizer/.env
set +a

cd /home/deven/.openclaw/workspace/home-power-optimizer

/usr/bin/node scripts/demand-mode-manager.js >> /home/deven/.openclaw/workspace/home-power-optimizer/data/demand-manager.log 2>&1
