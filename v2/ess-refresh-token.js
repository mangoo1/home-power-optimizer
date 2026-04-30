#!/usr/bin/env node
/**
 * v2/ess-refresh-token.js — ESS-Link token 自动刷新
 * 
 * 检查当前 token 是否有效，无效则重新登录获取新 token 并更新 .env
 * 可单独运行，也被其他脚本 require 调用
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const BASE     = 'eu.ess-link.com';

function httpsPost(reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: BASE, path: reqPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://eu.ess-link.com/',
        lang: 'en', showloading: 'false',
        ...headers
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BASE, path: reqPath, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://eu.ess-link.com/', lang: 'en', ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// 测试 token 是否有效
async function testToken(token) {
  const mac = process.env.ESS_MAC_HEX;
  const r = await httpsGet(
    `/api/app/deviceInfo/getDeviceRealInfo?macHex=${mac}`,
    { Authorization: token }
  ).catch(() => null);
  return r && r.code === 200;
}

// 登录获取新 token
async function login(email, password) {
  // 尝试几个可能的路径
  const paths = [
    '/api/app/user/login',
    '/api/app/user/appLogin',
    '/api/user/login',
  ];
  for (const p of paths) {
    const r = await httpsPost(p, { email, password }).catch(() => null);
    if (r && r.code === 200 && r.data?.token) {
      return r.data.token;
    }
    if (r && r.code === 200 && r.token) {
      return r.token;
    }
  }
  return null;
}

// 更新 .env 文件里的 token
function updateEnvToken(newToken) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  if (content.includes('ESS_TOKEN=')) {
    content = content.replace(/^ESS_TOKEN=.*/m, `ESS_TOKEN=${newToken}`);
  } else {
    content += `\nESS_TOKEN=${newToken}`;
  }
  fs.writeFileSync(ENV_PATH, content);
  process.env.ESS_TOKEN = newToken;
}

// 主函数：检查并刷新
async function refreshIfNeeded() {
  const currentToken = process.env.ESS_TOKEN;
  const email        = process.env.ESS_EMAIL;
  const password     = process.env.ESS_PASSWORD;

  if (!email || !password) {
    console.log('[ESS-Token] 未配置 ESS_EMAIL/ESS_PASSWORD，跳过自动刷新');
    return currentToken;
  }

  // 先测试当前 token
  if (currentToken) {
    const valid = await testToken(currentToken);
    if (valid) {
      console.log('[ESS-Token] Token 有效，无需刷新');
      return currentToken;
    }
  }

  console.log('[ESS-Token] Token 已失效，重新登录...');
  const newToken = await login(email, password);

  if (newToken) {
    updateEnvToken(newToken);
    console.log('[ESS-Token] ✅ 新 token 已获取并写入 .env');
    return newToken;
  } else {
    console.error('[ESS-Token] ❌ 登录失败，请检查账号密码或 API 路径');
    return currentToken; // 返回旧 token，让调用方决定
  }
}

// 直接运行时
if (require.main === module) {
  refreshIfNeeded().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
}

module.exports = { refreshIfNeeded };
