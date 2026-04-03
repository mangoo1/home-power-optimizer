#!/usr/bin/env node
/**
 * ess-device-log.js — 查看逆变器历史操作日志
 *
 * 用途：审查/troubleshooting 逆变器的历史动作
 * 用法：
 *   node scripts/ess-device-log.js           # 最近 20 条
 *   node scripts/ess-device-log.js --size 50 # 最近 50 条
 *   node scripts/ess-device-log.js --page 2  # 第 2 页
 *   node scripts/ess-device-log.js --raw     # 输出原始 JSON
 *
 * 环境变量（同 demand-mode-manager.js）：
 *   ESS_TOKEN   — Bearer token
 *   ESS_MAC_HEX — 设备 MAC 地址（如 00534E0045FF）
 */

const ESS_TOKEN  = process.env.ESS_TOKEN;
const MAC_HEX    = process.env.ESS_MAC_HEX;
const BASE_URL   = 'https://eu.ess-link.com/api/web/device';

const args = process.argv.slice(2);
const rawMode  = args.includes('--raw');
const sizeArg  = args.indexOf('--size');
const pageArg  = args.indexOf('--page');
const size = sizeArg >= 0 ? parseInt(args[sizeArg + 1]) : 20;
const page = pageArg >= 0 ? parseInt(args[pageArg + 1]) : 1;

if (!ESS_TOKEN || !MAC_HEX) {
  console.error('ESS_TOKEN and ESS_MAC_HEX must be set');
  process.exit(1);
}

async function fetchLog(page, size) {
  const url = `${BASE_URL}/getDeviceLog?page=${page}&size=${size}&macHex=${MAC_HEX}`;
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

// 操作类型说明（常见的）
const OP_LABELS = {
  14:  'Working Mode',
  239: 'Discharge End Time',
  240: 'Discharge Start Time',
  241: 'Charge End Time',
  242: 'Charge Start Time',
  245: 'Set Time',
  345: 'Charge Power',
  346: 'Discharge Power',
};

function formatRecord(r) {
  const time = r.createTime;
  const name = r.typeName || OP_LABELS[r.operType] || `op=${r.operType}`;
  const pre  = r.preData  !== null ? r.preData  : '—';
  const post = r.afterData !== null ? r.afterData : '—';

  // 模式名称映射
  let postLabel = post;
  if (name.includes('Working Mode')) {
    const modes = { '0': 'Self-use', '1': 'Timed', '2': 'Backup', '3': 'Backup', '4': 'Peak-shaving' };
    postLabel = `${post} (${modes[post] || post})`;
  }

  return `${time}  ${name.padEnd(45)}  ${String(pre).padStart(6)} → ${postLabel}`;
}

async function main() {
  try {
    const data = await fetchLog(page, size);
    const records = data.records || [];

    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`=== ESS Device Log (page ${page}, ${records.length} records) ===`);
    console.log(`Device: ${MAC_HEX}\n`);

    if (records.length === 0) {
      console.log('No records found.');
      return;
    }

    console.log('Time                 Operation                                      Before → After');
    console.log('─'.repeat(100));
    for (const r of records) {
      console.log(formatRecord(r));
    }

    console.log(`\nTotal: ${data.total || '?'} records | Page ${page} of ${Math.ceil((data.total||0)/size)}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
