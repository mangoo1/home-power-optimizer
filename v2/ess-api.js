/**
 * ess-api.js — ESS-Link 逆变器写操作的唯一入口
 *
 * 所有写逆变器的操作必须通过这个模块，不要直接调 setDeviceParam。
 * 统一做：
 *   1. 整数/浮点格式校验（防止十六进制浮点污染）
 *   2. 写操作日志（写到 ess_param_log 表）
 *   3. 参数范围校验（防止非法值）
 */

'use strict';

const https = require('https');

const MAX_CHARGE_KW = 5;
const MAX_SELL_KW   = 5;
const BREAKER_KW    = parseFloat(process.env.BREAKER_KW      || '7.7');
const BREAKER_BUFFER = parseFloat(process.env.CHARGE_BUFFER_KW || '0.5');

// 由调用方在 main() 里初始化
let _db     = null;
let _mac    = null;
let _token  = null;

function init({ db, mac, token }) {
  _db    = db;
  _mac   = mac;
  _token = token;
  if (_db) ensureLogTable(_db);
}

function ensureLogTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ess_param_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      param_index TEXT NOT NULL,
      param_value TEXT,
      ok INTEGER,
      reason TEXT,
      caller TEXT
    )
  `);
}

function httpsPost(path, body, token) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'eu.ess-link.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'lang': 'en',
        'showloading': 'false',
        'Referer': 'https://eu.ess-link.com/appViews/appHome',
        'User-Agent': 'Mozilla/5.0',
      }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res({}); } });
    });
    req.on('error', rej);
    req.write(data);
    req.end();
  });
}

/**
 * 写单个寄存器，带格式校验和日志
 * @param {string} index  寄存器地址，如 '0xC0BA'
 * @param {number} value  写入值（整数或小数，不能是十六进制字符串）
 * @param {string} reason 写入原因，用于审查
 * @param {string} caller 调用来源，如 'plan-executor' / 'mcp'
 */
async function setParam(index, value, reason = 'unknown', caller = 'unknown') {
  // 格式校验：必须是数字，不接受十六进制浮点字符串
  if (typeof value !== 'number' || !isFinite(value)) {
    throw new Error(`ess-api.setParam: value must be a finite number, got ${JSON.stringify(value)}`);
  }

  // 时间寄存器（0xC014/0xC016/0xC018/0xC01A）必须是整数 HHMM 格式
  const timeRegs = ['0xC014', '0xC016', '0xC018', '0xC01A'];
  if (timeRegs.includes(index)) {
    const intVal = Math.round(value);
    const h = Math.floor(intVal / 100);
    const m = intVal % 100;
    if (h > 23 || m > 59) {
      throw new Error(`ess-api.setParam: invalid time value ${intVal} for ${index} (must be HHMM like 800, 1630)`);
    }
    value = intVal;
  }

  // 功率寄存器（0xC0BA/0xC0BC）限制范围 0–5kW
  const powerRegs = ['0xC0BA', '0xC0BC'];
  if (powerRegs.includes(index)) {
    value = parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, value)).toFixed(2));
  }

  const ok_result = await httpsPost(
    '/api/app/deviceInfo/setDeviceParam',
    { macHex: _mac, index, data: value },
    _token
  ).catch(() => ({}));

  const ok = ok_result.code === 200;

  // 写日志
  try {
    if (_db) {
      _db.prepare(`
        INSERT INTO ess_param_log (ts, param_index, param_value, ok, reason, caller)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(new Date().toISOString(), index, String(value), ok ? 1 : 0, reason, caller);
    }
  } catch { /* 日志失败不影响主流程 */ }

  return ok;
}

/** 切 Self-use 模式 */
async function switchToSelfUse(reason = 'unknown', caller = 'unknown') {
  return setParam('0x300C', 0, reason, caller);
}

/** 设置充电功率（不动时间窗口） */
async function setChargeKw(kw, reason = 'unknown', caller = 'unknown') {
  return setParam('0xC0BA', kw, reason, caller);
}

/** 设置放电功率 */
async function setSellKw(kw, reason = 'unknown', caller = 'unknown') {
  return setParam('0xC0BC', kw, reason, caller);
}

/** 恢复 Timed 模式，写入完整充电窗口 */
async function restoreTimedMode({ startHHMM, endHHMM, chargeKw, sellStartHHMM, sellEndHHMM, sellKw } = {}, reason = 'unknown', caller = 'unknown') {
  await setParam('0x300C', 1, reason, caller);
  if (startHHMM      != null) await setParam('0xC014', startHHMM,      reason, caller);
  if (endHHMM        != null) await setParam('0xC016', endHHMM,        reason, caller);
  if (chargeKw       != null) await setParam('0xC0BA', chargeKw,       reason, caller);
  if (sellStartHHMM  != null) await setParam('0xC018', sellStartHHMM,  reason, caller);
  if (sellEndHHMM    != null) await setParam('0xC01A', sellEndHHMM,    reason, caller);
  if (sellKw         != null) await setParam('0xC0BC', sellKw,         reason, caller);
}

/** 紧急停止：充放电功率全部清零 */
async function emergencyStop(reason = 'emergency', caller = 'unknown') {
  await setParam('0xC0BA', 0, reason, caller);
  await new Promise(r => setTimeout(r, 300));
  await setParam('0xC0BC', 0, reason, caller);
}

/** 动态计算安全充电功率（不超断路器） */
function calcSafeChargeKw(homeLoad, pvPower, gridPower) {
  // 优先用实际电网进口功率计算余量（更准确）
  // gridPower = 电表实时进口，正=买电，直接反映断路器负荷
  // 如果没有 gridPower，退而用 homeLoad - pvPower 估算
  let headroom;
  if (gridPower != null && gridPower > 0) {
    headroom = BREAKER_KW - BREAKER_BUFFER - gridPower;
  } else {
    const net = (homeLoad ?? 0) - (pvPower ?? 0);
    headroom = BREAKER_KW - BREAKER_BUFFER - Math.max(0, net);
  }
  return parseFloat(Math.min(MAX_CHARGE_KW, Math.max(0, headroom)).toFixed(2));
}

module.exports = {
  init,
  ensureLogTable,
  setParam,
  switchToSelfUse,
  setChargeKw,
  setSellKw,
  restoreTimedMode,
  emergencyStop,
  calcSafeChargeKw,
  MAX_CHARGE_KW,
  MAX_SELL_KW,
  BREAKER_KW,
  BREAKER_BUFFER,
};
