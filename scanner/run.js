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
async function httpJSON(url, timeoutMs = 12000, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      // 429 = rate limit, 418 = IP auto-ban sementara (Binance). Hormati Retry-After lalu coba lagi.
      if (res.status === 429 || res.status === 418) {
        const ra = parseInt(res.headers.get('retry-after') || '0', 10);
        if (attempt < retries) {
          const wait = ra > 0 ? ra * 1000 : Math.min(15000, 800 * Math.pow(2, attempt));
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error('HTTP ' + res.status + ' (rate-limited)');
      }
      if (!res.ok) {
        // 5xx sementara → retry dengan backoff
        if (res.status >= 500 && attempt < retries) {
          await new Promise(r => setTimeout(r, Math.min(8000, 600 * Math.pow(2, attempt))));
          continue;
        }
        throw new Error('HTTP ' + res.status);
      }
      return await res.json();
    } catch (e) {
      // timeout / jaringan putus → retry beberapa kali
      const transient = e.name === 'AbortError' || /network|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(e.message || '');
      if (transient && attempt < retries) {
        await new Promise(r => setTimeout(r, Math.min(8000, 600 * Math.pow(2, attempt))));
        continue;
      }
      throw e;
    } finally { clearTimeout(to); }
  }
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
// Pembulatan harga ADAPTIF: 6 desimal tetap (round6 lama) merusak harga micro
// (mis. SHIB/NEIRO < 0.0001) -> SL/TP kolaps jadi sama dgn entry (persentase 0).
// Sekarang jumlah desimal menyesuaikan besaran harga agar level tetap presisi.
function roundPx(x) {
  if (!isFinite(x) || x === 0) return x;
  const a = Math.abs(x);
  let dec;
  if (a >= 1000)        dec = 3;
  else if (a >= 1)      dec = 5;
  else if (a >= 0.01)   dec = 6;
  else if (a >= 0.0001) dec = 8;
  else if (a >= 0.000001) dec = 10;
  else                    dec = 12;
  const f = Math.pow(10, dec);
  return Math.round(x * f) / f;
}
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

/* RSI Wilder sebagai DERET (nilai per index close) */
function rsiSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; avgG += Math.max(d, 0); avgL += Math.max(-d, 0); }
  avgG /= period; avgL /= period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

/* StochRSI %K & %D (deret) */
function stochRsiKD(closes, rsiPeriod, kSmooth, dSmooth) {
  const r = rsiSeries(closes, rsiPeriod);
  const stoch = new Array(closes.length).fill(null);
  for (let i = 0; i < r.length; i++) {
    if (r[i] == null) continue;
    let lo = Infinity, hi = -Infinity, cnt = 0, ok = true;
    for (let j = i; j > i - rsiPeriod; j--) { if (j < 0 || r[j] == null) { ok = false; break; } lo = Math.min(lo, r[j]); hi = Math.max(hi, r[j]); cnt++; }
    if (!ok || cnt < rsiPeriod) continue;
    stoch[i] = hi === lo ? 0 : (r[i] - lo) / (hi - lo) * 100;
  }
  const smaN = (arr, p) => {
    const o = new Array(arr.length).fill(null);
    for (let i = p - 1; i < arr.length; i++) { let s = 0, ok = true; for (let j = i - p + 1; j <= i; j++) { if (arr[j] == null) { ok = false; break; } s += arr[j]; } if (ok) o[i] = s / p; }
    return o;
  };
  const k = smaN(stoch, kSmooth);
  const d = smaN(k, dSmooth);
  return { k, d };
}

/* MACD DIF/DEA/HIST (deret) — pakai emaSeries yang sudah ada */
function macdDifHist(closes, fast, slow, sig) {
  const empty = { dif: [], dea: [], hist: [] };
  if (closes.length < slow + sig + 2) return empty;
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const dif = ef.map((v, i) => v - es[i]);
  const dea = emaSeries(dif, sig);
  const hist = dif.map((v, i) => v - dea[i]);
  return { dif, dea, hist };
}

/* ============================================================
   DETEKSI SINYAL BERBASIS INDIKATOR — fungsi murni
   PEMICU di timeframe kecil (smallTF = 15m, candle close):
     LONG (SHORT kebalikan):
       - RSI(14) di atas 50
       - StochRSI %K cross ke atas %D saat %K < 80
       - MACD DIF di atas garis 0
   ACUAN di timeframe besar (bigTF = 4H): arah 15m harus searah bias 4H
     - 4H bull → fokus LONG: StochRSI %K>=%D (bullish) DAN RSI(4H)>50 DAN MACD DIF(4H)>0
     - 4H bear → fokus SHORT: StochRSI %K<=%D (bearish) DAN RSI(4H)<50 DAN MACD DIF(4H)<0
   Entry mulai candle 15m berikutnya (open). SL di swing 15m terdekat;
   TP1/2/3 = ekstensi Fibonacci × risiko.
   ============================================================ */
