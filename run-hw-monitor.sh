#!/bin/bash
set -a
source /home/deven/.openclaw/workspace/home-power-optimizer/.env
set +a
cd /home/deven/.openclaw/workspace/home-power-optimizer
/usr/bin/node scripts/hw-monitor.js >> data/hw-monitor.log 2>&1
