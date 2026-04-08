#!/bin/bash
# run-turso-sync.sh — wrapper for cron
# Loads .env and runs turso-sync.js

set -a
source /home/deven/.openclaw/workspace/home-power-optimizer/.env
set +a

cd /home/deven/.openclaw/workspace/home-power-optimizer

/usr/bin/node scripts/turso-sync.js >> /home/deven/.openclaw/workspace/home-power-optimizer/data/turso-sync.log 2>&1