function detectSignalIndicator(small, big, strat) {
  const closed = small.slice(0, -1);          // candle 15m yang sudah close (pemicu)
  const forming = small.length ? small[small.length - 1] : null; // candle 15m berikutnya (entry)
  if (closed.length < 45) return null;
  const closes = closed.map(c => c.c);
  const i = closes.length - 1;

  const rsiP = strat.rsiPeriod || 14;
  const fast = strat.macdFast || 12, slow = strat.macdSlow || 26, mSig = strat.macdSignal || 9;
  const mid = strat.rsiMid != null ? strat.rsiMid : 50;
  const upper = strat.stochUpper != null ? strat.stochUpper : 80;
  const lower = strat.stochLower != null ? strat.stochLower : 20;

  // --- Pemicu 15m ---
  const rsiArr = rsiSeries(closes, rsiP);
  const { k, d } = stochRsiKD(closes, strat.stochRsiPeriod || 14, strat.stochK || 3, strat.stochD || 3);
  const { dif } = macdDifHist(closes, fast, slow, mSig);
  const rsiNow = rsiArr[i];
  const kNow = k[i], kPrev = k[i - 1], dNow = d[i], dPrev = d[i - 1];
  const difNow = (dif && dif.length === closes.length) ? dif[i] : null;
  if (rsiNow == null || kNow == null || kPrev == null || dNow == null || dPrev == null || difNow == null) return null;
  const crossUp = kPrev <= dPrev && kNow > dNow;
  const crossDn = kPrev >= dPrev && kNow < dNow;
  const trigLong = rsiNow > mid && crossUp && kNow < upper && difNow > 0;
  const trigShort = rsiNow < mid && crossDn && kNow > lower && difNow < 0;
  if (!trigLong && !trigShort) return null;

  // --- Acuan 4H (bias arah): StochRSI bullish/bearish + RSI vs 50 + MACD vs 0 ---
  // slice(0,-1) → buang candle 4H in-progress; pakai HANYA candle 4H yang sudah
  // CLOSED. Jadi fokus long/short 4H baru dikonfirmasi setelah candle 4H tutup.
  const bigClosed = Array.isArray(big) ? big.slice(0, -1) : [];
  let bullRef = true, bearRef = true, rsi4 = null, dif4 = null, k4 = null, d4v = null;
  if (bigClosed.length >= slow + mSig + 2) {
    const bC = bigClosed.map(c => c.c);
    const r4a = rsiSeries(bC, rsiP); rsi4 = r4a[r4a.length - 1];
    const m4 = macdDifHist(bC, fast, slow, mSig); dif4 = (m4.dif && m4.dif.length) ? m4.dif[m4.dif.length - 1] : null;
    const s4 = stochRsiKD(bC, strat.stochRsiPeriod || 14, strat.stochK || 3, strat.stochD || 3);
    k4 = s4.k[s4.k.length - 1]; d4v = s4.d[s4.d.length - 1];
    if (rsi4 != null && dif4 != null && k4 != null && d4v != null) {
      // 4H fokus LONG bila StochRSI bullish (K >= D) + RSI>50 + MACD DIF>0
      bullRef = rsi4 > mid && dif4 > 0 && k4 >= d4v;
      bearRef = rsi4 < mid && dif4 < 0 && k4 <= d4v;
    } else if (rsi4 != null && dif4 != null) {
      bullRef = rsi4 > mid && dif4 > 0;
      bearRef = rsi4 < mid && dif4 < 0;
    }
  }

  const allow = strat.direction || 'both';
  let dir = null;
  if ((allow === 'both' || allow === 'long') && trigLong && bullRef) dir = 'BUY';
  else if ((allow === 'both' || allow === 'short') && trigShort && bearRef) dir = 'SELL';
  if (!dir) return null;

  // Entry = open candle 15m berikutnya (forming). Fallback: close candle sinyal.
  const entry = (forming && isFinite(forming.o)) ? forming.o : closed[i].c;

  // Swing 15m terdekat (fib leg) + ATR utk buffer/guard
  const look = closed.slice(-(strat.fibLookback || 30));
  let hi = -Infinity, lo = Infinity;
  look.forEach(c => { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; });
  const a = atrAt(closed, i, strat.atrPeriod || 14) || (hi - lo) * 0.1 || entry * 0.01;
  const buf = a * (strat.slBufferAtr != null ? strat.slBufferAtr : 0.25);
  const fib = (Array.isArray(strat.tpFib) && strat.tpFib.length === 3) ? strat.tpFib : [1.272, 1.618, 2.618];

  let sl, R;
  if (dir === 'BUY') { sl = lo - buf; R = entry - sl; }
  else { sl = hi + buf; R = sl - entry; }
  const minR = entry * ((strat.slMinPct != null ? strat.slMinPct : 0.5) / 100);
  if (!(R > 0) || R < minR) { R = minR; sl = dir === 'BUY' ? entry - R : entry + R; }
  const maxR = a * (strat.slMaxAtrMult != null ? strat.slMaxAtrMult : 5);
  if (R > maxR) { R = maxR; sl = dir === 'BUY' ? entry - R : entry + R; }

  const lvl = m => dir === 'BUY' ? entry + R * m : entry - R * m;
  const tps = [lvl(fib[0]), lvl(fib[1]), lvl(fib[2])];
  const lab = dir === 'BUY'
    ? { code: 'FIB_LONG', name: 'RSI>50 + StochRSI cross↑ + MACD>0 (15m) · acuan 4H · TP Fibonacci', short: 'FIB-LONG' }
    : { code: 'FIB_SHORT', name: 'RSI<50 + StochRSI cross↓ + MACD<0 (15m) · acuan 4H · TP Fibonacci', short: 'FIB-SHORT' };

  return {
    dir, entry: roundPx(entry), sl: roundPx(sl),
    tp1: roundPx(tps[0]), tp2: roundPx(tps[1]), tp3: roundPx(tps[2]),
    tpRR: fib.map(m => +(+m).toFixed(3)), tpMode: 'fibonacci', slMode: 'swing',
    riskPct: +(R / entry * 100).toFixed(2),
    atr: roundPx(a), atrPct: +(a / entry * 100).toFixed(2), atrTF: 'small',
    strategy: lab.code, strategyName: lab.name, strategyShort: lab.short,
    signalCandleCloseT: closed[i].closeT,
    entryCandleT: forming ? forming.t : closed[i].closeT + 1,
    candleCloseT: forming ? forming.closeT : closed[i].closeT,
    reasons: { rsi: +rsiNow.toFixed(1), stochK: +kNow.toFixed(1), stochD: +dNow.toFixed(1), macdDif: +difNow.toFixed(8), cross: dir === 'BUY' ? 'up' : 'down', ref4h: (rsi4 != null && dif4 != null) ? { rsi: +rsi4.toFixed(1), macdDif: +dif4.toFixed(8), stochK: k4 != null ? +k4.toFixed(1) : null, stochD: d4v != null ? +d4v.toFixed(1) : null } : null },
    raw: { rsi: +rsiNow.toFixed(1), stochK: +kNow.toFixed(1), macdDif: +difNow.toFixed(8), volRatio: null, takerRatio: null }
  };
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
  const minVol = Number.isFinite(cfg.minQuoteVolume) ? cfg.minQuoteVolume : 0;
  const ranked = tickers
    .filter(t => t.symbol.endsWith(cfg.quote))
    .filter(t => !exS.has(t.symbol))
    .filter(t => !exC.some(frag => t.symbol.includes(frag)))
    .filter(t => Number.isFinite(t.quoteVolume) && t.quoteVolume > 0)
    .filter(t => t.quoteVolume >= minVol)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
  // topN<=0 (atau tidak diset) => tanpa batas (semua yang lolos minQuoteVolume)
  const capped = (cfg.topN && cfg.topN > 0) ? ranked.slice(0, cfg.topN) : ranked;
  return capped.map(t => t.symbol);
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
  const holdDuration = 'Sampai TP3 / SL (tanpa batas waktu)';
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

/* Pivot swing (fractal sederhana): high/low lokal dgn window w di kiri-kanan */
function swingPivots(candles, type, w) {
  const out = [];
  for (let i = w; i < candles.length - w; i++) {
    let ok = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (type === 'high' && candles[j].h >= candles[i].h) { ok = false; break; }
      if (type === 'low'  && candles[j].l <= candles[i].l) { ok = false; break; }
    }
    if (ok) out.push(type === 'high' ? candles[i].h : candles[i].l);
  }
  return out;
}

