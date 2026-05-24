/**
 * SCAN MY TRADE — Server
 * ──────────────────────
 * SETUP (one time):
 *   1. Install Node.js from https://nodejs.org (version 18+)
 *   2. Open Terminal in this folder
 *   3. Run: npm init -y
 *   4. Run: npm install express
 *   5. Create a .env file containing:
 *      ANTHROPIC_API_KEY=sk-ant-...
 *
 * START:
 *   node server.js
 *
 * Then open: http://localhost:3000
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Load .env ─────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.trim().split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
}

// ── Middleware ────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

// ── Root ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'options-desk-mvp.html'));
});

// ── Health ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apiKey: process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing',
    version: '1.0'
  });
});

// ── Screenshot analysis ───────────────────────────────
app.post('/api/analyse', (req, res) => {
  console.log('\n--- /api/analyse ---');
  const { imageBase64, mediaType, prompt } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key configured' });
  if (!imageBase64) return res.status(400).json({ error: 'No image received' });
  if (!prompt) return res.status(400).json({ error: 'No prompt received' });

  const body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt }
      ]
    }]
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const apiReq = https.request(options, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      console.log('Anthropic status:', apiRes.statusCode);
      try { res.status(apiRes.statusCode).json(JSON.parse(data)); }
      catch(e) { res.status(500).json({ error: 'Bad response from Anthropic' }); }
    });
  });
  apiReq.on('error', err => res.status(500).json({ error: err.message }));
  apiReq.write(body);
  apiReq.end();
});

// ── Live prices ──────────────────────────────────────
// yahooHeaders defined once, reused across all price calls
const yahooHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
  'Cache-Control': 'no-cache'
};

function fetchPrice(symbol, callback) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
  ];
  let urlIdx = 0;

  function tryNext() {
    if (urlIdx >= urls.length) return callback(null);
    const url = urls[urlIdx++];
    const req = https.get(url, { headers: yahooHeaders }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return tryNext();
        try {
          const meta = JSON.parse(data)?.chart?.result?.[0]?.meta;
          const price = meta?.regularMarketPrice || meta?.previousClose || null;
          if (price) callback(+price.toFixed(2));
          else tryNext();
        } catch(e) { tryNext(); }
      });
    });
    req.on('error', tryNext);
    req.setTimeout(8000, () => { req.destroy(); tryNext(); });
  }
  tryNext();
}

app.get('/api/price/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  fetchPrice(symbol, price => {
    console.log(`Price ${symbol}: ${price}`);
    res.json({ symbol, price, source: price ? 'yahoo' : 'unavailable' });
  });
});

// ── Batch prices ──────────────────────────────────────
app.post('/api/prices', (req, res) => {
  const symbols = (req.body.symbols || []).map(s => s.toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.json({ prices: {} });
  const results = {};
  let completed = 0;
  symbols.forEach(symbol => {
    fetchPrice(symbol, price => {
      results[symbol] = price;
      if (++completed === symbols.length) {
        console.log('Batch prices:', results);
        res.json({ prices: results });
      }
    });
  });
});

// ── Earnings via Yahoo ────────────────────────────────
app.get('/api/earnings/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents`;
  const yahooHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/'
  };
  https.get(url, { headers: yahooHeaders }, yahooRes => {
    let data = '';
    yahooRes.on('data', chunk => data += chunk);
    yahooRes.on('end', () => {
      try {
        const dates = JSON.parse(data)?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate;
        if (dates?.length) res.json({ symbol, earningsDate: new Date(dates[0].raw*1000).toISOString().slice(0,10) });
        else res.json({ symbol, earningsDate: null });
      } catch(e) { res.json({ symbol, earningsDate: null }); }
    });
  }).on('error', () => res.json({ symbol, earningsDate: null }));
});

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║         SCAN MY TRADE  v1.0          ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  console.log(`  ✓  Running at  http://localhost:${PORT}`);
  console.log(`  ${hasKey?'✓':'✗'}  API key  ${hasKey?'configured ✓':'MISSING — add to .env'}`);
  console.log(`  ✓  Prices via Yahoo Finance\n`);
  console.log(`  Open →  http://localhost:${PORT}\n`);
});
