#!/usr/bin/env node
/* ============================================================
   TVBT PRO — Robot Scanner 24/7 (forward-test / paper)
   Dijalankan oleh GitHub Actions (cron). Tanpa dependency,
   tanpa API key. Membaca data publik bursa, mendeteksi sinyal
   spike multi-timeframe (4h bias + 15m entry), melacak TP/SL
   posisi terbuka, lalu menulis hasil kumulatif ke data/*.json.

   Semua fungsi murni diekspor untuk pengujian (lihat akhir file).
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CFG_PATH = path.join(__dirname, 'config.json');

const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

/* ============================================================
   DATA PROVIDERS (fallback chain)
   - Binance punya data taker-buy (lebih akurat).
   - Bybit sebagai fallback bila Binance diblok region runner.
   ============================================================ */
async function httpJSON(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(to); }
}

const PROVIDERS = [
  {
    name: 'binance-vision',
    hasTaker: true,
    tf: t => t,
    async tickers(quote) {
      const arr = await httpJSON('https://data-api.binance.vision/api/v3/ticker/24hr');
      return arr.filter(x => x.symbol.endsWith(quote))
                .map(x => ({ symbol: x.symbol, quoteVolume: +x.quoteVolume }));
    },
    async klines(symbol, tf, limit) {
      const a = await httpJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`);
      return a.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closeT: +k[6], takerBase: +k[9] }));
    }
  },
  {
    name: 'binance',
    hasTaker: true,
    tf: t => t,
    async tickers(quote) {
      const arr = await httpJSON('https://api.binance.com/api/v3/ticker/24hr');
      return arr.filter(x => x.symbol.endsWith(quote))
                .map(x => ({ symbol: x.symbol, quoteVolume: +x.quoteVolume }));
    },
    async klines(symbol, tf, limit) {
      const a = await httpJSON(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`);
      return a.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closeT: +k[6], takerBase: +k[9] }));
    }
  },
  {
    name: 'bybit',
    hasTaker: false,
    tf: t => ({ '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' }[t] || '15'),
    async tickers(quote) {
      const r = await httpJSON('https://api.bybit.com/v5/market/tickers?category=spot');
      const list = (r && r.result && r.result.list) || [];
      return list.filter(x => x.symbol.endsWith(quote))
                 .map(x => ({ symbol: x.symbol, quoteVolume: +x.turnover24h }));
    },
    async klines(symbol, tf, limit) {
      const iv = this.tf(tf);
      const r = await httpJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&limit=${limit}`);
      const list = (r && r.result && r.result.list) || [];
      const ms = TF_MS[tf] || 900e3;
      // Bybit mengembalikan urutan terbaru->terlama; balik jadi terlama->terbaru
      return list.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closeT: +k[0] + ms - 1, takerBase: null }))
                 .sort((a, b) => a.t - b.t);
    }
  }
];

async function pickProvider(quote) {
  for (const p of PROVIDERS) {
    try {
      const t = await p.tickers(quote);
      if (t && t.length > 10) { console.log(`[provider] memakai: ${p.name} (${t.length} pair)`); return { provider: p, tickers: t }; }
    } catch (e) { console.log(`[provider] ${p.name} gagal: ${e.message}`); }
  }
  throw new Error('Semua provider gagal diakses (kemungkinan diblok region runner).');
}

/* ============================================================
   INDIKATOR (fungsi murni)
   ============================================================ */
function sma(arr, end, period) {
  if (end - period + 1 < 0) return null;
  let s = 0; for (let k = end - period + 1; k <= end; k++) s += arr[k];
  return s / period;
}
function ema(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function atrAt(candles, end, period) {
  if (end - period < 0) return null;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = p ? Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)) : c.h - c.l;
    s += tr;
  }
  return s / period;
}
function round6(x) { return Math.round(x * 1e6) / 1e6; }

/* ============================================================
   SELEKSI TOP-N BY VOLUME (fungsi murni)
   ============================================================ */
function filterTopN(tickers, cfg) {
  const exC = cfg.excludeContains || [];
  const exS = new Set(cfg.excludeSymbols || []);
  return tickers
    .filter(t => t.symbol.endsWith(cfg.quote))
    .filter(t => !exS.has(t.symbol))
    .filter(t => !exC.some(frag => t.symbol.includes(frag)))
    .filter(t => Number.isFinite(t.quoteVolume) && t.quoteVolume > 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, cfg.topN)
    .map(t => t.symbol);
}

/* ============================================================
   BIAS TIMEFRAME BESAR (4h) — fungsi murni
   ============================================================ */
function computeBias(bigCandles, emaPeriod) {
  // buang candle terakhir (in-progress)
  const closed = bigCandles.slice(0, -1);
  if (closed.length < 5) return { bias: 'neutral', ema: null, close: null };
  const closes = closed.map(c => c.c);
  const period = Math.min(emaPeriod, closes.length);
  const e = ema(closes, period);
  const last = closes[closes.length - 1];
  let bias = 'neutral';
  if (e) {
    if (last > e * 1.001) bias = 'long';
    else if (last < e * 0.999) bias = 'short';
  }
  return { bias, ema: e, close: last };
}

/* ============================================================
   DETEKSI SINYAL SPIKE (timeframe kecil 15m) — fungsi murni
   Mengembalikan {dir, entry, tp, sl, atr, candleT, candleCloseT, reasons} | null
   ============================================================ */
function detectSignal(smallCandles, strat, bias, hasTaker) {
  const arr = smallCandles.slice(0, -1); // pakai candle yang sudah close
  const i = arr.length - 1;
  const need = Math.max(strat.volLookback, strat.consolLookback, strat.atrPeriod) + 2;
  if (i < need) return null;

  const c = arr[i];
  const vols = arr.map(x => x.v);
  const volAvg = sma(vols, i - 1, strat.volLookback);
  if (!volAvg || volAvg <= 0) return null;
  const volRatio = c.v / volAvg;
  if (volRatio < strat.volMult) return null;

  // konsolidasi sebelum spike
  let wh = -Infinity, wl = Infinity;
  for (let k = i - strat.consolLookback; k < i; k++) { if (arr[k].h > wh) wh = arr[k].h; if (arr[k].l < wl) wl = arr[k].l; }
  const rangePct = wl > 0 ? (wh - wl) / wl * 100 : 999;
  if (rangePct > strat.consolPct) return null;

  const bodyPct = (c.c - c.o) / c.o * 100;
  const a = atrAt(arr, i, strat.atrPeriod);
  if (!a || a <= 0) return null;

  const takerRatio = (hasTaker && c.v > 0 && c.takerBase != null) ? c.takerBase / c.v : null;
  const longTaker = takerRatio == null ? true : takerRatio >= strat.takerRatio;
  const shortTaker = takerRatio == null ? true : takerRatio <= (1 - strat.takerRatio);

  let dir = null;
  const longOk = bodyPct >= strat.momPct && longTaker;
  const shortOk = bodyPct <= -strat.momPct && shortTaker;
  if ((strat.direction === 'both' || strat.direction === 'long') && longOk) dir = 'BUY';
  else if ((strat.direction === 'both' || strat.direction === 'short') && shortOk) dir = 'SELL';
  if (!dir) return null;

  // FILTER MULTI-TIMEFRAME: arah harus searah bias 4h
  if (bias === 'long' && dir !== 'BUY') return null;
  if (bias === 'short' && dir !== 'SELL') return null;
  if (bias === 'neutral') return null; // hanya entry saat trend 4h jelas

  const entry = c.c;
  const slDist = a * strat.atrMult;
  if (slDist <= 0) return null;
  const tp = dir === 'BUY' ? entry + slDist * strat.rr : entry - slDist * strat.rr;
  const sl = dir === 'BUY' ? entry - slDist : entry + slDist;

  return {
    dir, entry: round6(entry), tp: round6(tp), sl: round6(sl), atr: round6(a),
    candleT: c.t, candleCloseT: c.closeT,
    reasons: { volRatio: +volRatio.toFixed(2), bodyPct: +bodyPct.toFixed(2), takerRatio: takerRatio == null ? null : +takerRatio.toFixed(2), consolPct: +rangePct.toFixed(2), bias }
  };
}

/* ============================================================
   CEK EXIT POSISI TERBUKA (fungsi murni)
   ============================================================ */
function checkExit(pos, candles, maxHoldHours, nowMs) {
  // hanya candle yang close setelah posisi dibuka
  const fwd = candles.filter(c => c.closeT > pos.openCandleCloseT);
  let bars = 0;
  for (const c of fwd) {
    bars++;
    if (pos.dir === 'BUY') {
      if (c.l <= pos.sl) return done('SL', pos.sl, c.closeT, bars);
      if (c.h >= pos.tp) return done('TP', pos.tp, c.closeT, bars);
    } else {
      if (c.h >= pos.sl) return done('SL', pos.sl, c.closeT, bars);
      if (c.l <= pos.tp) return done('TP', pos.tp, c.closeT, bars);
    }
  }
  // timeout berdasarkan durasi
  const heldH = (nowMs - new Date(pos.openTime).getTime()) / 3600e3;
  if (heldH >= maxHoldHours && fwd.length) {
    const last = fwd[fwd.length - 1];
    return done('TIMEOUT', last.c, last.closeT, bars);
  }
  return null; // masih terbuka

  function done(hit, exit, exitCloseT, b) {
    const e = pos.entry;
    const pnl = pos.dir === 'BUY' ? (exit - e) / e * 100 : (e - exit) / e * 100;
    const status = hit === 'TP' ? 'TP' : hit === 'SL' ? 'SL' : (pnl >= 0 ? 'WIN' : 'LOSS');
    return { hit, status, exit: round6(exit), exitTime: new Date(exitCloseT).toISOString(), bars: b, pnl_pct: +pnl.toFixed(3) };
  }
}

/* ============================================================
   HITUNG STATISTIK KUMULATIF (fungsi murni)
   ============================================================ */
function computeStats(history, openPositions, watchlist, meta) {
  const total = history.length;
  const wins = history.filter(t => t.status === 'TP' || t.status === 'WIN');
  const losses = history.filter(t => t.status === 'SL' || t.status === 'LOSS');
  const pnls = history.map(t => t.pnl_pct || 0);
  const grossP = pnls.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const grossL = Math.abs(pnls.filter(x => x < 0).reduce((a, b) => a + b, 0));
  const net = grossP - grossL;
  const wr = total ? wins.length / total * 100 : 0;
  const pf = grossL > 0 ? grossP / grossL : (grossP > 0 ? 999 : 0);

  const byPair = {};
  history.forEach(t => {
    const p = byPair[t.pair] || (byPair[t.pair] = { trades: 0, wins: 0, net: 0 });
    p.trades++; if (t.status === 'TP' || t.status === 'WIN') p.wins++; p.net += t.pnl_pct || 0;
  });
  Object.values(byPair).forEach(p => { p.winrate = p.trades ? +(p.wins / p.trades * 100).toFixed(1) : 0; p.net = +p.net.toFixed(2); });

  const side = d => {
    const arr = history.filter(t => t.dir === d);
    const w = arr.filter(t => t.status === 'TP' || t.status === 'WIN').length;
    return { trades: arr.length, wins: w, winrate: arr.length ? +(w / arr.length * 100).toFixed(1) : 0 };
  };

  return {
    updatedAt: new Date().toISOString(),
    provider: meta.provider,
    bigTF: meta.bigTF,
    smallTF: meta.smallTF,
    since: total ? history[0].openTime : null,
    totalClosed: total,
    open: openPositions.length,
    wins: wins.length,
    losses: losses.length,
    winrate: +wr.toFixed(1),
    grossProfit: +grossP.toFixed(2),
    grossLoss: +grossL.toFixed(2),
    netReturn: +net.toFixed(2),
    profitFactor: pf > 999 ? 999 : +pf.toFixed(2),
    avgReturn: total ? +(pnls.reduce((a, b) => a + b, 0) / total).toFixed(3) : 0,
    bestPct: pnls.length ? +Math.max(...pnls).toFixed(2) : 0,
    worstPct: pnls.length ? +Math.min(...pnls).toFixed(2) : 0,
    byPair,
    bySide: { BUY: side('BUY'), SELL: side('SELL') },
    watchlist
  };
}

/* ============================================================
   I/O HELPERS
   ============================================================ */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   MAIN
   ============================================================ */
async function main() {
  const cfg = readJSON(CFG_PATH, {});
  const strat = cfg.strategy || {};
  const nowMs = Date.now();
  console.log(`[start] ${new Date().toISOString()} — top${cfg.topN} ${cfg.quote}, ${cfg.bigTF}+${cfg.smallTF}`);

  const { provider, tickers } = await pickProvider(cfg.quote);
  const watchlist = filterTopN(tickers, cfg);
  console.log(`[watchlist] ${watchlist.length} pair: ${watchlist.join(', ')}`);

  const state = readJSON(path.join(DATA_DIR, 'state.json'), { open: [] });
  const history = readJSON(path.join(DATA_DIR, 'history.json'), []);
  let open = Array.isArray(state.open) ? state.open : [];

  /* 1) UPDATE POSISI TERBUKA -> cek TP/SL */
  const stillOpen = [];
  for (const pos of open) {
    try {
      const sc = await provider.klines(pos.pair, cfg.smallTF, 200);
      await sleep(120);
      const ex = checkExit(pos, sc, strat.maxHoldHours, nowMs);
      if (ex) {
        const closed = {
          ...pos, status: ex.status, exit: ex.exit, exitTime: ex.exitTime,
          bars: ex.bars, pnl_pct: ex.pnl_pct, closedBy: ex.hit
        };
        history.push(closed);
        console.log(`[close] ${pos.pair} ${pos.dir} -> ${ex.status} ${ex.pnl_pct}% (${ex.hit})`);
      } else {
        stillOpen.push(pos);
      }
    } catch (e) {
      console.log(`[lifecycle] ${pos.pair} gagal: ${e.message}`);
      stillOpen.push(pos); // pertahankan jika gagal fetch
    }
  }
  open = stillOpen;

  /* 2) DETEKSI SINYAL BARU untuk tiap pair di watchlist */
  const openPairs = new Set(open.map(p => p.pair));
  const cooldownMs = (strat.cooldownBars || 0) * (TF_MS[cfg.smallTF] || 900e3);
  for (const sym of watchlist) {
    if (openPairs.has(sym)) continue; // satu posisi per pair
    // cooldown: lewati bila baru saja close di pair ini
    const lastClose = history.filter(t => t.pair === sym).map(t => new Date(t.exitTime).getTime()).sort((a, b) => b - a)[0];
    if (lastClose && (nowMs - lastClose) < cooldownMs) continue;

    try {
      const big = await provider.klines(sym, cfg.bigTF, Math.max((cfg.biasEmaPeriod || 50) + 30, 120));
      await sleep(120);
      const { bias } = computeBias(big, cfg.biasEmaPeriod || 50);
      if (bias === 'neutral') continue;

      const small = await provider.klines(sym, cfg.smallTF, 200);
      await sleep(120);
      const sig = detectSignal(small, strat, bias, provider.hasTaker);
      if (!sig) continue;

      const pos = {
        id: `${sym}-${sig.candleCloseT}`,
        pair: sym, dir: sig.dir,
        entry: sig.entry, tp: sig.tp, sl: sig.sl, atr: sig.atr,
        openTime: new Date(sig.candleCloseT).toISOString(),
        openCandleCloseT: sig.candleCloseT,
        bias, provider: provider.name,
        bigTF: cfg.bigTF, smallTF: cfg.smallTF,
        reasons: sig.reasons, status: 'OPEN'
      };
      open.push(pos);
      openPairs.add(sym);
      console.log(`[open]  ${sym} ${sig.dir} entry=${sig.entry} tp=${sig.tp} sl=${sig.sl} (bias ${bias})`);
    } catch (e) {
      console.log(`[detect] ${sym} gagal: ${e.message}`);
    }
  }

  /* 3) SIMPAN */
  const stats = computeStats(history, open, watchlist, { provider: provider.name, bigTF: cfg.bigTF, smallTF: cfg.smallTF });
  writeJSON(path.join(DATA_DIR, 'history.json'), history);
  writeJSON(path.join(DATA_DIR, 'state.json'), { updatedAt: stats.updatedAt, provider: provider.name, open });
  writeJSON(path.join(DATA_DIR, 'stats.json'), stats);
  console.log(`[done] open=${open.length} closed=${history.length} winrate=${stats.winrate}% net=${stats.netReturn}%`);
}

/* ============================================================
   EKSPOR untuk pengujian + jalankan bila dipanggil langsung
   ============================================================ */
module.exports = {
  TF_MS, sma, ema, atrAt, round6,
  filterTopN, computeBias, detectSignal, checkExit, computeStats,
  PROVIDERS
};

if (require.main === module) {
  main().catch(e => { console.error('[fatal]', e.message); process.exit(1); });
}
