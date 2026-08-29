# Handoff / Log Percakapan — Popup Detail Sinyal (2026-08-29)

Ringkasan sesi kerja pada `index.html` (popup detail sinyal) + analisa strategi.
Semua perubahan sudah di-commit & di-push ke branch `main`.

---

## 1. Perbaikan awal: chart candle di popup

**Permintaan:** popup tidak menampilkan chart candle; perbaiki, taruh di main.

**Temuan:** popup memang belum pernah punya chart candlestick — hanya ada
"Price Ladder" (garis level Entry/TP/SL) + bar RSI/Vol/MACD.

**Aksi:**
- Menambahkan chart candlestick real (data klines Binance via `fetchKlines`).
- Commit awal `ed55023` (versi canvas), lalu diganti gaya lightweight-charts.

---

## 2. Pertanyaan strategi (jawaban tercatat)

Strategi robot (`scanner/run.js` + `scanner/config.json`): **PRE-PUMP (long) /
PRE-DUMP (short)** — spike multi-timeframe.

- **Arah:** bias 4H via EMA-50 (close > EMA → long, < EMA → short, else skip).
  Entry di 15m butuh: volume spike ≥ 2.5× avg20, konsolidasi (range < 6%),
  body candle ≥ 0.3%, konfirmasi taker ratio, dan searah bias 4H.
- **Entry:** harga close candle 15m pemicu.
- **SL:** mode `structure` — batas konsolidasi + buffer ATR (guard min 0.3%,
  maks 4×ATR 4H).
- **TP:** mode `structure` — level swing 4H (resistance/support); fallback
  kelipatan R. Staged exit (TP1→BE, TP2→SL ke TP1, TP3→tutup). Tanpa timeout.

**Kenapa hasil backtest jelek (data `data/stats.json`):**
winrate 39.8%, netReturn −358%, profit factor 0.91, 1772/1980 (≈89%) exit di SL.
Sebab utama: entry telat (beli setelah pump/di area extended), TP terlalu jauh
(RR besar → jarang kena), SL lebar, tanpa batas waktu (modal nyangkut), memindai
semua pair termasuk small-cap rawan pump-and-dump, fee/slippage tak dimodelkan.

---

## 3. Chart gaya "position tool" (Economstock Terminal)

**Permintaan:** buat chart + trading plan seperti gambar referensi (repo
`terminal` / Economstock Terminal). Taruh di main.

**Aksi (commit `f0feb08`):**
- Ganti canvas → **lightweight-charts@4.2.0** (di-load di `<head>`).
- Overlay HTML zona: hijau Entry→TP1/2/3, merah Entry→SL, chip label
  `TP1 <harga> (+x%)`. Zona di-reposisi tiap frame (RAF) agar melekat ke candle.
- Tooltip OHLC saat hover, watermark "TVBT PRO", cleanup saat modal ditutup.

---

## 4. Rampingkan popup

**Permintaan:** hapus section yang di-screenshot.

**Aksi (commit `818dbe8`):** hapus **ENTRY & TARGETS**, **POSISI SAAT INI**,
**MARKET INTELLIGENCE**, **PANDUAN MANAJEMEN**. Sisa: header strategi +
chart/visual analisa + alasan sinyal.

---

## 5. Indikator teknikal (sesuai gambar)

**Permintaan:** tambah MA25/50/100, Bollinger, Parabolic SAR, StochRSI, RSI,
MACD; timeframe 4H & 15m; tanpa volume; warna sesuai gambar.

**Aksi (commit `7fe207a`):**
- Toggle timeframe **15m / 4H** (default 4H).
- Main pane: candle + MA(25) hijau, MA(50) magenta, MA(100) ungu,
  Bollinger(20,2) hijau, Parabolic SAR(0.02,0.2) titik kuning.
- Subpane tersinkron: **StochRSI** (K hijau/D oranye), **RSI(14)** kuning,
  **MACD** (histogram hijau/merah + DIF hijau + DEA oranye).
- Indikator dihitung sendiri di browser (SMA, EMA, Wilder RSI, StochRSI, MACD,
  Bollinger, Parabolic SAR). Legend teks berwarna, update saat hover crosshair.

---

## 6. Perbaikan penyelarasan subpane

- **`983b040`:** subpane StochRSI/RSI/MACD tidak sampai candle terakhir karena
  warmup indikator membuat index waktu tak sejajar → fix dengan mengisi titik
  *whitespace* `{time}` untuk periode warmup di semua series.
- **`03ddbbf`:** tepi kanan chart price & indikator tak sejajar karena lebar
  kolom harga beda → fix dengan `rightPriceScale.minimumWidth` yang sama di
  semua chart (dihitung dari panjang label harga terpanjang).

