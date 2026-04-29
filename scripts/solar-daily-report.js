#!/usr/bin/env node
/**
 * Solar Daily Report
 * 每天 23:55 运行，汇总当天逆变器用电/买电/卖电情况
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// 从环境变量读取 token
const ESS_TOKEN = process.env.ESS_TOKEN;
const AMBER_API_TOKEN = process.env.AMBER_API_TOKEN;
const MAC_HEX = '00534E0045FF';

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function main() {
  const authHeader = { 'Authorization': ESS_TOKEN };
  const amberHeader = { 'Authorization': `Bearer ${AMBER_API_TOKEN}` };

  // 拉取电池数据
  const battData = await httpsGet(
    `https://eu.ess-link.com/api/app/deviceInfo/getBatteryInfo?macHex=${MAC_HEX}&indexes=0x1212,0x1210,0x125E,0x1260`,
    authHeader
  );

  // 拉取电表数据
  const meterData = await httpsGet(
    `https://eu.ess-link.com/api/app/deviceInfo/getMeterInfo?macHex=${MAC_HEX}&indexes=0x1240,0x1242,0xA112`,
    authHeader
  );

  // 拉取负载数据
  const loadData = await httpsGet(
    `https://eu.ess-link.com/api/app/deviceInfo/getLoadInfo?macHex=${MAC_HEX}&indexes=0x1274,0x1262`,
    authHeader
  );

  // 读取今日初始值（用于计算今日增量）
  const stateFile = path.join(__dirname, '../memory/solar-daily-state.json');
  let prevState = {};
  try {
    prevState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch(e) {}

  // 解析数据
  const getValue = (d, index) => {
    const item = d.data?.find(i => i.index === index);
    return item ? parseFloat(item.valueStr) : null;
  };

  const soc = getValue(battData, '0x1212');
  const battPower = getValue(battData, '0x1210');
  const battCharged = getValue(battData, '0x125E');   // 累计充电 kWh
  const battDischarged = getValue(battData, '0x1260'); // 累计放电 kWh

  const gridBought = getValue(meterData, '0x1240');   // 累计买电 kWh
  const gridSold = getValue(meterData, '0x1242');     // 累计卖电 kWh
  const gridPower = getValue(meterData, '0xA112');    // 实时电网功率

  const loadPower = getValue(loadData, '0x1274');     // 家庭用电 kW
  const loadTotal = getValue(loadData, '0x1262');     // 累计用电 kWh

  // ── 今日数据：从 energy_log 取逆变器 today_* 字段（最准确）──────────
  // 这些字段是逆变器自身的今日累计，在 UTC 午夜重置
  // 23:55 Sydney = ~13:55 UTC，还没重置，数据完整
  let todayBought = 'N/A', todaySold = 'N/A', todayCharged = 'N/A';
  let todayDischarged = 'N/A', todayLoad = 'N/A', todayPv = '0';
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(__dirname, '../data/energy.db');
    const db = new Database(dbPath);
    const row = db.prepare(`
      SELECT today_charge_kwh, today_discharge_kwh, today_pv_kwh,
             today_grid_buy_kwh, today_grid_sell_kwh, today_home_kwh
      FROM energy_log
      WHERE today_pv_kwh IS NOT NULL AND today_pv_kwh > 0
      ORDER BY ts DESC LIMIT 1
    `).get();
    if (row) {
      todayCharged    = (row.today_charge_kwh    ?? 0).toFixed(2);
      todayDischarged = (row.today_discharge_kwh ?? 0).toFixed(2);
      todayBought     = (row.today_grid_buy_kwh  ?? 0).toFixed(2);
      todaySold       = (row.today_grid_sell_kwh ?? 0).toFixed(2);
      todayLoad       = (row.today_home_kwh      ?? 0).toFixed(2);
      todayPv         = (row.today_pv_kwh        ?? 0).toFixed(1);
    }
    db.close();
  } catch(e) {
    console.warn('Failed to read energy_log, falling back to cumulative delta:', e.message);
    todayBought = prevState.gridBought != null ? (gridBought - prevState.gridBought).toFixed(2) : 'N/A';
    todaySold   = prevState.gridSold   != null ? (gridSold   - prevState.gridSold  ).toFixed(2) : 'N/A';
    todayCharged    = prevState.battCharged    != null ? (battCharged    - prevState.battCharged   ).toFixed(2) : 'N/A';
    todayDischarged = prevState.battDischarged != null ? (battDischarged - prevState.battDischarged).toFixed(2) : 'N/A';
    todayLoad   = prevState.loadTotal  != null ? (loadTotal  - prevState.loadTotal ).toFixed(2) : 'N/A';
  }

  // Amber 今日用电金额估算（用均价 ~25c 买电，卖电用 feedIn 均价）
  // 实际用 Amber API 今日历史价格来算更准，但简化用当前均价
  // 买电：取今日 general 均价，假设 ~25c（高峰均价）
  // 这里用一个简单估算：今日买电量 × 估算均价
  // 更准确需要 Amber 历史 API，留作后续优化
  const buyEstimate = todayBought !== 'N/A' ? (parseFloat(todayBought) * 0.25).toFixed(2) : 'N/A';
  const sellEstimate = todaySold !== 'N/A' ? (parseFloat(todaySold) * 0.10).toFixed(2) : 'N/A'; // feedIn 均价约 10c

  // 获取 Amber 今日实际用电金额（近似：用 usage endpoint）
  let amberTodayCost = null;
  try {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const amberUsage = await httpsGet(
      `https://api.amber.com.au/v1/sites/01KMN0H71HS5SYAE5P3E9WDGCD/usage?startDate=${dateStr}&endDate=${dateStr}`,
      amberHeader
    );
    if (Array.isArray(amberUsage)) {
      let totalCost = 0;
      for (const interval of amberUsage) {
        if (interval.channelType === 'general' && interval.cost != null) {
          totalCost += interval.cost;
        }
      }
      amberTodayCost = (totalCost / 100).toFixed(2); // 分 → 澳元
    }
  } catch(e) {}

  let amberTodaySellRevenue = null;
  try {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const amberUsage = await httpsGet(
      `https://api.amber.com.au/v1/sites/01KMN0H71HS5SYAE5P3E9WDGCD/usage?startDate=${dateStr}&endDate=${dateStr}`,
      amberHeader
    );
    if (Array.isArray(amberUsage)) {
      let totalRevenue = 0;
      for (const interval of amberUsage) {
        if (interval.channelType === 'feedIn' && interval.cost != null) {
          totalRevenue += interval.cost;
        }
      }
      amberTodaySellRevenue = (Math.abs(totalRevenue) / 100).toFixed(2);
    }
  } catch(e) {}

  // 保存当前状态供明天计算增量
  const newState = { gridBought, gridSold, battCharged, battDischarged, loadTotal, date: new Date().toISOString().split('T')[0] };
  fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));

  // ── 复盘分析 ──────────────────────────────────────────────
  const todayBoughtNum  = parseFloat(todayBought)  || 0;
  const todaySoldNum    = parseFloat(todaySold)    || 0;
  const todayPvNum      = parseFloat(todayPv)      || 0;
  const todayLoadNum    = parseFloat(todayLoad)    || 0;
  const todayChargedNum = parseFloat(todayCharged) || 0;

  // 今日净电费 = 买电成本 - 卖电收入
  const costNum    = amberTodayCost     != null ? parseFloat(amberTodayCost)        : null;
  const revenueNum = amberTodaySellRevenue != null ? parseFloat(amberTodaySellRevenue) : null;
  const netCost    = (costNum != null && revenueNum != null) ? (costNum - Math.abs(revenueNum)).toFixed(2) : null;

  // 复盘评分
  const reviews = [];

  // 1. PV 消纳：今天 PV 有没有浪费（卖电价<买电价 = 低价溢出）
  if (todayPvNum > 0) {
    const pvSelfUseRate = Math.min(100, Math.round((todayPvNum - Math.max(0, todaySoldNum - todayChargedNum)) / todayPvNum * 100));
    if (pvSelfUseRate >= 95) reviews.push('☀️ PV消纳优秀，几乎零溢出');
    else if (pvSelfUseRate >= 80) reviews.push(`☀️ PV消纳${pvSelfUseRate}%，有改进空间`);
    else reviews.push(`⚠️ PV消纳仅${pvSelfUseRate}%，有较多溢出低价卖出`);
  }

  // 2. 电池充满了吗
  if (soc >= 85) reviews.push('🔋 电池充满 ✅');
  else if (soc >= 70) reviews.push(`🔋 电池${soc}%，略低于目标85%`);
  else reviews.push(`⚠️ 电池仅${soc}%，明天早晨充电压力大`);

  // 3. 卖电收益
  if (todaySoldNum >= 10) reviews.push(`💰 卖电${todaySoldNum}kWh，收益$${revenueNum ?? '?'}`);
  else if (todaySoldNum >= 3) reviews.push(`💰 卖电${todaySoldNum}kWh，偏少`);
  else reviews.push(`❌ 卖电不足（${todaySoldNum}kWh），电池可能没充满或PV不足`);

  // 4. 今日净电费
  if (netCost != null) {
    if (parseFloat(netCost) <= 2) reviews.push(`✅ 净电费 $${netCost}（接近自给）`);
    else if (parseFloat(netCost) <= 5) reviews.push(`📋 净电费 $${netCost}`);
    else reviews.push(`⚠️ 净电费 $${netCost}，偏高`);
  }

  // 5. 读今日计划对比
  let planNote = '';
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(__dirname, '../data/energy.db');
    const db = new Database(dbPath);
    const sydDate = new Date(new Date().getTime() + 10*3600000).toISOString().slice(0,10);
    const plan = db.prepare('SELECT pv_forecast_kwh, soc_at_gen FROM daily_plan WHERE date=? AND is_active=1 ORDER BY version DESC LIMIT 1').get(sydDate);
    if (plan) {
      const pvForecast = plan.pv_forecast_kwh?.toFixed(1);
      const pvActual = todayPvNum.toFixed(1);
      const pvErr = pvForecast ? Math.round((todayPvNum - plan.pv_forecast_kwh) / plan.pv_forecast_kwh * 100) : null;
      planNote = `\n📐 PV预测 ${pvForecast}kWh vs 实际 ${pvActual}kWh${pvErr != null ? `（误差${pvErr > 0 ? '+':''}${pvErr}%）` : ''}`;
    }
    db.close();
  } catch {}

  // 组装报告
  const gridStatus = gridPower < 0 ? `卖电 ${Math.abs(gridPower)} kW` : gridPower > 0.05 ? `买电 ${gridPower} kW` : '自给自足';
  const battStatus = battPower < 0 ? `放电 ${Math.abs(battPower)} kW` : battPower > 0 ? `充电 ${battPower} kW` : '待机';

  const lines = [
    `☀️ *今日太阳能日报* (${new Date().toLocaleDateString('zh-CN', {timeZone:'Australia/Sydney'})})`,
    ``,
    `🔋 *电池*  SoC ${soc}%（${battStatus}）`,
    `• 今日充电 ${todayCharged}kWh  放电 ${todayDischarged}kWh`,
    ``,
    `⚡ *电网*`,
    `• 买电 ${todayBought}kWh${costNum != null ? ` $${costNum}` : ''}  |  卖电 ${todaySold}kWh${revenueNum != null ? ` $${Math.abs(revenueNum)}` : ''}`,
    netCost != null ? `• 净电费 $${netCost}` : '',
    ``,
    `☀️ *太阳能*  ${todayPv}kWh${planNote}`,
    `🏠 *用电*  ${todayLoad}kWh`,
    ``,
    `📋 *今日复盘*`,
    ...reviews.map(r => `• ${r}`),
    ``,
    `📊 累计：买 ${gridBought}kWh | 卖 ${gridSold}kWh`,
  ].filter(l => l !== '');

  console.log(lines.join('\n'));
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
