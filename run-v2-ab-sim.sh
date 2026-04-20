#!/bin/bash
cd "$(dirname "$0")"
set -a && source .env && set +a
node v2/plan-ab-sim.js >> data/plan-ab-sim.log 2>&1
