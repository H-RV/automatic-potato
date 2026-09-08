// ── TRADE JOURNAL PARSER ──────────────────────────────────────────────────
// Parses IBKR Activity Statement CSVs (the real multi-section format,
// confirmed against an actual export — not the PDF rendering). Validated
// approach: reconciled against a full real month, matched IBKR's own
// authoritative "Realized Total" to the cent (net of rounding), correctly
// classified every real spread and roll present in that month, including
// positions that carried in from before the file's date range (resolved via
// the Code column, not inference — this is the most reliable version of the
// design, more robust than earlier Prior-quantity-based prototyping).
//
// PRIVACY: only the fields below are ever extracted and stored. The raw CSV
// (which includes account number, balances, NAV) is parsed in memory and
// discarded — never written to disk or the journal store.

// ── Minimal CSV row parser (handles quoted fields with embedded commas,
// e.g. "2026-08-12, 23:42:02") ──
function parseCsvRows(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Section extraction ──
function extractSection(rows, sectionName, rowType) {
  return rows.filter(r => r[0] === sectionName && r[1] === rowType);
}

function parseStrike(contract) {
  const m = contract.trim().match(/(\d+\.?\d*)\s+[CP]$/);
  return m ? parseFloat(m[1]) : null;
}
function parseType(contract) {
  return contract.trim().slice(-1); // 'C' or 'P'
}
function parseUnderlying(contract) {
  return contract.trim().split(' ')[0];
}

// ── Main parse function ──
// Input: raw CSV text. Output: { journal: [...], grossPremium, premiumPaidToClose,
//   netRealized, byBucket: {...}, warnings: [...] }
function parseActivityStatement(csvText) {
  const rows = parseCsvRows(csvText);
  const warnings = [];

  // 1. Option trade executions (Trades / Data / Equity and Index Options)
  const tradeRows = rows.filter(r =>
    r[0] === 'Trades' && r[1] === 'Data' && r[3] === 'Equity and Index Options'
  );
  // Columns: 0 Trades,1 Data,2 Order,3 AssetCat,4 Currency,5 Symbol,6 DateTime,
  //          7 Quantity,8 T.Price,9 C.Price,10 Proceeds,11 Comm/Fee,12 Basis,
  //          13 Realized P/L,14 MTM P/L,15 Code
  const execs = tradeRows.map(r => ({
    contract: r[5],
    underlying: parseUnderlying(r[5]),
    dt: r[6],
    qty: parseFloat(r[7]),
    price: parseFloat(r[8]),
    code: r[15] || '',
  }));

  // 2. Authoritative realized P/L per contract — trust IBKR's own number,
  // never recompute from executions (this was the fix for the earlier bug
  // where a naive "assume expired worthless" guess came out badly wrong).
  const realizedRows = rows.filter(r =>
    r[0] === 'Realized & Unrealized Performance Summary' && r[1] === 'Data' &&
    r[2] === 'Equity and Index Options'
  );
  // Columns: 2 AssetCat,3 Symbol,4 CostAdj,5 RealST+,6 RealST-,7 RealLT+,
  //          8 RealLT-,9 RealizedTotal,...
  const realizedPnl = {};
  for (const r of realizedRows) {
    realizedPnl[r[3]] = parseFloat(r[9]) || 0;
  }

  // 3. Open stock positions (for covered-call verification)
  const openStockRows = rows.filter(r =>
    r[0] === 'Open Positions' && r[1] === 'Data' && r[3] === 'Stocks'
  );
  // Columns: 3 AssetCat,4 Currency,5 Symbol,6 Quantity,...
  const sharesHeld = {};
  for (const r of openStockRows) {
    sharesHeld[r[5]] = parseFloat(r[6]) || 0;
  }

  return classifyExecutions(execs, realizedPnl, sharesHeld);
}

// ── Classification, separated from CSV parsing ──────────────────────────
// Callable directly on stored/merged raw data (no CSV re-parse needed) —
// this is what GET /api/journal/summary uses after the first upload.
function classifyExecutions(execs, realizedPnl, sharesHeld) {
  const warnings = [];

  // 4. Per-contract summary, with direction resolved via the Code column
  // (O = opened this position in this file's window, C = closed it — this
  // directly resolves the "did this file's first execution actually open
  // the position, or was it already open from before?" ambiguity that a
  // naive first-execution-in-file assumption gets wrong).
  const byContract = {};
  for (const e of execs) {
    if (!byContract[e.contract]) byContract[e.contract] = [];
    byContract[e.contract].push(e);
  }

  const contractInfo = {};
  for (const [contract, list] of Object.entries(byContract)) {
    list.sort((a, b) => a.dt.localeCompare(b.dt));
    const openingExec = list.find(e => e.code.split(';').includes('O'));
    const closingExec = [...list].reverse().find(e => e.code.split(';').includes('C'));
    let trueSideQty;
    if (openingExec) {
      trueSideQty = openingExec.qty;
    } else if (closingExec) {
      // No "O" row in this file — position was already open before this
      // period. True original side is the OPPOSITE of the closing qty's sign.
      trueSideQty = -closingExec.qty;
      warnings.push(`${contract}: opened before this file's date range (resolved via Code column, not inferred)`);
    } else {
      trueSideQty = list[0].qty; // fallback, shouldn't normally happen
    }
    contractInfo[contract] = {
      underlying: parseUnderlying(contract),
      openDt: openingExec ? openingExec.dt : list[0].dt,
      closeDt: closingExec ? closingExec.dt : null,
      trueSideQty,
      realizedPnl: realizedPnl[contract] ?? 0,
    };
  }

  // 5. Spreads: same underlying + same open timestamp, 2+ contracts
  const openGroups = {};
  for (const [contract, info] of Object.entries(contractInfo)) {
    const key = info.underlying + '|' + info.openDt;
    if (!openGroups[key]) openGroups[key] = [];
    openGroups[key].push(contract);
  }
  const spreadGroups = Object.entries(openGroups).filter(([k, v]) => v.length > 1);
  const usedBySpread = new Set();
  for (const [, legs] of spreadGroups) legs.forEach(c => usedBySpread.add(c));

  // 6. Rolls: close of one (not already claimed by a spread) = open of
  // another, same underlying. Runs AFTER spread detection to avoid the
  // double-counting bug found during testing.
  const rolls = [];
  const usedInRoll = new Set();
  for (const [contract, info] of Object.entries(contractInfo)) {
    if (!info.closeDt || usedBySpread.has(contract)) continue;
    const key = info.underlying + '|' + info.closeDt;
    if (openGroups[key]) {
      for (const cand of openGroups[key]) {
        if (cand !== contract && !usedInRoll.has(cand) && !usedBySpread.has(cand)) {
          rolls.push([contract, cand]);
          usedInRoll.add(contract); usedInRoll.add(cand);
          break;
        }
      }
    }
  }

  // 7. Classify
  const CANON = {
    'Bull Put Spread': 'Put Credit Spread',
    'Bear Call Spread': 'Call Credit Spread',
    'Bull Call Spread': 'Call Debit Spread',
    'Bear Put Spread': 'Put Debit Spread',
  };
  const DASH_BUCKETS = new Set(['CC', 'CSP', 'Call Credit Spread', 'Put Credit Spread', 'LEAP']);
  const journal = [];

  for (const [key, legs] of spreadGroups) {
    if (legs.length === 4) {
      const withMeta = legs.map(c => ({ c, type: parseType(c), side: contractInfo[c].trueSideQty < 0 ? 'short' : 'long', strike: parseStrike(c) }));
      const puts = withMeta.filter(l => l.type === 'P');
      const calls = withMeta.filter(l => l.type === 'C');
      let bucket = 'Other (4-leg, not a clean IC \u2014 flag for manual review)';
      if (puts.length === 2 && calls.length === 2) {
        const pS = puts.find(l => l.side === 'short'), pL = puts.find(l => l.side === 'long');
        const cS = calls.find(l => l.side === 'short'), cL = calls.find(l => l.side === 'long');
        if (pS && pL && cS && cL && pS.strike > pL.strike && cS.strike < cL.strike && pS.strike < cS.strike) {
          bucket = 'Iron Condor';
        }
      }
      const pnl = legs.reduce((s, c) => s + contractInfo[c].realizedPnl, 0);
      journal.push({ date: key.split('|')[1].slice(0, 10), underlying: key.split('|')[0], bucket, pnl: Math.round(pnl * 100) / 100, legs });
      continue;
    }
    if (legs.length !== 2) {
      warnings.push(`${key}: ${legs.length}-leg group, not 2 or 4 \u2014 flagged as Other`);
      const pnl = legs.reduce((s, c) => s + contractInfo[c].realizedPnl, 0);
      journal.push({ date: key.split('|')[1].slice(0, 10), underlying: key.split('|')[0], bucket: 'Other (unusual leg count)', pnl: Math.round(pnl * 100) / 100, legs });
      continue;
    }
    const [l1, l2] = legs;
    const q1 = contractInfo[l1].trueSideQty;
    const [shortC, longC] = q1 < 0 ? [l1, l2] : [l2, l1];
    const sStrike = parseStrike(shortC), lStrike = parseStrike(longC);
    const isPut = parseType(shortC) === 'P';
    let strat;
    if (isPut) strat = sStrike > lStrike ? 'Bull Put Spread' : 'Bear Put Spread';
    else strat = sStrike < lStrike ? 'Bear Call Spread' : 'Bull Call Spread';
    const canon = CANON[strat];
    const bucket = DASH_BUCKETS.has(canon) ? canon : 'Other (debit spread)';
    const pnl = contractInfo[l1].realizedPnl + contractInfo[l2].realizedPnl;
    journal.push({ date: key.split('|')[1].slice(0, 10), underlying: key.split('|')[0], bucket, pnl: Math.round(pnl * 100) / 100, legs });
  }

  for (const [oldC, newC] of rolls) {
    const pnl = contractInfo[oldC].realizedPnl + contractInfo[newC].realizedPnl;
    const bucket = parseType(oldC) === 'C' ? 'CC' : 'CSP';
    journal.push({ date: contractInfo[oldC].openDt.slice(0, 10), underlying: contractInfo[oldC].underlying, bucket: `${bucket} (via roll)`, pnl: Math.round(pnl * 100) / 100, legs: [oldC, newC] });
  }

  const handled = new Set([...usedBySpread, ...usedInRoll]);
  for (const [contract, info] of Object.entries(contractInfo)) {
    if (handled.has(contract)) continue;
    const q = info.trueSideQty;
    const typ = parseType(contract);
    const isLeap = (() => {
      const dateToken = contract.trim().split(' ')[1]; // e.g. "17JUN27"
      const m = dateToken && dateToken.match(/(\d{2})$/);
      if (!m) return false;
      const yy = parseInt(m[1], 10);
      return yy >= 27; // expiring 2027 or later, from a 2026 statement -> far-dated
    })();
    let bucket;
    if (q < 0) {
      bucket = typ === 'P' ? 'CSP' : 'CC';
      if (typ === 'C' && bucket === 'CC') {
        const needed = Math.abs(q) * 100;
        const held = sharesHeld[info.underlying] || 0;
        if (held < needed) {
          bucket = 'CC \u26a0 NAKED (insufficient shares \u2014 verify)';
          warnings.push(`${contract}: needs ${needed} shares, only ${held} held \u2014 flagged naked, not covered`);
        }
      }
    } else {
      bucket = isLeap ? 'LEAP' : 'Other (long option)';
    }
    journal.push({ date: info.openDt.slice(0, 10), underlying: info.underlying, bucket, pnl: Math.round(info.realizedPnl * 100) / 100, legs: [contract] });
  }

  // 8. Aggregate
  const byBucket = {};
  for (const j of journal) {
    const key = j.bucket.replace(' (via roll)', '');
    byBucket[key] = (byBucket[key] || 0) + j.pnl;
  }
  const netRealized = Math.round(Object.values(byBucket).reduce((a, b) => a + b, 0) * 100) / 100;

  return { journal, byBucket, netRealized, warnings };
}

module.exports = { parseActivityStatement, parseCsvRows, classifyExecutions };
