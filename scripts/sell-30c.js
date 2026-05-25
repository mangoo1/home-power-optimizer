#!/usr/bin/env node
/**
 * sell-30c.js — 只卖 feedIn > 30¢ 的槽位，累计卖够90分钟自动停
 * 每次运行检查当前价格，决定是否卖电
 * 用法: 每30分钟 cron 调用一次
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');
const ess = require('../v2/ess-api');

const DB_PATH = path.join(__dirname, '..', 'data', 'energy.db');
const STATE_FILE = path.join(__dirname, '..', 'data', 'sell-30c-state.json');
const fs = require('fs');

const AMBER_TOKEN = process.env.AMBER_API_TOKEN;
const AMBER_SITE_ID = process.env.AMBER_SITE_ID;
const MIN_FEEDIN_C = 30;
const MAX_SELL_MINUTES = 90;
const SELL_KW = 5;

function log(msg) {
  const t = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${t}] ${msg}`);
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Reset if from a different day
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    if (s.date !== today) return { date: today, soldMinutes: 0, slots: [] };
    return s;
  } catch {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    return { date: today, soldMinutes: 0, slots: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function amberGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.amber.com.au',
      path,
      headers: { Authorization: `Bearer ${AMBER_TOKEN}` }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Amber ${res.statusCode}: ${d}`));
        resolve(JSON.parse(d));
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  const db = new Database(DB_PATH);
  ess.init({ db, mac: process.env.ESS_MAC_HEX, token: process.env.ESS_TOKEN });

  const state = loadState();
  log(`状态: 已卖 ${state.soldMinutes}/${MAX_SELL_MINUTES} 分钟`);

  if (state.soldMinutes >= MAX_SELL_MINUTES) {
    log(`已达 ${MAX_SELL_MINUTES} 分钟上限，切回 Self-use`);
    await ess.switchToSelfUse('sell-30c-done', 'sell-30c');
    return;
  }

  // 获取当前价格
  const prices = await amberGet(`/v1/sites/${AMBER_SITE_ID}/prices/current?next=0&previous=0`);
  const feedIn = prices.find(p => p.channelType === 'feedIn');
  const general = prices.find(p => p.channelType === 'general');

  if (!feedIn || !general) {
    log('❌ 无法获取价格');
    return;
  }

  const feedInC = Math.abs(feedIn.perKwh);
  const buyC = general.perKwh;
  const nemTime = general.nemTime || feedIn.nemTime;

  log(`当前: feedIn=${feedInC.toFixed(1)}¢, buy=${buyC.toFixed(1)}¢`);

  if (feedInC >= MIN_FEEDIN_C) {
    const remaining = MAX_SELL_MINUTES - state.soldMinutes;
    log(`✅ feedIn ${feedInC.toFixed(1)}¢ >= ${MIN_FEEDIN_C}¢，开始卖电！剩余额度 ${remaining} 分钟`);

    // 设 Timed 模式卖电
    // 卖电窗口设为当前时间到+30分钟（下次cron会重新判断）
    const now = new Date();
    const sydneyNow = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
    const hh = sydneyNow.getHours();
    const mm = sydneyNow.getMinutes();
    const startHHMM = hh * 100 + mm;
    // 结束时间 = 开始 + 35分钟（留5分钟buffer，下次cron会接管）
    const endDate = new Date(sydneyNow.getTime() + 35 * 60000);
    const endHHMM = endDate.getHours() * 100 + endDate.getMinutes();

    await ess.setParam(0x300C, 1, 'timed-sell', 'sell-30c');
    await ess.setParam(0xC018, startHHMM, `sell-start-${startHHMM}`, 'sell-30c');
    await ess.setParam(0xC01A, endHHMM, `sell-end-${endHHMM}`, 'sell-30c');
    await ess.setParam(0xC0BC, 50, 'sell-5kw', 'sell-30c');
    await ess.setParam(0xC014, 0, 'no-charge', 'sell-30c');
    await ess.setParam(0xC016, 0, 'no-charge', 'sell-30c');
    await ess.setParam(0xC0BA, 0, 'no-charge', 'sell-30c');

    state.soldMinutes += 30;
    state.slots.push({ time: `${hh}:${String(mm).padStart(2,'0')}`, feedInC: feedInC.toFixed(1), buyC: buyC.toFixed(1) });
    saveState(state);

    log(`卖电窗口: ${startHHMM}-${endHHMM}, 累计已卖 ${state.soldMinutes} 分钟`);
  } else {
    log(`⏸ feedIn ${feedInC.toFixed(1)}¢ < ${MIN_FEEDIN_C}¢，不卖，切 Self-use`);
    await ess.switchToSelfUse('feedin-too-low', 'sell-30c');
  }

  db.close();
}

main().catch(e => { log(`❌ ${e.message}`); process.exit(1); });
