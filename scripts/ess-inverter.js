#!/usr/bin/env node
/**
 * ess-inverter.js — 逆变器瞬时读数
 *
 * 用途：查看逆变器实时工作状态（电压、电流、功率、频率等）
 * 用法：
 *   node scripts/ess-inverter.js        # 格式化输出
 *   node scripts/ess-inverter.js --raw  # 原始 JSON
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

async function fetchInverter() {
  const url = `${BASE_URL}/getInversionMoreInfo?macHex=${MAC_HEX}`;
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

async function main() {
  try {
    const data = await fetchInverter();

    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const ts = data.find(d => d.essServerTime)?.essServerTime || '?';
    console.log(`=== ESS Inverter Status (${MAC_HEX}) ===`);
    console.log(`Updated: ${ts} UTC\n`);

    for (const item of data) {
      const label = (item.label || '').trim();
      const val   = item.valueStr ?? String(item.value ?? '—');
      const unit  = item.unit && item.unit !== 'None' ? item.unit : '';
      if (!label) continue;
      console.log(`  ${label.padEnd(40)} ${val} ${unit}`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