---

## 7. Penyesuaian akhir

**Aksi (commit `8dd607e`):**
- **Hapus Price Ladder** dari VISUAL ANALISA (panel bar full-width).
- **Multi-TF** jadi **D / 4H / 15m / 5m**, tren dihitung live dari klines
  (close vs EMA) saat popup dibuka.
- **Notifikasi toast otomatis dimatikan** (early return di `showToast`); event
  tetap tercatat di lonceng dan hanya muncul saat lonceng diklik.

---

## Catatan teknis
- Chart butuh internet di browser (CDN unpkg lightweight-charts + data Binance).
- Verifikasi dilakukan via cek sintaks + porting logika (sandbox tanpa akses
  jaringan eksternal), bukan render langsung.
- Fungsi kunci di `index.html`: `renderStratCandleChart`, `buildStratZones`,
  `layoutStratZones`, `renderStratMtf`, `_stratTrend`, `_attachCandleTooltip`,
  indikator `_stratSMA/_stratEMA/_stratRSI/_stratStochRSI/_stratMACD/_stratBoll/_stratPSAR`.

## Urutan commit (branch main)
```
ed55023  chart candlestick real (canvas awal)
f0feb08  candlestick lightweight-charts + zona trade plan
818dbe8  hapus 4 section popup
7fe207a  indikator MA/BB/SAR/StochRSI/RSI/MACD + toggle 15m/4H
983b040  fix subpane sejajar hingga candle terakhir (whitespace)
03ddbbf  fix lebar price scale sama (1 kolom sejajar)
8dd607e  hapus Price Ladder, Multi-TF D/4H/15m/5m live, matikan toast otomatis
```


---

## 8. Smart Money Concept (SMC) + timeframe 5m

**Aksi:**
- Tambah timeframe **5m** ke toggle chart (jadi 5m / 15m / 4H). Catatan: Binance
  tak punya interval "5h", jadi "5h" diartikan 5m (konsisten dgn sesi sebelumnya).
- Tombol **SMC: ON/OFF** untuk tampil/sembunyi overlay Smart Money Concept.
- SMC dihitung sendiri di browser (`_stratSMC`) dari candle:
  - **Structure**: swing pivot (fractal) → marker **BOS** (lanjut tren) /
    **CHoCH** (balik arah) saat close menembus swing high/low.
  - **Liquidity sweep**: marker **SWEEP** saat wick menembus swing lalu close
    balik (likuiditas disapu).
  - **FVG (Fair Value Gap)**: imbalance 3-candle, hanya yang belum ter-mitigasi
    (maks 6 terbaru), digambar sbg kotak overlay hijau/merah (RAF, melekat candle).
  - **Garis likuiditas**: swing high (BSL) & swing low (SSL) terkini yang belum
    ditembus, sbg price line putus-putus berlabel.
- Cache candle per (pair|tf) supaya toggle SMC tidak fetch ulang.


---

## 9. Ganti mesin sinyal → berbasis indikator (RSI + StochRSI + MACD, TP Fibonacci)

**Permintaan user:** sinyal LONG/SHORT (mulai sekarang) diambil dari indikator.

**Aturan (di `scanner/run.js`, timeframe 4H, pada candle yang sudah close):**
- **LONG:** RSI(14) > 50, StochRSI %K cross ke atas %D saat %K < 80, MACD DIF > 0.
- **SHORT:** RSI < 50, %K cross ke bawah %D saat %K > 20, MACD DIF < 0.
- **Entry:** open candle berikutnya.
- **SL:** swing terdekat (`fibLookback`, default 30 candle) + buffer ATR.
- **TP1/2/3:** ekstensi Fibonacci × risiko = **1.272 / 1.618 / 2.618** (configurable
  `tpFib`).

**Perubahan teknis:**
- Fungsi baru: `rsiSeries`, `stochRsiKD`, `macdDifHist`, `detectSignalIndicator`.
- `scanSymbol` kini pakai `detectSignalIndicator(big4h)` (bukan lagi volume-spike
  15m + bias EMA). Strategi lama (`detectSignal`, `computeBias`) tetap ada tapi
  tak dipakai.
- Label strategi: `FIB-LONG` / `FIB-SHORT`.
- Param baru di `scanner/config.json`: rsiMid, stochRsiPeriod/K/D, stochUpper/Lower,
  macdFast/Slow/Signal, fibLookback, tpFib, slBufferAtr, slMinPct, slMaxAtrMult.

**Catatan:** histori lama (strategi volume-spike) TIDAK direset, jadi statistik
winrate akan bercampur strategi lama+baru sampai user minta reset.
