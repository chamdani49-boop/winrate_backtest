#!/usr/bin/env node
/* ============================================================
   TVBT PRO — Robot Scanner 24/7 (forward-test / paper)
   Dijalankan oleh GitHub Actions (cron). Tanpa dependency,
   tanpa API key. Membaca data publik bursa, mendeteksi sinyal
   spike multi-timeframe (4h bias + 15m entry), melacak target
   berlapis TP1/TP2/TP3 + trailing stop, lalu menulis hasil
   kumulatif ke data/*.json.

   Model exit: STAGED — tiap TP menutup 1/3 posisi.
     TP1 kena -> SL pindah ke entry (breakeven)
     TP2 kena -> SL pindah ke TP1
     TP3 kena -> posisi tutup penuh (full win)
   PnL akhir = jumlah kontribusi tiap bagian (1/3) yang terealisasi.

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
    async tickers(quote) {
      const arr = await httpJSON('https://data-api.binance.vision/api/v3/ticker/24hr');
      return arr.filter(x => x.symbol.endsWith(quote)).map(x => ({ symbol: x.symbol, quoteVolume: +x.quoteVolume }));
    },
    async klines(symbol, tf, limit) {
      const a = await httpJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`);
      return a.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closeT: +k[6], takerBase: +k[9] }));
    }
  },
  {
    name: 'binance',
    hasTaker: true,
    async tickers(quote) {
      const arr = await httpJSON('https://api.binance.com/api/v3/ticker/24hr');
      return arr.filter(x => x.symbol.endsWith(quote)).map(x => ({ symbol: x.symbol, quoteVolume: +x.quoteVolume }));
    },
    async klines(symbol, tf, limit) {
      const a = await httpJSON(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`);
      return a.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closeT: +k[6], takerBase: +k[9] }));
    }
  },
  {
    name: 'bybit',
    hasTaker: false,
    bybitTF: t => ({ '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' }[t] || '15'),
    async tickers(quote) {
      const r = await httpJSON('https://api.bybit.com/v5/market/tickers?category=spot');
      const list = (r && r.result && r.result.list) || [];
      return list.filter(x => x.symbol.endsWith(quote)).map(x => ({ symbol: x.symbol, quoteVolume: +x.turnover24h }));
    },
    async klines(symbol, tf, limit) {
      const iv = this.bybitTF(tf);
      const r = await httpJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&limit=${limit}`);
      const list = (r && r.result && r.result.list) || [];
      const ms = TF_MS[tf] || 900e3;
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
function pnlPctAt(dir, entry, price) { return dir === 'BUY' ? (price - entry) / entry * 100 : (entry - price) / entry * 100; }

/* RSI Wilder */
function rsi(values, period) {
  if (!values || values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - (100 / (1 + rs));
}

/* EMA series untuk MACD */
function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function macdState(closes, fast = 12, slow = 26, sig = 9) {
  if (closes.length < slow + sig + 2) return { state: null, hist: null, histPrev: null };
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const line = ef.map((v, i) => v - es[i]).slice(slow - 1);
  const signal = emaSeries(line, sig);
  const hist = line.map((v, i) => v - signal[i]);
  const h = hist[hist.length - 1], hp = hist[hist.length - 2];
  let state = 'flat';
  if (h > 0 && h >= hp) state = 'rising';
  else if (h > 0 && h < hp) state = 'fading_up';
  else if (h < 0 && h <= hp) state = 'falling';
  else if (h < 0 && h > hp) state = 'fading_down';
  return { state, hist: h, histPrev: hp };
}

/* trend dari rangkaian close vs EMA */
function trendOf(candles, period) {
  const closed = candles.slice(0, -1);
  if (closed.length < 5) return 'RANGE';
  const closes = closed.map(c => c.c);
  const e = ema(closes, Math.min(period, closes.length));
  const last = closes[closes.length - 1];
  if (e == null) return 'RANGE';
  if (last > e * 1.002) return 'UPTREND';
  if (last < e * 0.998) return 'DOWNTREND';
  return 'RANGE';
}

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
  const closed = bigCandles.slice(0, -1); // buang candle in-progress
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
   LABEL STRATEGI
   ============================================================ */
function strategyLabel(dir) {
  return dir === 'BUY'
    ? { code: 'PRE_PUMP', name: 'Spike Pre-Pump · trend 4H naik + volume spike 15M', short: 'PRE-PUMP' }
    : { code: 'PRE_DUMP', name: 'Spike Pre-Dump · trend 4H turun + volume spike 15M', short: 'PRE-DUMP' };
}

/* ============================================================
   INTEL & VALIDITY (terinspirasi format CryptoSpike)
   Skor 0-100 → STRONG (>=75) / MODERATE (50-74) / WEAK (<50)
   ============================================================ */
function buildIntel(ctx) {
  const { dir, smallCandles, big4h, hourly1h, daily1d, volRatio, takerRatio, rsi15, macd15, ma200State, structure } = ctx;
  const t4h = trendOf(big4h, 50);
  const t1h = hourly1h && hourly1h.length ? trendOf(hourly1h, 50) : 'RANGE';
  const td  = daily1d && daily1d.length ? trendOf(daily1d, 50) : 'RANGE';
  const tw  = daily1d && daily1d.length >= 7
    ? (() => {
        const wk = []; for (let i = 0; i < daily1d.length; i += 7) {
          const seg = daily1d.slice(i, i + 7); if (seg.length) wk.push({ c: seg[seg.length - 1].c });
        }
        return trendOf(wk.map(w => ({ ...w })), Math.min(20, wk.length));
      })()
    : 'RANGE';

  const reasons = [];
  const isLong = dir === 'BUY';
  let score = 0;

  // Volume spike strength (max 25)
  const vBase = Math.min(25, Math.max(0, (volRatio - 1) * 8));
  score += vBase; reasons.push(`Vol ${volRatio.toFixed(1)}x ${volRatio >= 3 ? 'heavy' : ''}`.trim());

  // MTF alignment (max 30): D + 4H + 1H searah
  const align = [td, t4h, t1h].filter(t => isLong ? t === 'UPTREND' : t === 'DOWNTREND').length;
  score += align * 10; reasons.push(`Daily ${td.toLowerCase()}`); reasons.push(`4H ${t4h.toLowerCase()}`); reasons.push(`1H ${t1h.toLowerCase()}`);

  // RSI (max 15): pre-pump → RSI rendah (oversold reload) atau menanjak; pre-dump → RSI tinggi/jatuh
  if (rsi15 != null) {
    if (isLong) {
      if (rsi15 <= 35) { score += 15; reasons.push(`RSI ${rsi15.toFixed(0)} oversold`); }
      else if (rsi15 <= 55) { score += 10; reasons.push(`RSI ${rsi15.toFixed(0)} netral-naik`); }
      else { score += 3; reasons.push(`RSI ${rsi15.toFixed(0)} sudah tinggi`); }
    } else {
      if (rsi15 >= 65) { score += 15; reasons.push(`RSI ${rsi15.toFixed(0)} overbought`); }
      else if (rsi15 >= 45) { score += 10; reasons.push(`RSI ${rsi15.toFixed(0)} netral-turun`); }
      else { score += 3; reasons.push(`RSI ${rsi15.toFixed(0)} sudah rendah`); }
    }
  }

  // MACD (max 10)
  if (macd15 && macd15.state) {
    const goodLong = ['rising', 'fading_down'];
    const goodShort = ['falling', 'fading_up'];
    if ((isLong && goodLong.includes(macd15.state)) || (!isLong && goodShort.includes(macd15.state))) {
      score += 10; reasons.push(`MACD ${macd15.state}`);
    } else { reasons.push(`MACD ${macd15.state}`); }
  }

  // MA200 (max 10)
  if (ma200State) {
    if ((isLong && ma200State === 'ABOVE') || (!isLong && ma200State === 'BELOW')) {
      score += 10; reasons.push(`${ma200State} MA200`);
    } else { reasons.push(`${ma200State} MA200`); }
  }

  // Taker (max 10)
  if (takerRatio != null) {
    if (isLong && takerRatio >= 0.6) { score += 10; reasons.push(`Taker buy ${(takerRatio*100).toFixed(0)}%`); }
    else if (!isLong && takerRatio <= 0.4) { score += 10; reasons.push(`Taker sell ${((1-takerRatio)*100).toFixed(0)}%`); }
    else { score += 4; reasons.push(`Taker ${(takerRatio*100).toFixed(0)}%`); }
  }

  score = Math.min(100, Math.round(score));
  const validity = score >= 75 ? 'STRONG' : score >= 50 ? 'MODERATE' : 'WEAK';
  const positionSize = validity === 'STRONG' ? '1-2% (Standard)' : validity === 'MODERATE' ? '0.5-1% (Conservative)' : '0.25-0.5% (Minimal)';
  const holdDuration = '4-12 jam (max 48 jam)';
  const management = 'TP1 hit: SL pindah ke breakeven. TP2 hit: tutup 50%, trail sisanya. Biarkan TP3 berkembang.';

  return {
    score, validity, positionSize, holdDuration, management,
    mtf: { D: td, W: tw, '4H': t4h, '1H': t1h },
    rsi: rsi15 != null ? +rsi15.toFixed(1) : null,
    macd: macd15 ? macd15.state : null,
    ma200: ma200State || null,
    structure: structure || (align >= 2 ? (isLong ? 'BULLISH' : 'BEARISH') : 'NEUTRAL'),
    reasons
  };
}

/* ============================================================
   DETEKSI SINYAL SPIKE (timeframe kecil 15m) — fungsi murni
   Mengembalikan objek sinyal {dir, entry, sl, tp1, tp2, tp3, atr,
   strategy, strategyName, candleT, candleCloseT, reasons} | null
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

  // FILTER MULTI-TIMEFRAME: arah harus searah bias 4h, hanya entry saat trend jelas
  if (bias === 'neutral') return null;
  if (bias === 'long' && dir !== 'BUY') return null;
  if (bias === 'short' && dir !== 'SELL') return null;

  const entry = c.c;
  const slDist = a * strat.atrMult;
  if (slDist <= 0) return null;
  const tpR = Array.isArray(strat.tpR) && strat.tpR.length === 3 ? strat.tpR : [1, 2, 3];
  const lvl = r => dir === 'BUY' ? entry + slDist * r : entry - slDist * r;
  const sl = dir === 'BUY' ? entry - slDist : entry + slDist;
  const lab = strategyLabel(dir);

  return {
    dir, entry: round6(entry), sl: round6(sl),
    tp1: round6(lvl(tpR[0])), tp2: round6(lvl(tpR[1])), tp3: round6(lvl(tpR[2])),
    tpRR: tpR.slice(),
    atr: round6(a), atrPct: +(a / entry * 100).toFixed(2),
    strategy: lab.code, strategyName: lab.name, strategyShort: lab.short,
    candleT: c.t, candleCloseT: c.closeT, candleClose: c.c,
    raw: { volRatio: +volRatio.toFixed(2), bodyPct: +bodyPct.toFixed(2), takerRatio: takerRatio == null ? null : +takerRatio.toFixed(3), consolPct: +rangePct.toFixed(2), bias },
    reasons: { volRatio: +volRatio.toFixed(2), bodyPct: +bodyPct.toFixed(2), takerRatio: takerRatio == null ? null : +takerRatio.toFixed(2), consolPct: +rangePct.toFixed(2), bias }
  };
}

/* ============================================================
   ADVANCE POSISI (staged TP/SL + trailing) — fungsi murni
   Memproses HANYA candle baru sejak terakhir dicek (idempoten).
   Memutasi `pos` dan mengembalikan {closed, closedBy, exitPrice, exitTime}.
   ============================================================ */
function advancePosition(pos, candles, nowMs, strat) {
  // defaults / migrasi aman
  pos.tpHits = pos.tpHits || [];
  if (pos.remaining == null) pos.remaining = 1;
  pos.realizedPct = pos.realizedPct || 0;
  if (pos.checkFromCloseT == null) pos.checkFromCloseT = pos.openCandleCloseT;
  pos.bars = pos.bars || 0;
  const portion = 1 / 3;
  const trailing = strat.trailing !== false;

  const newC = candles
    .filter(c => c.closeT > pos.checkFromCloseT && c.closeT <= nowMs)
    .sort((a, b) => a.closeT - b.closeT);

  let closed = false, closedBy = null, exitPrice = null, exitTime = null;

  for (const c of newC) {
    pos.checkFromCloseT = c.closeT;
    pos.bars++;

    // 1) SL dulu (konservatif)
    const hitSL = pos.dir === 'BUY' ? c.l <= pos.sl : c.h >= pos.sl;
    if (hitSL) {
      pos.realizedPct += pnlPctAt(pos.dir, pos.entry, pos.sl) * pos.remaining;
      pos.remaining = 0; closed = true; closedBy = 'SL'; exitPrice = pos.sl; exitTime = c.closeT; break;
    }
    // 2) TP1
    if (!pos.tpHits.includes('TP1')) {
      const hit = pos.dir === 'BUY' ? c.h >= pos.tp1 : c.l <= pos.tp1;
      if (hit) {
        pos.realizedPct += pnlPctAt(pos.dir, pos.entry, pos.tp1) * portion;
        pos.tpHits.push('TP1'); pos.remaining = Math.max(0, +(pos.remaining - portion).toFixed(6));
        if (trailing) pos.sl = pos.entry; // breakeven
      }
    }
    // 3) TP2
    if (!pos.tpHits.includes('TP2')) {
      const hit = pos.dir === 'BUY' ? c.h >= pos.tp2 : c.l <= pos.tp2;
      if (hit) {
        pos.realizedPct += pnlPctAt(pos.dir, pos.entry, pos.tp2) * portion;
        pos.tpHits.push('TP2'); pos.remaining = Math.max(0, +(pos.remaining - portion).toFixed(6));
        if (trailing) pos.sl = pos.tp1;
      }
    }
    // 4) TP3 -> tutup penuh
    if (!pos.tpHits.includes('TP3')) {
      const hit = pos.dir === 'BUY' ? c.h >= pos.tp3 : c.l <= pos.tp3;
      if (hit) {
        pos.realizedPct += pnlPctAt(pos.dir, pos.entry, pos.tp3) * portion;
        pos.tpHits.push('TP3'); pos.remaining = 0; closed = true; closedBy = 'TP3'; exitPrice = pos.tp3; exitTime = c.closeT; break;
      }
    }
    // 5) timeout
    const heldH = (nowMs - new Date(pos.openTime).getTime()) / 3600e3;
    if (heldH >= strat.maxHoldHours) {
      pos.realizedPct += pnlPctAt(pos.dir, pos.entry, c.c) * pos.remaining;
      pos.remaining = 0; closed = true; closedBy = 'TIMEOUT'; exitPrice = c.c; exitTime = c.closeT; break;
    }
  }
  return { closed, closedBy, exitPrice, exitTime };
}

/* ============================================================
   HITUNG STATISTIK KUMULATIF (fungsi murni)
   ============================================================ */
function computeStats(history, openPositions, watchlist, meta) {
  const total = history.length;
  const wins = history.filter(t => (t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'WIN');
  const losses = history.filter(t => (t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'LOSS');
  const pnls = history.map(t => t.pnl_pct || 0);
  const grossP = pnls.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const grossL = Math.abs(pnls.filter(x => x < 0).reduce((a, b) => a + b, 0));
  const net = grossP - grossL;
  const wr = total ? wins.length / total * 100 : 0;
  const pf = grossL > 0 ? grossP / grossL : (grossP > 0 ? 999 : 0);

  const tpCounts = { TP1: 0, TP2: 0, TP3: 0 };
  history.forEach(t => (t.tpHits || []).forEach(h => { if (tpCounts[h] != null) tpCounts[h]++; }));

  const byPair = {};
  history.forEach(t => {
    const p = byPair[t.pair] || (byPair[t.pair] = { trades: 0, wins: 0, net: 0 });
    p.trades++; if ((t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'WIN') p.wins++; p.net += t.pnl_pct || 0;
  });
  Object.values(byPair).forEach(p => { p.winrate = p.trades ? +(p.wins / p.trades * 100).toFixed(1) : 0; p.net = +p.net.toFixed(2); });

  const side = d => {
    const arr = history.filter(t => t.dir === d);
    const w = arr.filter(t => (t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'WIN').length;
    return { trades: arr.length, wins: w, winrate: arr.length ? +(w / arr.length * 100).toFixed(1) : 0 };
  };

  // floating unrealized dari snapshot lastPrice
  let openFloatingPct = 0;
  openPositions.forEach(p => {
    const lp = p.lastPrice != null ? p.lastPrice : p.entry;
    openFloatingPct += (p.realizedPct || 0) + pnlPctAt(p.dir, p.entry, lp) * (p.remaining != null ? p.remaining : 1);
  });

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
    tpCounts,
    openFloatingPct: +openFloatingPct.toFixed(2),
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
function lastClosed(candles, nowMs) {
  const cl = candles.filter(c => c.closeT <= nowMs);
  return cl.length ? cl[cl.length - 1] : (candles.length ? candles[candles.length - 1] : null);
}

/* ============================================================
   BANGUN ENTRI HISTORI dari posisi yang baru ditutup
   ============================================================ */
function buildHistoryEntry(pos, ev) {
  const pnl = +(pos.realizedPct || 0).toFixed(3);
  return {
    id: pos.id, pair: pos.pair, dir: pos.dir,
    strategy: pos.strategy, strategyName: pos.strategyName, strategyShort: pos.strategyShort,
    entry: pos.entry, slInit: pos.slInit, tp1: pos.tp1, tp2: pos.tp2, tp3: pos.tp3, tpRR: pos.tpRR,
    openTime: pos.openTime, exitTime: new Date(ev.exitTime).toISOString(),
    exit: round6(ev.exitPrice), bars: pos.bars,
    tpHits: pos.tpHits.slice(), closedBy: ev.closedBy,
    pnl_pct: pnl, result: pnl >= 0 ? 'WIN' : 'LOSS',
    bias: pos.bias, intel: pos.intel, reasons: pos.reasons
  };
}

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

  /* 1) UPDATE POSISI TERBUKA -> staged TP/SL + trailing */
  const stillOpen = [];
  const events = readJSON(path.join(DATA_DIR, 'events.json'), []);
  const pushEv = (ev) => events.push({ ...ev, ts: new Date().toISOString() });

  for (const pos of open) {
    try {
      const sc = await provider.klines(pos.pair, cfg.smallTF, 200);
      await sleep(120);
      const hitsBefore = (pos.tpHits || []).slice();
      const ev = advancePosition(pos, sc, nowMs, strat);
      const lc = lastClosed(sc, nowMs);
      if (lc) { pos.lastPrice = lc.c; pos.lastPriceTime = new Date(lc.closeT).toISOString(); }
      // event: TP baru kena
      (pos.tpHits || []).filter(h => !hitsBefore.includes(h)).forEach(hit =>
        pushEv({ type: 'tp_hit', pair: pos.pair, dir: pos.dir, hit, price: pos[hit.toLowerCase()] || null })
      );
      if (ev.closed) {
        const entry = buildHistoryEntry(pos, ev);
        history.push(entry);
        pushEv({ type: 'closed', pair: pos.pair, dir: pos.dir, closedBy: ev.closedBy, pnl_pct: entry.pnl_pct, result: entry.result });
        console.log(`[close] ${pos.pair} ${pos.dir} -> ${ev.closedBy} TP:[${pos.tpHits.join(',')}] ${pos.realizedPct.toFixed(2)}%`);
      } else {
        stillOpen.push(pos);
      }
    } catch (e) {
      console.log(`[lifecycle] ${pos.pair} gagal: ${e.message}`);
      stillOpen.push(pos);
    }
  }
  open = stillOpen;

  /* 2) DETEKSI SINYAL BARU */
  const openPairs = new Set(open.map(p => p.pair));
  const cooldownMs = (strat.cooldownBars || 0) * (TF_MS[cfg.smallTF] || 900e3);
  for (const sym of watchlist) {
    if (openPairs.has(sym)) continue;
    const lastEx = history.filter(t => t.pair === sym).map(t => new Date(t.exitTime).getTime()).sort((a, b) => b - a)[0];
    if (lastEx && (nowMs - lastEx) < cooldownMs) continue;

    try {
      const big = await provider.klines(sym, cfg.bigTF, Math.max((cfg.biasEmaPeriod || 50) + 30, 120));
      await sleep(120);
      const { bias } = computeBias(big, cfg.biasEmaPeriod || 50);
      if (bias === 'neutral') continue;

      const small = await provider.klines(sym, cfg.smallTF, 250);
      await sleep(120);
      const sig = detectSignal(small, strat, bias, provider.hasTaker);
      if (!sig) continue;

      // ada kandidat → ambil 1h + 1d untuk MTF intel
      let h1 = [], d1 = [];
      try { h1 = await provider.klines(sym, '1h', 220); await sleep(120); } catch (_) {}
      try { d1 = await provider.klines(sym, '1d', 220); await sleep(120); } catch (_) {}

      const closes15 = small.slice(0, -1).map(c => c.c);
      const rsi15 = rsi(closes15.slice(-30), 14);
      const macd15 = macdState(closes15.slice(-80));
      let ma200State = null;
      if (d1.length > 50) {
        const dCloses = d1.slice(0, -1).map(c => c.c);
        if (dCloses.length >= 200) {
          const ma = sma(dCloses, dCloses.length - 1, 200);
          if (ma) ma200State = dCloses[dCloses.length - 1] > ma ? 'ABOVE' : 'BELOW';
        }
      }
      const intel = buildIntel({
        dir: sig.dir, smallCandles: small, big4h: big, hourly1h: h1, daily1d: d1,
        volRatio: sig.raw.volRatio, takerRatio: sig.raw.takerRatio,
        rsi15, macd15, ma200State
      });

      const pos = {
        id: `${sym}-${sig.candleCloseT}`,
        pair: sym, dir: sig.dir,
        strategy: sig.strategy, strategyName: sig.strategyName, strategyShort: sig.strategyShort,
        entry: sig.entry, slInit: sig.sl, sl: sig.sl,
        tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, tpRR: sig.tpRR,
        atr: sig.atr, atrPct: sig.atrPct,
        openTime: new Date(sig.candleCloseT).toISOString(),
        openCandleCloseT: sig.candleCloseT, checkFromCloseT: sig.candleCloseT,
        bias, provider: provider.name, bigTF: cfg.bigTF, smallTF: cfg.smallTF,
        intel, reasons: sig.reasons,
        tpHits: [], realizedPct: 0, remaining: 1, bars: 0,
        lastPrice: sig.entry, lastPriceTime: new Date(sig.candleCloseT).toISOString(),
        status: 'OPEN'
      };
      open.push(pos);
      openPairs.add(sym);
      pushEv({ type: 'new_signal', pair: sym, dir: sig.dir, validity: intel.validity, score: intel.score, entry: sig.entry, strategyShort: sig.strategyShort });
      console.log(`[open]  ${sym} ${sig.dir} ${intel.validity}(${intel.score}) entry=${sig.entry} tp=${sig.tp1}/${sig.tp2}/${sig.tp3} (${sig.strategyShort})`);
    } catch (e) {
      console.log(`[detect] ${sym} gagal: ${e.message}`);
    }
  }

  /* 3) SIMPAN */
  // batasi events ke 200 terbaru (chronological asc untuk konsistensi)
  while (events.length > 200) events.shift();

  const stats = computeStats(history, open, watchlist, { provider: provider.name, bigTF: cfg.bigTF, smallTF: cfg.smallTF });
  writeJSON(path.join(DATA_DIR, 'history.json'), history);
  writeJSON(path.join(DATA_DIR, 'state.json'), { updatedAt: stats.updatedAt, provider: provider.name, open });
  writeJSON(path.join(DATA_DIR, 'stats.json'), stats);
  writeJSON(path.join(DATA_DIR, 'events.json'), events);
  console.log(`[done] open=${open.length} closed=${history.length} winrate=${stats.winrate}% net=${stats.netReturn}% floating=${stats.openFloatingPct}%`);
}

/* ============================================================
   EKSPOR untuk pengujian + jalankan bila dipanggil langsung
   ============================================================ */
module.exports = {
  TF_MS, sma, ema, atrAt, round6, pnlPctAt, strategyLabel, rsi, macdState, trendOf, buildIntel,
  filterTopN, computeBias, detectSignal, advancePosition, computeStats, buildHistoryEntry,
  PROVIDERS
};

if (require.main === module) {
  main().catch(e => { console.error('[fatal]', e.message); process.exit(1); });
}
