#!/usr/bin/env node
/**
 * ess-grid.js — 电网瞬时读数
 *
 * 用途：查看电网实时状态（功率、电压、频率、今日买卖电量）
 * 用法：
 *   node scripts/ess-grid.js        # 格式化输出
 *   node scripts/ess-grid.js --raw  # 原始 JSON
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

async function fetchGrid() {
  const url = `${BASE_URL}/getPowerGridMoreInfo?macHex=${MAC_HEX}`;
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

// 显示顺序
const ORDER = [
  'Grid Total power',
  'Grid active power',
  'Grid voltage',
  'Grid voltage frequency',
  'Grid current Effective value',
  'Grid apparent power',
  'Grid reactive power',
  'Purchased Energy Today',
  'Feed in energy Today',
  'Purchased Energy',
  'Feed quantity',
  'DRED Status',
];

async function main() {
  try {
    const data = await fetchGrid();

    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const ts = data.find(d => d.essServerTime)?.essServerTime || '?';
    console.log(`=== ESS Power Grid Status (${MAC_HEX}) ===`);
    console.log(`Updated: ${ts} UTC\n`);

    const byLabel = {};
    for (const item of data) byLabel[item.label?.trim()] = item;

    // 按顺序输出
    for (const label of ORDER) {
      const item = byLabel[label];
      if (!item) continue;
      const val  = item.valueStr ?? String(item.value ?? '—');
      const unit = item.unit && item.unit !== 'None' ? item.unit : '';
      // 在实时功率区和累计区之间加分隔
      if (label === 'Purchased Energy Today') console.log('');
      if (label === 'Purchased Energy') console.log('');
      console.log(`  ${label.padEnd(35)} ${val} ${unit}`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
