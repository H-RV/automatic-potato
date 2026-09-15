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
const { parseCsvRows, classifyExecutions } = require('./journal-parser');

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

// ── Price via query param (legacy) ────────────────────
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

// ── FlashAlpha IV + volatility data ──────────────────
app.get('/api/iv/:symbol', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const sym = req.params.symbol.toUpperCase();
  try {
    const response = await fetch(
      `https://lab.flashalpha.com/v1/stock/${sym}/summary`,
      { headers: { 'X-Api-Key': process.env.flashalpha_trial } }
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

// ── EMA 21 endpoint ───────────────────────────────────
app.get('/api/ema/:symbol', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const sym = req.params.symbol.toUpperCase();
  try {
    const key = process.env.TWELVE_DATA_API_KEY;
    const url = `https://api.twelvedata.com/ema?symbol=${sym}&interval=1day&time_period=21&outputsize=10&apikey=${key}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.values || !data.values.length) {
      return res.status(404).json({ error: 'No EMA data', raw: data });
    }
    const emaToday = parseFloat(data.values[0].ema);
    const ema5ago = parseFloat(data.values[5].ema);
    const priceResp = await fetch(`https://api.twelvedata.com/price?symbol=${sym}&apikey=${key}`);
    const priceData = await priceResp.json();
    const price = parseFloat(priceData.price);
    if (!Number.isFinite(price)) {
      // Twelve Data's price call didn't return a usable number (rate limit,
      // transient error, etc.) — return a real error instead of silently
      // baking "NaN" into the description string. The frontend's existing
      // "not auto-detected" fallback state handles this correctly already.
      return res.status(503).json({ error: 'Price unavailable from Twelve Data', raw: priceData });
    }
    const diff = emaToday - ema5ago;
    const pctDiff = (diff / ema5ago) * 100;
    const slope = pctDiff > 0.15 ? 'rising' : pctDiff < -0.15 ? 'declining' : 'flat';
    const position = price > emaToday ? 'above' : 'below';
    const regimeMap = {
      'above-rising': 'ar', 'above-flat': 'af', 'above-declining': 'ad',
      'below-rising': 'br', 'below-flat': 'br', 'below-declining': 'bd'
    };
    const regime = regimeMap[position + '-' + slope] || 'af';
    const descriptions = {
      ar: `${sym} $${price.toFixed(2)} — above rising EMA ($${emaToday.toFixed(2)}). Uptrend confirmed. BPS full size.`,
      af: `${sym} $${price.toFixed(2)} — above flat EMA ($${emaToday.toFixed(2)}). Ranging market. IC conditions.`,
      ad: `${sym} $${price.toFixed(2)} — above declining EMA ($${emaToday.toFixed(2)}). Warning — rolling over. Half size, favour BCS.`,
      br: `${sym} $${price.toFixed(2)} — below flat/rising EMA ($${emaToday.toFixed(2)}). Pullback not trend. BPS half size only.`,
      bd: `${sym} $${price.toFixed(2)} — below declining EMA ($${emaToday.toFixed(2)}). Downtrend confirmed. BCS only. No BPS.`,
    };
    res.json({
      symbol: sym,
      price: price,
      ema21: emaToday,
      ema5ago: ema5ago,
      slope: slope,
      position: position,
      regime: regime,
      description: descriptions[regime],
      as_of: data.values[0].datetime
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Chart data — price history + 21 EMA ──────────────
app.get('/api/chart/:symbol', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const sym = req.params.symbol.toUpperCase();
  try {
    const key = process.env.TWELVE_DATA_API_KEY;
    // 90 days fetched (not just the 30 displayed) so MACD's 26-period EMA and
    // the signal line have real time to settle before the values we actually
    // show — a 26-EMA computed from only 30 points of lead-in is noisy.
    const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=90&apikey=${key}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.values || !data.values.length) {
      return res.status(404).json({ error: 'No data', raw: data });
    }
    const bars = data.values.reverse().map(v => ({
      date: v.datetime,
      close: parseFloat(v.close),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      volume: parseFloat(v.volume) || 0,
    }));

    // ── 21-day EMA (existing regime indicator) ──
    const emaPeriod = 21;
    const emaK = 2 / (emaPeriod + 1);
    let ema21 = bars[0].close;
    bars.forEach((bar, i) => {
      if (i === 0) ema21 = bar.close; else ema21 = bar.close * emaK + ema21 * (1 - emaK);
      bar.ema21 = ema21;
    });

    // ── MACD (12, 26, 9) ──
    function emaSeries(vals, period) {
      const k = 2 / (period + 1);
      let e = vals[0];
      return vals.map((v, i) => { e = i === 0 ? v : v * k + e * (1 - k); return e; });
    }
    const closesArr = bars.map(b => b.close);
    const ema12Arr = emaSeries(closesArr, 12);
    const ema26Arr = emaSeries(closesArr, 26);
    const macdLineArr = closesArr.map((_, i) => ema12Arr[i] - ema26Arr[i]);
    const signalArr = emaSeries(macdLineArr, 9);
    bars.forEach((bar, i) => {
      bar.macd = macdLineArr[i];
      bar.macdSignal = signalArr[i];
      bar.macdHist = macdLineArr[i] - signalArr[i];
    });

    // ── Stochastic Oscillator (14-period %K, 3-period %D) ──
    const stochPeriod = 14;
    bars.forEach((bar, i) => {
      if (i < stochPeriod - 1) { bar.stochK = null; return; }
      const window = bars.slice(i - stochPeriod + 1, i + 1);
      const hh = Math.max(...window.map(w => w.high));
      const ll = Math.min(...window.map(w => w.low));
      bar.stochK = hh === ll ? 50 : ((bar.close - ll) / (hh - ll)) * 100;
    });
    bars.forEach((bar, i) => {
      if (i < stochPeriod + 1) { bar.stochD = null; return; }
      const window = bars.slice(i - 2, i + 1).map(w => w.stochK).filter(v => v != null);
      bar.stochD = window.reduce((a, b) => a + b, 0) / window.length;
    });

    // ── Volume trend: is recent volume rising or falling vs its own 10-day average ──
    const last10Vol = bars.slice(-10).map(b => b.volume);
    const avgVol10 = last10Vol.reduce((a, b) => a + b, 0) / last10Vol.length;
    const last3Vol = bars.slice(-3).map(b => b.volume);
    const avgVol3 = last3Vol.reduce((a, b) => a + b, 0) / last3Vol.length;
    const volumeTrend = avgVol3 > avgVol10 * 1.1 ? 'rising' : avgVol3 < avgVol10 * 0.9 ? 'falling' : 'flat';

    // ── Display window: last 30 days only, matching the existing chart ──
    const display = bars.slice(-30).map(b => ({
      date: b.date,
      close: parseFloat(b.close.toFixed(2)),
      ema21: parseFloat(b.ema21.toFixed(2)),
      macdHist: parseFloat(b.macdHist.toFixed(4)),
      stochK: b.stochK != null ? parseFloat(b.stochK.toFixed(1)) : null,
      volume: b.volume,
    }));

    const latest = bars[bars.length - 1];
    const priceAboveVolumeDivergence = latest.close > bars[bars.length - 5].close && volumeTrend === 'falling';

    const signals = {
      emaTrend: latest.close > latest.ema21 ? 'bullish' : 'bearish',
      macd: latest.macdHist > 0 ? 'bullish' : 'bearish',
      stochastic: latest.stochK != null ? (latest.stochK > 80 ? 'bullish' : latest.stochK < 20 ? 'bearish' : 'neutral') : 'neutral',
      volume: volumeTrend === 'rising' ? 'bullish' : volumeTrend === 'falling' ? 'bearish' : 'neutral',
      volumeDivergenceWarning: priceAboveVolumeDivergence,
      macdHistLatest: parseFloat(latest.macdHist.toFixed(4)),
      stochKLatest: latest.stochK != null ? parseFloat(latest.stochK.toFixed(1)) : null,
    };

    res.json({ symbol: sym, data: display, signals });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Fundamentals + next earnings via Finnhub ──────────
// Separate from the existing /api/earnings/:symbol (Yahoo-based, left
// untouched above in case ScanMyTrade depends on its exact shape). This
// route is what backbone-pro.html's single-ticker fundamentals panel calls.
// Needs FINNHUB_API_KEY in Railway env vars (free tier: https://finnhub.io).
app.get('/api/fundamentals/:symbol', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const symbol = req.params.symbol.toUpperCase();
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return res.status(503).json({ error: 'FINNHUB_API_KEY not configured' });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const calUrl = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${future}&symbol=${symbol}&token=${key}`;
    const calResp = await fetch(calUrl);
    const calData = await calResp.json();
    const nextEarnings = (calData.earningsCalendar && calData.earningsCalendar[0])
      ? calData.earningsCalendar[0].date
      : null;

    const metricUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${key}`;
    const metricResp = await fetch(metricUrl);
    const metricData = await metricResp.json();
    const m = metricData.metric || {};
    const epsGrowth = m.epsGrowthTTMYoy != null ? Math.round(m.epsGrowthTTMYoy * 10) / 10 : null;
    const revenueGrowth = m.revenueGrowthTTMYoy != null ? Math.round(m.revenueGrowthTTMYoy * 10) / 10 : null;

    res.json({ symbol, epsGrowth, revenueGrowth, nextEarnings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GARCH(1,1) vol regime signal — pure JS, no external deps ──
// Shown as the 4th session-bar indicator in Backbone Pro. Originally shelled
// out to a Python script, which needed python3/numpy/scipy in the deploy
// container — Railway's current builder (Railpack) doesn't support that
// cleanly, so this is a JS reimplementation instead. Trades a little
// statistical precision for zero runtime dependencies.
function garchLogReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}
function garchVariance(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
}
function garchLogLik(r, omega, alpha, beta) {
  let sigma2 = garchVariance(r);
  let ll = 0;
  for (let t = 0; t < r.length; t++) {
    if (t > 0) sigma2 = omega + alpha * r[t - 1] ** 2 + beta * sigma2;
    if (sigma2 <= 0) return -Infinity;
    ll += -0.5 * (Math.log(2 * Math.PI * sigma2) + (r[t] ** 2) / sigma2);
  }
  return ll;
}
function fitGarch11(r) {
  const varR = garchVariance(r);
  let best = { alpha: 0.08, beta: 0.88, ll: -Infinity };
  for (let alpha = 0.02; alpha <= 0.30; alpha += 0.02) {
    for (let beta = 0.50; beta <= 0.97; beta += 0.02) {
      if (alpha + beta >= 0.999) continue;
      const omega = varR * (1 - alpha - beta);
      if (omega <= 0) continue;
      const ll = garchLogLik(r, omega, alpha, beta);
      if (ll > best.ll) best = { alpha, beta, ll };
    }
  }
  const a0 = best.alpha, b0 = best.beta;
  for (let alpha = Math.max(0.001, a0 - 0.02); alpha <= a0 + 0.02; alpha += 0.002) {
    for (let beta = Math.max(0.001, b0 - 0.02); beta <= Math.min(0.998, b0 + 0.02); beta += 0.002) {
      if (alpha + beta >= 0.999) continue;
      const omega = varR * (1 - alpha - beta);
      if (omega <= 0) continue;
      const ll = garchLogLik(r, omega, alpha, beta);
      if (ll > best.ll) best = { alpha, beta, ll };
    }
  }
  const omega = varR * (1 - best.alpha - best.beta);
  return { omega, alpha: best.alpha, beta: best.beta };
}
function garchRegime(closes) {
  if (closes.length < 60) return { error: 'need at least 60 closes for a stable GARCH fit' };
  const r = garchLogReturns(closes);
  const { omega, alpha, beta } = fitGarch11(r);
  let sigma2 = garchVariance(r);
  const sigma2Path = [sigma2];
  for (let t = 1; t < r.length; t++) {
    sigma2 = omega + alpha * r[t - 1] ** 2 + beta * sigma2;
    sigma2Path.push(sigma2);
  }
  const forecastVar = omega + alpha * r[r.length - 1] ** 2 + beta * sigma2Path[sigma2Path.length - 1];
  const currentVolAnnualised = Math.sqrt(sigma2Path[sigma2Path.length - 1] * 252) * 100;
  const forecastVolAnnualised = Math.sqrt(forecastVar * 252) * 100;
  const longRunVar = (alpha + beta) < 1 ? omega / (1 - alpha - beta) : garchVariance(sigma2Path);
  const longRunVol = Math.sqrt(longRunVar * 252) * 100;
  const ratio = longRunVol > 0 ? forecastVolAnnualised / longRunVol : 1;
  const regime = ratio < 0.85 ? 'low_vol' : ratio > 1.25 ? 'high_vol' : 'transitioning';
  return {
    regime,
    forecast: Math.round(forecastVolAnnualised * 100) / 100,
    current_vol: Math.round(currentVolAnnualised * 100) / 100,
    long_run_vol: Math.round(longRunVol * 100) / 100
  };
}

app.get('/api/garch/:symbol', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const sym = req.params.symbol.toUpperCase();
  const tdKey = process.env.TWELVE_DATA_API_KEY;
  if (!tdKey) return res.status(503).json({ error: 'TWELVE_DATA_API_KEY not configured' });

  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=252&apikey=${tdKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.values) throw new Error('no price history from Twelve Data');
    const closes = data.values.map(v => parseFloat(v.close)).reverse();
    const result = garchRegime(closes);
    if (result.error) return res.status(422).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TRADE JOURNAL — upload, storage, summary ──────────────────────────────
// Storage lives on the Railway volume (survives redeploys) — falls back to
// a local ./journal-data folder for testing on your Mac, where there's no
// RAILWAY_VOLUME_MOUNT_PATH set.
const JOURNAL_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'journal-data');
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'raw-data.json');

function loadJournalStore() {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return { execs: [], realizedPnl: {}, sharesHeld: {} };
    return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
  } catch (e) {
    console.log('journal store read failed, starting fresh:', e.message);
    return { execs: [], realizedPnl: {}, sharesHeld: {} };
  }
}

function saveJournalStore(store) {
  if (!fs.existsSync(JOURNAL_DIR)) fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(store));
}

function execKey(e) {
  return [e.contract, e.dt, e.qty, e.price].join('|');
}

app.post('/api/journal/upload', express.text({ type: '*/*', limit: '10mb' }), (req, res) => {
  try {
    const csvText = req.body;
    if (!csvText || typeof csvText !== 'string') {
      return res.status(400).json({ error: 'No CSV text received' });
    }

    const rows = parseCsvRows(csvText);
    const tradeRows = rows.filter(r => r[0] === 'Trades' && r[1] === 'Data' && r[3] === 'Equity and Index Options');
    const newExecs = tradeRows.map(r => ({
      contract: r[5], dt: r[6], qty: parseFloat(r[7]), price: parseFloat(r[8]), code: r[15] || '',
    }));

    const realizedRows = rows.filter(r => r[0] === 'Realized & Unrealized Performance Summary' && r[1] === 'Data' && r[2] === 'Equity and Index Options');
    const newRealized = {};
    for (const r of realizedRows) newRealized[r[3]] = parseFloat(r[9]) || 0;

    const openStockRows = rows.filter(r => r[0] === 'Open Positions' && r[1] === 'Data' && r[3] === 'Stocks');
    const newShares = {};
    for (const r of openStockRows) newShares[r[5]] = parseFloat(r[6]) || 0;

    const store = loadJournalStore();
    const existingKeys = new Set(store.execs.map(execKey));
    let added = 0;
    for (const e of newExecs) {
      const k = execKey(e);
      if (!existingKeys.has(k)) {
        store.execs.push(e);
        existingKeys.add(k);
        added++;
      }
    }
    Object.assign(store.realizedPnl, newRealized);
    Object.assign(store.sharesHeld, newShares);

    saveJournalStore(store);

    const result = classifyExecutions(store.execs, store.realizedPnl, store.sharesHeld);

    res.json({
      newExecutionsAdded: added,
      totalExecutionsStored: store.execs.length,
      netRealized: result.netRealized,
      byBucket: result.byBucket,
      warnings: result.warnings,
    });
  } catch (e) {
    console.log('journal upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/journal/summary', (req, res) => {
  try {
    const store = loadJournalStore();
    const result = classifyExecutions(store.execs, store.realizedPnl, store.sharesHeld);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────
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
