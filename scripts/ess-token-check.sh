#!/bin/bash
# ESS Link Token Health Check
# 检测 ESS_TOKEN 是否仍然有效，失效时通过 OpenClaw 通知用户

source /home/deven/.openclaw/workspace/secrets/amber-api.env

RESPONSE=$(curl -s -o /tmp/ess-check.json -w "%{http_code}" \
  -X GET "https://eu.ess-link.com/api/app/deviceInfo/getBatteryInfo?macHex=00534E0045FF&indexes=0x1212" \
  -H "Authorization: $ESS_TOKEN")

HTTP_CODE=$RESPONSE
API_CODE=$(python3 -c "import json; d=json.load(open('/tmp/ess-check.json')); print(d.get('code','?'))" 2>/dev/null)

if [ "$HTTP_CODE" != "200" ] || [ "$API_CODE" != "200" ]; then
  echo "TOKEN_EXPIRED: HTTP=$HTTP_CODE API_CODE=$API_CODE"
  exit 2
else
  echo "TOKEN_OK: HTTP=$HTTP_CODE API_CODE=$API_CODE"
  exit 0
fi
