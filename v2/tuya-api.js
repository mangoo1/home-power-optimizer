/**
 * v2/tuya-api.js — 自建 Tuya Open API 客户端
 * 
 * 功能：
 *   - 开/关设备
 *   - 查询设备状态
 *   - 创建/删除定时任务（timer）
 *   - Token 自动刷新缓存
 * 
 * 替代 mcporter call tuya，更可靠，支持 timer 功能
 */
'use strict';

const crypto = require('crypto');
const https = require('https');

// ── 配置 ──────────────────────────────────────────────────────
const CLIENT_ID     = process.env.TUYA_ACCESS_ID     || 'tru75gfuhh75sw4dddtn';
const CLIENT_SECRET = process.env.TUYA_ACCESS_KEY    || '28f57bec04d74648bbae0552f9a39d9b';
const API_HOST      = (process.env.TUYA_API_ENDPOINT || 'https://openapi.tuyaeu.com').replace('https://', '');
const REQUEST_TIMEOUT = 20000; // 20s

// ── Token 缓存 ────────────────────────────────────────────────
let tokenCache = { access_token: null, expire_at: 0 };

// ── HTTP 工具 ──────────────────────────────────────────────────
function makeSign(method, path, body, token, t) {
  const contentHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const stringToSign = [method, contentHash, '', path].join('\n');
  const signStr = CLIENT_ID + (token || '') + t + stringToSign;
  return crypto.createHmac('sha256', CLIENT_SECRET).update(signStr).digest('hex').toUpperCase();
}

function httpRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const t = Date.now().toString();
    const sign = makeSign(method, path, body, token, t);
    const headers = {
      'client_id': CLIENT_ID,
      'sign': sign,
      't': t,
      'sign_method': 'HMAC-SHA256',
    };
    if (token) headers['access_token'] = token;
    if (body) headers['Content-Type'] = 'application/json';

    const opts = { hostname: API_HOST, path, method, headers, timeout: REQUEST_TIMEOUT };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Token 管理 ────────────────────────────────────────────────
async function getToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expire_at - 60000) {
    return tokenCache.access_token;
  }
  const res = await httpRequest('GET', '/v1.0/token?grant_type=1');
  if (!res.success) throw new Error(`Token failed: ${res.msg} (code=${res.code})`);
  tokenCache = {
    access_token: res.result.access_token,
    expire_at: Date.now() + res.result.expire_time * 1000,
  };
  return tokenCache.access_token;
}

async function api(method, path, body) {
  const token = await getToken();
  const res = await httpRequest(method, path, body ? JSON.stringify(body) : null, token);
  return res;
}

// ── 设备控制 ──────────────────────────────────────────────────

/**
 * 开/关设备
 * @param {string} deviceId
 * @param {boolean} on
 * @param {string} switchCode - 默认 'switch'
 */
async function switchDevice(deviceId, on, switchCode = 'switch') {
  const commands = [{ code: switchCode, value: on }];
  const res = await api('POST', `/v1.0/devices/${deviceId}/commands`, { commands });
  if (!res.success) throw new Error(`Switch failed: ${res.msg} (code=${res.code})`);
  return true;
}

/**
 * 获取设备状态
 * @param {string} deviceId
 * @returns {Object} status map {code: value}
 */
async function getDeviceStatus(deviceId) {
  const res = await api('GET', `/v1.0/devices/${deviceId}/status`);
  if (!res.success) throw new Error(`Status failed: ${res.msg} (code=${res.code})`);
  const map = {};
  for (const s of (res.result || [])) map[s.code] = s.value;
  return map;
}

/**
 * 获取设备支持的功能列表
 */
async function getDeviceFunctions(deviceId) {
  const res = await api('GET', `/v1.0/devices/${deviceId}/functions`);
  if (!res.success) throw new Error(`Functions failed: ${res.msg}`);
  return res.result?.functions || [];
}

// ── 定时任务 (Timer) ──────────────────────────────────────────

