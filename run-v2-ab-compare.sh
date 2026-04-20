#!/bin/bash
cd "$(dirname "$0")"
set -a && source .env && set +a
node v2/plan-ab-compare.js >> data/plan-ab-compare.log 2>&1
