// ── ADDENDUM FOR server.js ──────────────────────────────────────────────────
// Two new routes referenced by the rebuilt backbone-pro.html:
//   GET /api/earnings/:symbol   → Finnhub-backed fundamentals + next earnings date
//   GET /api/garch/:symbol      → vol regime signal (calls out to a Python script)
//
// Neither of these exists on Railway yet — the frontend calls them defensively
// (try/catch, silent fallback) so nothing breaks until you deploy this.
//
// New Railway env var needed: FINNHUB_API_KEY (free tier: https://finnhub.io)

const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// GET /api/earnings/:symbol
// Returns: { epsGrowth, revenueGrowth, nextEarnings } — any field may be null
// if Finnhub doesn't have it for that symbol (common for ETFs — they'll just
// come back mostly null, which the frontend already handles).
// ---------------------------------------------------------------------------
app.get('/api/earnings/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return res.status(503).json({ error: 'FINNHUB_API_KEY not configured' });

  try {
    // Next earnings date — earnings calendar, next 90 days
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const calUrl = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${future}&symbol=${symbol}&token=${key}`;
    const calResp = await fetch(calUrl);
    const calData = await calResp.json();
    const nextEarnings = (calData.earningsCalendar && calData.earningsCalendar[0])
      ? calData.earningsCalendar[0].date
      : null;

    // Basic financials — EPS growth / revenue growth (trailing)
    const metricUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${key}`;
    const metricResp = await fetch(metricUrl);
    const metricData = await metricResp.json();
    const m = metricData.metric || {};
    const epsGrowth = m.epsGrowthTTMYoy != null ? Math.round(m.epsGrowthTTMYoy * 10) / 10 : null;
    const revenueGrowth = m.revenueGrowthTTMYoy != null ? Math.round(m.revenueGrowthTTMYoy * 10) / 10 : null;

    res.json({ symbol, epsGrowth, revenueGrowth, nextEarnings });
  } catch (err) {
    console.error('earnings fetch failed:', err.message);
    res.status(502).json({ error: 'earnings fetch failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/garch/:symbol
// Runs garch_model.py (252-day closes from Twelve Data → GARCH(1,1) fit),
// returns { regime: 'low_vol'|'high_vol'|'transitioning', forecast: <annualised vol %> }
// Only SPY is called by the frontend today (4th session bar indicator), but
// this works for any symbol Twelve Data covers.
// ---------------------------------------------------------------------------
app.get('/api/garch/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const tdKey = process.env.TWELVE_DATA_API_KEY;
  if (!tdKey) return res.status(503).json({ error: 'TWELVE_DATA_API_KEY not configured' });

  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&outputsize=252&apikey=${tdKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.values) throw new Error('no price history from Twelve Data');
    const closes = data.values.map(v => parseFloat(v.close)).reverse(); // oldest→newest

    const py = spawn('python3', [__dirname + '/garch_model.py']);
    let out = '', err = '';
    py.stdin.write(JSON.stringify({ closes }));
    py.stdin.end();
    py.stdout.on('data', d => out += d);
    py.stderr.on('data', d => err += d);
    py.on('close', code => {
      if (code !== 0) {
        console.error('garch_model.py failed:', err);
        return res.status(502).json({ error: 'garch calc failed' });
      }
      try {
        res.json(JSON.parse(out));
      } catch (e) {
        res.status(502).json({ error: 'garch output unparsable' });
      }
    });
  } catch (err) {
    console.error('garch fetch failed:', err.message);
    res.status(502).json({ error: 'garch fetch failed' });
  }
});