/**
 * 创建定时任务
 * @param {string} deviceId
 * @param {Object} opts
 * @param {string} opts.time - 触发时间 "HH:MM" (24h, device timezone)
 * @param {Array} opts.commands - [{code, value}]
 * @param {string} [opts.category] - 分类名（默认 'plan-executor'）
 * @param {boolean} [opts.loops] - 重复周期，"0000000" 不重复，"1111111" 每天
 * @param {string} [opts.timezone] - 时区 ID
 */
async function createTimer(deviceId, opts) {
  const { time, commands, category = 'plan-executor', loops = '0000000', timezone = 'Australia/Sydney' } = opts;

  // Tuya timer API v2.0
  const body = {
    category,
    loops,
    time_zone: timezone,
    timers: [{
      date: '', // empty for loops-based
      time,
      status: 1, // enabled
      value: JSON.stringify(commands.map(c => ({ code: c.code, value: c.value }))),
    }],
  };

  const res = await api('POST', `/v2.0/devices/${deviceId}/timers`, body);
  if (!res.success) throw new Error(`Create timer failed: ${res.msg} (code=${res.code})`);
  console.log(`[tuya-timer] Created timer for ${deviceId} at ${time}: ${JSON.stringify(commands)}`);
  return res.result;
}

/**
 * 查询设备所有定时任务
 */
async function getTimers(deviceId) {
  const res = await api('GET', `/v2.0/devices/${deviceId}/timers`);
  if (!res.success) throw new Error(`Get timers failed: ${res.msg} (code=${res.code})`);
  return res.result || [];
}

/**
 * 删除定时任务分组
 * @param {string} deviceId
 * @param {string} groupId - timer group ID
 */
async function deleteTimer(deviceId, groupId) {
  const res = await api('DELETE', `/v2.0/devices/${deviceId}/timers/${groupId}`);
  if (!res.success) throw new Error(`Delete timer failed: ${res.msg} (code=${res.code})`);
  console.log(`[tuya-timer] Deleted timer group ${groupId} for ${deviceId}`);
  return true;
}

/**
 * 删除该设备所有由 plan-executor 创建的定时任务
 */
async function clearTimers(deviceId, category = 'plan-executor') {
  const groups = await getTimers(deviceId);
  let cleared = 0;
  for (const g of groups) {
    if (g.category === category || category === '*') {
      await deleteTimer(deviceId, g.group_id);
      cleared++;
    }
  }
  if (cleared > 0) console.log(`[tuya-timer] Cleared ${cleared} timer group(s) for ${deviceId}`);
  return cleared;
}

// ── 便捷方法：开机 + 设定时关机 ──────────────────────────────

/**
 * 开热水器并设定自动关机时间
 * @param {string} deviceId
 * @param {number} durationMin - 运行时长（分钟）
 * @param {string} switchCode
 * @returns {boolean} success
 */
async function turnOnWithAutoOff(deviceId, durationMin, switchCode = 'switch') {
  // 1. 先清除旧的 plan-executor timer
  try { await clearTimers(deviceId); } catch (e) {
    console.warn(`[tuya-timer] Clear old timers failed: ${e.message}`);
  }

  // 2. 开机
  await switchDevice(deviceId, true, switchCode);

  // 3. 计算关机时间
  const now = new Date();
  const offTime = new Date(now.getTime() + durationMin * 60000);
  const offHH = String(offTime.getHours()).padStart(2, '0');
  const offMM = String(offTime.getMinutes()).padStart(2, '0');
  const timeStr = `${offHH}:${offMM}`;

  // 4. 创建定时关机
  await createTimer(deviceId, {
    time: timeStr,
    commands: [{ code: switchCode, value: false }],
    loops: '0000000', // 一次性
  });

  console.log(`[tuya] ${deviceId} ON + auto-OFF at ${timeStr} (${durationMin}min)`);
  return true;
}

// ── 导出 ──────────────────────────────────────────────────────
module.exports = {
  getToken,
  api,
  switchDevice,
  getDeviceStatus,
  getDeviceFunctions,
  createTimer,
  getTimers,
  deleteTimer,
  clearTimers,
  turnOnWithAutoOff,
};