/* TP DINAMIS berbasis STRUKTUR (analisa chart): pakai level swing timeframe besar
   sebagai target — resistance (pivot high) utk LONG, support (pivot low) utk SHORT.
   - Tiap TP minimal 1R dari entry (TP1% >= SL%) dan jaraknya monotonic membesar.
   - Level swing yg terlalu rapat di-skip; bila kurang dari `count`, sisanya
     dilengkapi kelipatan R sebagai fallback. Mengembalikan array harga absolut. */
function structureTargets(bigCandles, dir, entry, riskDist, tpR, count, w) {
  const closed = (bigCandles || []).slice(0, -1);
  const win = w || 2;
  let levels = dir === 'BUY'
    ? swingPivots(closed, 'high', win).filter(p => p > entry).sort((a, b) => a - b)
    : swingPivots(closed, 'low',  win).filter(p => p < entry).sort((a, b) => b - a);
  const minGap = riskDist * 0.5;
  const picked = [];
  for (const p of levels) {
    if (picked.length >= count) break;
    const dist = Math.abs(p - entry);
    if (dist < riskDist) continue;                                   // TP1 minimal 1R
    if (picked.some(q => Math.abs(p - q) < minGap)) continue;        // jangan terlalu rapat
    if (picked.length && dist <= Math.abs(picked[picked.length - 1] - entry)) continue; // harus makin jauh
    picked.push(p);
  }
  // fallback: lengkapi sisa dgn kelipatan R, selalu lebih jauh dari target sebelumnya
  let lastDist = picked.length ? Math.abs(picked[picked.length - 1] - entry) : 0;
  for (let k = picked.length; k < count; k++) {
    const rrDist = riskDist * ((tpR && tpR[k]) || (k + 1));
    const dist = Math.max(rrDist, lastDist + riskDist);
    picked.push(dir === 'BUY' ? entry + dist : entry - dist);
    lastDist = dist;
  }
  return picked.slice(0, count);
}

