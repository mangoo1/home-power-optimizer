const https = require('https');
const http = require('http');

const TURSO_URL   = 'https://home-power-optimizer-mangoo1.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_TOKEN;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/turso') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const url = new URL(TURSO_URL + '/v2/pipeline');
      const opts = {
        hostname: url.hostname, path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + TURSO_TOKEN,
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const proxy = https.request(opts, r => {
        res.writeHead(r.statusCode, { 'Content-Type': 'application/json' });
        r.pipe(res);
      });
      proxy.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      proxy.write(body);
      proxy.end();
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(4000, () => console.log('Turso proxy on :4000'));
