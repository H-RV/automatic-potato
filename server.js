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

// ── Root — new quick-entry landing page ────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'smt-landing-v14.html'));
});

// ── Scan tool — existing multi-position dashboard ──────
app.get('/scan', (req, res) => {
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
    max_tokens: 4000,
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
    apiRes.on('data', chunk => { data += chunk; });
    apiRes.on('end', () => {
      console.log('Anthropic status:', apiRes.statusCode);
      console.log('Response length:', data.length);
      try {
        const parsed = JSON.parse(data);
        res.status(apiRes.statusCode).json(parsed);
      } catch(e) {
        console.log('Anthropic parse error:', e.message);
        console.log('Raw response (first 500):', data.substring(0, 500));
        res.status(500).json({ error: 'Failed to parse Anthropic response: ' + e.message });
      }
    });
  });
  apiReq.on('error', err => {
    console.log('Anthropic request error:', err.message);
    res.status(500).json({ error: err.message });
  });
  apiReq.setTimeout(60000, () => {
    console.log('Anthropic request timed out');
    apiReq.destroy();
    res.status(500).json({ error: 'Request timed out' });
  });
  apiReq.write(body);
  apiReq.end();
});

// ── Live prices via Twelve Data ──────────────────────
function fetchPrice(symbol, callback) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    console.log('TWELVE_DATA_API_KEY not set');
    return callback(null);
  }
  const url = `https://api.twelvedata.com/price?symbol=${symbol}&apikey=${apiKey}`;
  const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        // Twelve Data returns { price: "417.85" } or { code: 400, message: "..." }
        const price = parsed?.price ? +parseFloat(parsed.price).toFixed(2) : null;
        console.log(`Price ${symbol}: ${price} (status: ${res.statusCode})`);
        callback(price);
      } catch(e) {
        console.log(`Price ${symbol}: parse error`, e.message);
        callback(null);
      }
    });
  });
  req.on('error', err => {
    console.log(`Price ${symbol}: network error`, err.message);
    callback(null);
  });
  req.setTimeout(8000, () => { req.destroy(); callback(null); });
}

app.get('/api/price/:symbol', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const symbol = req.params.symbol.toUpperCase();
  fetchPrice(symbol, price => {
    res.json({ symbol, price, source: price ? 'twelvedata' : 'unavailable' });
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
app.get('/api/price', async (req, res) => {
  const ticker = req.query.ticker;
  if (!ticker) return res.status(400).json({ error: 'No ticker provided' });
  try {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    const response = await fetch(`https://api.twelvedata.com/price?symbol=${ticker}&apikey=${apiKey}`);
    const data = await response.json();
    if (data.price) {
      res.json({ price: parseFloat(data.price), ticker: ticker.toUpperCase() });
    } else {
      res.status(404).json({ error: 'Price not found', detail: data });
    }
  } catch (e) {
    res.status(500).json({ error: 'Fetch failed', detail: e.message });
  }
});
// FlashAlpha IV + IVR endpoint
app.get('/api/iv/:symbol', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const sym = req.params.symbol.toUpperCase();
  try {
    const response = await fetch(
      `https://lab.flashalpha.com/v1/stock/${sym}/summary`,
      { headers: { 'X-Api-Key': process.env.FLASHALPHA_KEY } }
    );
    const data = await response.json();
    const vol = data.volatility || {};
    const mac = data.macro || {};
    const exp = data.exposure || {};
    const px = data.price || {};
    res.json({
      symbol: sym,
      price: px.last || px.mid || null,
      iv: vol.atm_iv || null,
      hv20: vol.hv_20 || null,
      hv60: vol.hv_60 || null,
      vrp: vol.vrp || null,
      vix: mac.vix ? mac.vix.value : null,
      gamma_flip: exp.gamma_flip || null,
      gamma_regime: exp.regime || null,
      call_wall: exp.call_wall || null,
      put_wall: exp.put_wall || null,
      pc_ratio: data.options_flow ? data.options_flow.pc_ratio_oi : null,
      as_of: data.as_of || null
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// EMA 21 endpoint
app.get('/api/ema/:symbol', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const sym = req.params.symbol.toUpperCase();
  try {
    const key = process.env.TWELVE_DATA_API_KEY;
    const url = `https://api.twelvedata.com/ema?symbol=${sym}&interval=1day&time_period=21&outputsize=10&apikey=${key}`;
    const response = await fetch(url);
    const data = await response.json();

    // Debug: return raw so we can see the structure
    if (!data.values || !data.values.length) {
      return res.status(404).json({ error: 'No EMA data', raw: data });
    }

    // Return raw first value so we can see the field names
    return res.json({ debug: true, sample: data.values[0], allKeys: Object.keys(data.values[0]) });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, () => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const hasPriceKey = !!process.env.TWELVE_DATA_API_KEY;
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║         SCAN MY TRADE  v1.0          ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  console.log(`  ✓  Running at  http://localhost:${PORT}`);
  console.log(`  ${hasKey?'✓':'✗'}  Anthropic key  ${hasKey?'configured ✓':'MISSING — add ANTHROPIC_API_KEY to .env'}`);
  console.log(`  ${hasPriceKey?'✓':'✗'}  Twelve Data key  ${hasPriceKey?'configured ✓':'MISSING — add TWELVE_DATA_API_KEY to .env'}\n`);
  console.log(`  Open →  http://localhost:${PORT}\n`);
});