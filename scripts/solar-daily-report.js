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

  // 今日增量
  const todayBought = prevState.gridBought != null ? (gridBought - prevState.gridBought).toFixed(2) : 'N/A';
  const todaySold   = prevState.gridSold   != null ? (gridSold   - prevState.gridSold  ).toFixed(2) : 'N/A';
  const todayCharged    = prevState.battCharged    != null ? (battCharged    - prevState.battCharged   ).toFixed(2) : 'N/A';
  const todayDischarged = prevState.battDischarged != null ? (battDischarged - prevState.battDischarged).toFixed(2) : 'N/A';
  const todayLoad   = prevState.loadTotal  != null ? (loadTotal  - prevState.loadTotal ).toFixed(2) : 'N/A';

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

  // 组装报告
  const gridStatus = gridPower < 0 ? `卖电 ${Math.abs(gridPower)} kW` : gridPower > 0.05 ? `买电 ${gridPower} kW` : '自给自足';
  const battStatus = battPower < 0 ? `放电 ${Math.abs(battPower)} kW` : battPower > 0 ? `充电 ${battPower} kW` : '待机';

  const lines = [
    `☀️ *今日太阳能日报* (${new Date().toLocaleDateString('zh-CN', {timeZone:'Australia/Sydney'})})`,
    ``,
    `🔋 *电池*`,
    `• 当前 SoC：${soc}%`,
    `• 今日充电：${todayCharged} kWh`,
    `• 今日放电：${todayDischarged} kWh`,
    `• 当前状态：${battStatus}`,
    ``,
    `⚡ *电网*`,
    `• 今日买电：${todayBought} kWh${amberTodayCost != null ? ` ≈ $${amberTodayCost} AUD` : ''}`,
    `• 今日卖电：${todaySold} kWh${amberTodaySellRevenue != null ? ` ≈ $${amberTodaySellRevenue} AUD` : ''}`,
    `• 当前状态：${gridStatus}`,
    ``,
    `🏠 *家庭用电*`,
    `• 今日用电：${todayLoad} kWh`,
    `• 当前功率：${loadPower} kW`,
    ``,
    `📊 *累计总量*`,
    `• 总买电：${gridBought} kWh | 总卖电：${gridSold} kWh`,
  ];

  console.log(lines.join('\n'));
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
