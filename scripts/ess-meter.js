#!/usr/bin/env node
/**
 * ess-meter.js — 逆变器电表瞬时读数
 *
 * 用途：查看电表实时状态，用于 troubleshooting / 核对数据
 * 用法：
 *   node scripts/ess-meter.js        # 格式化输出
 *   node scripts/ess-meter.js --raw  # 原始 JSON
 *
 * 环境变量：
 *   ESS_TOKEN   — Bearer token
 *   ESS_MAC_HEX — 设备 MAC 地址（如 00534E0045FF）
 */

const ESS_TOKEN = process.env.ESS_TOKEN;
const MAC_HEX   = process.env.ESS_MAC_HEX;
const BASE_URL  = 'https://eu.ess-link.com/api/web/deviceInfo';

const rawMode = process.argv.includes('--raw');

if (!ESS_TOKEN || !MAC_HEX) {
  console.error('ESS_TOKEN and ESS_MAC_HEX must be set');
  process.exit(1);
}

async function fetchMeter() {
  const url = `${BASE_URL}/getElectricityMeterMoreInfo?macHex=${MAC_HEX}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${ESS_TOKEN}`,
      'lang': 'en',
      'Accept': 'application/json',
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 200) throw new Error(`API error: ${json.msg}`);
  return json.data;
}

// 重点字段 label → 显示名
const KEY_FIELDS = {
  'Meter Operating Status':           'Status',
  'Meter Voltage':                    'Voltage',
  'Meter current':                    'Current',
  'Meter Active power':               'Active Power',
  'Meter apparent power':             'Apparent Power',
  'Power factor of electric meter':   'Power Factor',
  'Three-phase total active power':   'Total Active Power',
  'Positive active energy':           'Grid Import (cumulative)',
  'Reverse active energy':            'Grid Export (cumulative)',
  'Reactive power of electric meter': 'Reactive Power',
  'Meter Model':                      'Meter Model',
  'Meter Firmware Version':           'Firmware',
};

async function main() {
  try {
    const data = await fetchMeter();

    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    // 取最后更新时间
    const ts = data[0]?.essServerTime || '?';
    console.log(`=== ESS Electricity Meter (${MAC_HEX}) ===`);
    console.log(`Updated: ${ts} UTC\n`);

    // 优先展示关键字段
    const priority = [];
    const rest = [];
    for (const item of data) {
      const dispName = KEY_FIELDS[item.label];
      const val  = item.valueStr || String(item.value ?? '—');
      const unit = item.unit || '';
      const line = `  ${(dispName || item.label).padEnd(30)} ${val} ${unit}`;
      if (dispName) priority.push({ order: Object.keys(KEY_FIELDS).indexOf(item.label), line });
      else rest.push(line);
    }

    priority.sort((a, b) => a.order - b.order);
    for (const { line } of priority) console.log(line);
    if (rest.length) {
      console.log('\n  --- Other ---');
      for (const line of rest) console.log(line);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
