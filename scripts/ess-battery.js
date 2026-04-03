#!/usr/bin/env node
/**
 * ess-battery.js — 逆变器电池瞬时读数
 *
 * 用途：查看电池实时状态（SOC、SoH、温度、充放电功率等）
 * 用法：
 *   node scripts/ess-battery.js        # 格式化输出
 *   node scripts/ess-battery.js --raw  # 原始 JSON
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

async function fetchBattery() {
  const url = `${BASE_URL}/getBatteryMoreInfo?macHex=${MAC_HEX}`;
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

// 关键字段显示顺序
const KEY_FIELDS = [
  'Batt1 Operating Status',
  'Battery 1 SoC',
  'BattCab 1 SoC',
  'BattCab 1 SoH',
  'Total battery power',
  'Batt1 Power',
  'Batt1 voltage',
  'BattCab 1 Total Voltage',
  'Batt1 current',
  'BattCab 1 Total Current',
  'BattCab 1 Temperature',
  'Batt1 full load support time',
  'Batt1 Load Rate',
  'Total number of installed batteries',
  'BattCab 1 Charge Current Limit',
  'BattCab 1 Discharge Current Limit',
  'BattCab 1 Charge Voltage Limit',
  'BattCab 1 Discharge Voltage Limit',
  'BMS1 protocol',
  'BattCab 1 Basic Status  ',
  'BattCab 1 BMS Operating Status',
];

async function main() {
  try {
    const data = await fetchBattery();

    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const ts = data.find(d => d.essServerTime)?.essServerTime || '?';
    console.log(`=== ESS Battery Status (${MAC_HEX}) ===`);
    console.log(`Updated: ${ts} UTC\n`);

    // 按关键字段顺序输出
    const byLabel = {};
    for (const item of data) byLabel[item.label?.trim()] = item;

    console.log('  --- Key Status ---');
    for (const label of KEY_FIELDS) {
      const item = byLabel[label] || byLabel[label?.trim()];
      if (!item) continue;
      const val  = item.valueStr ?? String(item.value ?? '—');
      const unit = item.unit || '';
      if (!val || val === '0' && label.includes('Firmware')) continue;
      const dispLabel = label.trim().replace('BattCab 1 ', 'Cab1 ').replace('Batt1 ', 'Batt1 ');
      console.log(`  ${dispLabel.padEnd(35)} ${val} ${unit}`);
    }

    // 还有有值的单格电压/温度
    const cells = data.filter(d => d.label?.includes('Cell') && d.value && d.value !== 0);
    if (cells.length) {
      console.log('\n  --- Cell Data ---');
      for (const c of cells) {
        console.log(`  ${c.label.trim().padEnd(35)} ${c.valueStr} ${c.unit || ''}`);
      }
    }

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