/* ============================================================
   DETEKSI SINYAL SPIKE — fungsi murni
   Entry/keputusan masuk DIDETEKSI di timeframe kecil (15m).
   SL = level "patah" struktur (slMode). TP = level swing struktur 4h
   (tpMode 'structure', dinamis mengikuti chart) atau kelipatan R ('rr').
   Mengembalikan objek sinyal {dir, entry, sl, tp1, tp2, tp3, atr,
   strategy, strategyName, candleT, candleCloseT, reasons} | null
   ============================================================ */
function detectSignal(smallCandles, bigCandles, strat, bias, hasTaker) {
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
  // ATR entry (15m) tetap dihitung untuk validasi sinyal di atas (`a`),
  // tetapi jarak SL/TP mengacu ke ATR timeframe BESAR (4h) bila diaktifkan.
  const targetTF = strat.targetAtrTF || 'big';
  let aTarget = a;                 // default: pakai ATR 15m
  if (targetTF === 'big' && Array.isArray(bigCandles) && bigCandles.length) {
    const bigArr = bigCandles.slice(0, -1);   // buang candle 4h in-progress
    const aBig = atrAt(bigArr, bigArr.length - 1, strat.atrPeriod);
    if (aBig && aBig > 0) aTarget = aBig;       // jarak SL/TP berkaca pada swing 4h
  }
  const tpR = Array.isArray(strat.tpR) && strat.tpR.length === 3 ? strat.tpR : [1, 2, 3];

  // === Jarak risiko (R) — menentukan SL & kelipatan TP ===
  // slMode 'structure' (default): SL di level "patah" struktur = batas konsolidasi
  //   (low utk LONG / high utk SHORT) + buffer kecil. Dinamis mengikuti coin.
  //   TP1/2/3 = kelipatan R, jadi TP1 dijamin >= jarak SL secara %.
  // slMode 'atr': mode lama, R = ATR(targetTF) x atrMult (kelipatan % kaku).
  const slMode = strat.slMode || 'structure';
  let riskDist;
  if (slMode === 'structure') {
    const buffer = aTarget * (strat.slBufferAtr != null ? strat.slBufferAtr : 0.25);
    riskDist = dir === 'BUY' ? (entry - (wl - buffer)) : ((wh + buffer) - entry);
    // guardrail: jangan terlalu sempit / terlalu lebar (berkaca volatilitas targetTF)
    const minDist = entry * ((strat.slMinPct != null ? strat.slMinPct : 0.3) / 100);
    const maxDist = aTarget * (strat.slMaxAtrMult != null ? strat.slMaxAtrMult : 4);
    if (!(riskDist > 0) || riskDist < minDist) riskDist = minDist;
    if (riskDist > maxDist) riskDist = maxDist;
  } else {
    riskDist = aTarget * strat.atrMult;
  }
  if (!(riskDist > 0)) return null;
  const lvl = r => dir === 'BUY' ? entry + riskDist * r : entry - riskDist * r;
  const sl = dir === 'BUY' ? entry - riskDist : entry + riskDist;
  const lab = strategyLabel(dir);

  // === TARGET TP ===
  // tpMode 'structure' (default): TP di level swing 4h (resistance/support nyata) -> dinamis per coin.
  // tpMode 'rr': TP = kelipatan R [1,2,3] (seragam, perilaku lama).
  const tpMode = strat.tpMode || 'structure';
  let tps;
  if (tpMode === 'structure') {
    tps = structureTargets(bigCandles, dir, entry, riskDist, tpR, 3, strat.tpSwingWindow);
  } else {
    tps = [lvl(tpR[0]), lvl(tpR[1]), lvl(tpR[2])];
  }
  const tpRRout = tps.map(p => +(Math.abs(p - entry) / riskDist).toFixed(2));

  return {
    dir, entry: roundPx(entry), sl: roundPx(sl),
    tp1: roundPx(tps[0]), tp2: roundPx(tps[1]), tp3: roundPx(tps[2]),
    tpRR: tpRRout, tpMode,
    slMode, riskPct: +(riskDist / entry * 100).toFixed(2),
    atr: roundPx(aTarget), atrPct: +(aTarget / entry * 100).toFixed(2), atrTF: targetTF,
    atr15: roundPx(a), atr15Pct: +(a / entry * 100).toFixed(2),
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
    // Tidak ada tutup paksa: posisi dibiarkan berjalan apa adanya sampai
    // kena SL (full/trailing) atau TP3. Sesuai logika staged-exit mesin.
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

  // === HEADLINE = rolling 30 HARI TERAKHIR (dihitung ulang tiap run) ===
  const DAY = 86400e3;
  const cut30 = Date.now() - 30 * DAY;
  const recent = history.filter(t => { const tm = new Date(t.exitTime).getTime(); return isFinite(tm) && tm >= cut30; });
  const rWins = recent.filter(t => (t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'WIN');
  const rPnls = recent.map(t => t.pnl_pct || 0);
  const rGrossP = rPnls.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const rGrossL = Math.abs(rPnls.filter(x => x < 0).reduce((a, b) => a + b, 0));
  const rNet = rGrossP - rGrossL;
  const rWr = recent.length ? rWins.length / recent.length * 100 : 0;
  const rPf = rGrossL > 0 ? rGrossP / rGrossL : (rGrossP > 0 ? 999 : 0);

  // === Winrate & return PER BULAN (semua histori, grouped by bulan exit) ===
  const monthly = (() => {
    const mm = {};
    history.forEach(t => {
      const mo = (t.exitTime || '').slice(0, 7); // YYYY-MM
      if (!/^\d{4}-\d{2}$/.test(mo)) return;
      const b = mm[mo] || (mm[mo] = { month: mo, trades: 0, wins: 0, losses: 0, net: 0, gp: 0, gl: 0 });
      b.trades++;
      const win = (t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'WIN';
      if (win) b.wins++; else b.losses++;
      const p = t.pnl_pct || 0; b.net += p; if (p > 0) b.gp += p; else b.gl += Math.abs(p);
    });
    return Object.values(mm)
      .sort((a, b) => b.month.localeCompare(a.month))
      .map(b => ({
        month: b.month, trades: b.trades, wins: b.wins, losses: b.losses,
        winrate: b.trades ? +(b.wins / b.trades * 100).toFixed(1) : 0,
        net: +b.net.toFixed(2),
        profitFactor: b.gl > 0 ? +(b.gp / b.gl).toFixed(2) : (b.gp > 0 ? 999 : 0)
      }));
  })();

  const tpCounts = { TP1: 0, TP2: 0, TP3: 0 };
  history.forEach(t => (t.tpHits || []).forEach(h => { if (tpCounts[h] != null) tpCounts[h]++; }));
  const closedByCounts = { TP3: 0, SL: 0, TIMEOUT: 0 };
  history.forEach(t => { if (closedByCounts[t.closedBy] != null) closedByCounts[t.closedBy]++; });
  const slCount = closedByCounts.SL || 0;

  // Strategy Safety Net: per target — berapa trade yang sentuh tiap level
  // RR rata-rata dari trade yang punya tpRR
  const rrAvg = (() => {
    const arr = history.filter(t => Array.isArray(t.tpRR) && t.tpRR.length === 3).map(t => t.tpRR);
    if (!arr.length) return [1, 2, 3];
    return [0, 1, 2].map(i => arr.reduce((s, r) => s + r[i], 0) / arr.length);
  })();
  const safetyNet = ['TP1', 'TP2', 'TP3'].map((lvl, i) => {
    const hit = tpCounts[lvl];
    const miss = total - hit;
    const safetyRatio = total ? +(hit / total * 100).toFixed(1) : 0;
    // expectancy proxy: prob(hit) * RR — prob(miss) * 1
    const p = total ? hit / total : 0;
    const rr = +rrAvg[i].toFixed(2);
    const exp = +((p * rr) - ((1 - p) * 1)).toFixed(3);
    return { level: lvl, rr, hit, miss, safetyRatio, expectancy: exp };
  });

  // Daily Equity (30 hari terakhir, untuk chart)
  const dailyEquity = (() => {
    const days = 30;
    const startMs = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate()
    ) - (days - 1) * 86400000;
    // bucket per tanggal YYYY-MM-DD
    const buckets = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
      buckets[d] = { date: d, trades: 0, wins: 0, losses: 0, dayPnl: 0 };
    }
    history.forEach(t => {
      const d = (t.exitTime || '').slice(0, 10);
      if (!buckets[d]) return;
      buckets[d].trades++;
      if ((t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'WIN') buckets[d].wins++;
      else buckets[d].losses++;
      buckets[d].dayPnl += t.pnl_pct || 0;
    });
    // cumulative net% sampai akhir tiap hari
    let cum = 0;
    const arr = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
    arr.forEach(b => { cum += b.dayPnl; b.cumulative = +cum.toFixed(2); b.dayPnl = +b.dayPnl.toFixed(2); });
    return arr;
  })();

  // Market Intelligence: ratio bullish vs bearish dari 48 jam terakhir
  // Bullish = long_wins + short_losses ; Bearish = short_wins + long_losses
  // (jika pasar trending naik, long lebih sering profit & short lebih sering rugi)
  const marketBias = (() => {
    const cutoff = Date.now() - 48 * 3600e3;
    const recent = history.filter(t => new Date(t.exitTime).getTime() >= cutoff);
    if (!recent.length) {
      // fallback: pakai bias dari posisi terbuka
      const longs = openPositions.filter(p => p.dir === 'BUY').length;
      const shorts = openPositions.filter(p => p.dir === 'SELL').length;
      const tot = longs + shorts;
      return { bullish: tot ? +(longs / tot * 100).toFixed(0) : 50, bearish: tot ? +(shorts / tot * 100).toFixed(0) : 50, sample: 'open', count: tot };
    }
    let bull = 0, bear = 0;
    recent.forEach(t => {
      const w = (t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'WIN';
      if ((t.dir === 'BUY' && w) || (t.dir === 'SELL' && !w)) bull++;
      else bear++;
    });
    const tot = bull + bear;
    return { bullish: tot ? +(bull / tot * 100).toFixed(0) : 50, bearish: tot ? +(bear / tot * 100).toFixed(0) : 50, sample: 'recent_48h', count: tot };
  })();

  // High score: validity score tertinggi dari 24 jam terakhir
  const highScore = (() => {
    const cutoff = Date.now() - 24 * 3600e3;
    const recent = [...openPositions, ...history.filter(t => new Date(t.exitTime).getTime() >= cutoff)]
      .map(x => x.intel ? x.intel.score : null)
      .filter(s => s != null);
    return recent.length ? Math.max(...recent) : 0;
  })();

  // Live Signal Terminal: posisi terbuka diklasifikasikan in-profit / in-loss
  const liveTerminal = (() => {
    let profit = 0, loss = 0;
    const items = openPositions.map(p => {
      const last = (p.lastPrice != null) ? p.lastPrice : p.entry;
      const dirSign = p.dir === 'BUY' ? 1 : -1;
      const realized = +(p.realizedPct || 0);
      const remaining = (p.remaining != null) ? p.remaining : 1;
      const unreal = ((last - p.entry) / p.entry * 100) * dirSign * remaining;
      const float = realized + unreal;
      if (float >= 0) profit++; else loss++;
      return { pair: p.pair, dir: p.dir, score: p.intel ? p.intel.score : null, validity: p.intel ? p.intel.validity : null, floating: +float.toFixed(2) };
    });
    const accuracy = (profit + loss) ? +(profit / (profit + loss) * 100).toFixed(0) : 0;
    return { profit, loss, accuracy, items };
  })();

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
    windowDays: 30,
    totalClosed: recent.length,          // headline: jumlah trade tutup dalam 30 hari
    totalClosedAll: total,               // total sepanjang waktu (referensi)
    open: openPositions.length,
    wins: rWins.length,
    losses: recent.length - rWins.length,
    winrate: +rWr.toFixed(1),            // WINRATE = 30 hari terakhir
    grossProfit: +rGrossP.toFixed(2),
    grossLoss: +rGrossL.toFixed(2),
    netReturn: +rNet.toFixed(2),         // NET = 30 hari terakhir
    profitFactor: rPf > 999 ? 999 : +rPf.toFixed(2),
    avgReturn: recent.length ? +(rPnls.reduce((a, b) => a + b, 0) / recent.length).toFixed(3) : 0,
    bestPct: rPnls.length ? +Math.max(...rPnls).toFixed(2) : 0,
    worstPct: rPnls.length ? +Math.min(...rPnls).toFixed(2) : 0,
    monthly,
    tpCounts,
    closedByCounts,
    slCount,
    safetyNet,
    dailyEquity,
    marketBias,
    highScore,
    liveTerminal,
    topCoins: (() => {
      const arr = Object.entries(byPair).map(([pair, d]) => ({ pair, trades: d.trades, winrate: d.winrate, net: d.net }));
      return arr.sort((a, b) => b.net - a.net).slice(0, 5);
    })(),
    bottomCoins: (() => {
      const arr = Object.entries(byPair).map(([pair, d]) => ({ pair, trades: d.trades, winrate: d.winrate, net: d.net }));
      return arr.filter(c => c.net < 0).sort((a, b) => a.net - b.net).slice(0, 5);
    })(),
    scoreBrackets: (() => {
      const buckets = [
        { name: '90+',   min: 90, max: 100 },
        { name: '80-89', min: 80, max: 89 },
        { name: '70-79', min: 70, max: 79 },
        { name: '60-69', min: 60, max: 69 },
        { name: '<60',   min: 0,  max: 59 }
      ];
      return buckets.map(b => {
        const trades = history.filter(t => {
          const s = (t.intel && t.intel.score != null) ? t.intel.score : -1;
          return s >= b.min && s <= b.max;
        });
        const wins = trades.filter(t => (t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'WIN').length;
        const tp1 = trades.filter(t => (t.tpHits || []).includes('TP1')).length;
        const tp2 = trades.filter(t => (t.tpHits || []).includes('TP2')).length;
        const tp3 = trades.filter(t => (t.tpHits || []).includes('TP3')).length;
        const sl  = trades.filter(t => t.closedBy === 'SL').length;
        const net = trades.reduce((a, t) => a + (t.pnl_pct || 0), 0);
        return {
          name: b.name, trades: trades.length, tp1, tp2, tp3, sl, wins,
          winrate: trades.length ? +(wins / trades.length * 100).toFixed(1) : 0,
          net: +net.toFixed(2)
        };
      });
    })(),
    scoreAnomaly: (() => {
      // Deteksi anomali: WR low-score (<70) > WR high-score (80+) dlm 24h terakhir
      // ATAU high score signifikan underperform.
      const cutoff = Date.now() - 24 * 3600e3;
      const recent = history.filter(t => new Date(t.exitTime).getTime() >= cutoff && t.intel && t.intel.score != null);
      if (recent.length < 3) return null;
      const lowS = recent.filter(t => t.intel.score < 70);
      const highS = recent.filter(t => t.intel.score >= 80);
      if (lowS.length < 2 || highS.length < 2) return null;
      const wr = (arr) => arr.length ? arr.filter(t => (t.result || (t.pnl_pct >= 0 ? 'WIN' : 'LOSS')) === 'WIN').length / arr.length * 100 : 0;
      const lowWR = +wr(lowS).toFixed(1);
      const highWR = +wr(highS).toFixed(1);
      if (lowWR > highWR + 10) {
        return { type: 'LOW_SCORE_HOT', label: 'SCORE ANOMALY', message: 'Low scores are more accurate today (' + lowWR + '% WR).', lowWR, highWR, sampleLow: lowS.length, sampleHigh: highS.length };
      }
      if (highWR < 30 && highS.length >= 3) {
        return { type: 'HIGH_SCORE_COLD', label: 'STRATEGY DRIFT', message: 'High score signals underperforming today (' + highWR + '% WR).', lowWR, highWR, sampleLow: lowS.length, sampleHigh: highS.length };
      }
      return null;
    })(),
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
    exit: roundPx(ev.exitPrice), bars: pos.bars,
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
  console.log(`[watchlist] ${watchlist.length} pair (min vol $${(cfg.minQuoteVolume || 0).toLocaleString('en-US')}): ${watchlist.slice(0, 30).join(', ')}${watchlist.length > 30 ? ', …' : ''}`);

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

  /* 2) DETEKSI SINYAL BARU (worker-pool paralel terbatas: cepat tapi aman rate-limit) */
  const openPairs = new Set(open.map(p => p.pair));
  const cooldownMs = (strat.cooldownBars || 0) * (TF_MS[cfg.smallTF] || 900e3);
  const reqDelay = Number.isFinite(cfg.requestDelayMs) ? cfg.requestDelayMs : 100;

  // pair yang layak dipindai: belum punya posisi terbuka & sudah lewat cooldown
  const candidates = watchlist.filter(sym => {
    if (openPairs.has(sym)) return false;
    const lastEx = history.filter(t => t.pair === sym).map(t => new Date(t.exitTime).getTime()).sort((a, b) => b - a)[0];
    return !(lastEx && (nowMs - lastEx) < cooldownMs);
  });
  const concurrency = Math.max(1, Math.min(cfg.concurrency || 4, 8));
  console.log(`[scan] ${candidates.length} pair akan dipindai (konkurensi ${concurrency}, delay ${reqDelay}ms)`);

  // Pindai 1 simbol → kembalikan objek posisi bila ada sinyal, atau null.
  async function scanSymbol(sym) {
    // Pemicu sinyal di 15m (RSI+StochRSI+MACD), 4H sebagai acuan arah.
    const big = await provider.klines(sym, cfg.bigTF, Math.max((cfg.biasEmaPeriod || 50) + 30, 160));
    await sleep(reqDelay);
    const small = await provider.klines(sym, cfg.smallTF, 300);
    await sleep(reqDelay);
    const sig = detectSignalIndicator(small, big, strat);
    if (!sig) return null;

    // ada kandidat → ambil 1h + 1d untuk MTF intel (tampilan popup)
    let h1 = [], d1 = [];
    try { h1 = await provider.klines(sym, '1h', 220); await sleep(reqDelay); } catch (_) {}
    try { d1 = await provider.klines(sym, '1d', 220); await sleep(reqDelay); } catch (_) {}

    const closes15 = small.slice(0, -1).map(c => c.c);
    const rsi15 = rsi(closes15.slice(-40), 14);
    const macd15 = macdState(closes15.slice(-120));
    const vols15 = small.slice(0, -1).map(c => c.v);
    const volAvg15 = vols15.length > 21 ? sma(vols15, vols15.length - 1, 20) : null;
    const volRatio = (volAvg15 && volAvg15 > 0) ? vols15[vols15.length - 1] / volAvg15 : null;
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
      volRatio: volRatio || 1, takerRatio: null,
      rsi15, macd15, ma200State
    });

    return {
      id: `${sym}-${sig.signalCandleCloseT}`,
      pair: sym, dir: sig.dir,
      strategy: sig.strategy, strategyName: sig.strategyName, strategyShort: sig.strategyShort,
      entry: sig.entry, slInit: sig.sl, sl: sig.sl,
      tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, tpRR: sig.tpRR,
      atr: sig.atr, atrPct: sig.atrPct,
      openTime: new Date(sig.entryCandleT).toISOString(),
      openCandleCloseT: sig.entryCandleT,        // entry = open candle berikutnya
      checkFromCloseT: sig.entryCandleT - 1,      // monitor TP/SL 15m sejak entry candle
      bias: sig.dir === 'BUY' ? 'long' : 'short', provider: provider.name, bigTF: cfg.bigTF, smallTF: cfg.smallTF,
      intel, reasons: sig.reasons,
      tpHits: [], realizedPct: 0, remaining: 1, bars: 0,
      lastPrice: sig.entry, lastPriceTime: new Date(sig.entryCandleT).toISOString(),
      status: 'OPEN'
    };
  }

  // worker-pool: beberapa worker menarik pekerjaan dari antrian yang sama
  const found = [];
  let cursor = 0, done = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const sym = candidates[cursor++];
      try {
        const pos = await scanSymbol(sym);
        if (pos) found.push(pos);
      } catch (e) {
        console.log(`[detect] ${sym} gagal: ${e.message}`);
      }
      if (++done % 50 === 0) console.log(`[scan] progress ${done}/${candidates.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));

  // daftarkan sinyal yang ditemukan (skor tertinggi dulu agar log rapi)
  found.sort((a, b) => (b.intel ? b.intel.score : 0) - (a.intel ? a.intel.score : 0));
  for (const pos of found) {
    open.push(pos);
    openPairs.add(pos.pair);
    pushEv({ type: 'new_signal', pair: pos.pair, dir: pos.dir, validity: pos.intel.validity, score: pos.intel.score, entry: pos.entry, strategyShort: pos.strategyShort });
    console.log(`[open]  ${pos.pair} ${pos.dir} ${pos.intel.validity}(${pos.intel.score}) entry=${pos.entry} tp=${pos.tp1}/${pos.tp2}/${pos.tp3} (${pos.strategyShort})`);
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
  TF_MS, sma, ema, atrAt, roundPx, pnlPctAt, strategyLabel, rsi, macdState, trendOf, buildIntel,
  swingPivots, structureTargets,
  rsiSeries, stochRsiKD, macdDifHist, detectSignalIndicator,
  filterTopN, computeBias, detectSignal, advancePosition, computeStats, buildHistoryEntry,
  PROVIDERS
};

if (require.main === module) {
  main().catch(e => { console.error('[fatal]', e.message); process.exit(1); });
}
