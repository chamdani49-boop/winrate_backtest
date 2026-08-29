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


### 9b. Ralat: pemicu 15m, acuan 4H

Klarifikasi user: aturan RSI+StochRSI+MACD adalah **pemicu di 15m**, sedangkan
**4H sebagai acuan/bias arah**.

- **Acuan 4H** (fokus arah): StochRSI %K≥%D (bullish) + RSI(4H)>50 + MACD DIF(4H)>0
  → hanya izinkan LONG; kebalikannya → hanya SHORT.
- **Pemicu 15m** (entry presisi): RSI>50 + StochRSI %K cross↑ %D (K<80) + MACD DIF>0
  (LONG); kebalikannya (SHORT).
- Entry mulai candle 15m berikutnya; SL swing 15m; TP1/2/3 Fibonacci.
- `detectSignalIndicator(small, big, strat)` — small=15m (pemicu+swing), big=4H (acuan).


---

## 10. Winrate rolling 30 hari + histori winrate/return per bulan

- **Headline stats (winrate, net, PF, avg, best/worst, wins/losses, totalClosed)**
  kini dihitung dari trade yang tutup dalam **30 hari terakhir** (rolling, dihitung
  ulang tiap run). `totalClosedAll` = jumlah all-time (dipakai kartu "System Signals").
- Ditambah `stats.monthly`: winrate, net%, profit factor, W/L, jumlah trade **per
  bulan** (semua histori, urut terbaru dulu).
- Frontend: label winrate → "Winrate 30 hari", sub "(30h)"; kartu baru **"Winrate &
  Return per Bulan"** (tabel) di halaman Live.


---

## 11. Sinyal dari indikator (ralat: 15m pemicu, 4H acuan) + fix data + 30h + histori bulanan

- **Sinyal** (commit e7f8ce9, 2300d08): pemicu di **15m** (RSI>50 + StochRSI cross↑ K<80 + MACD DIF>0 untuk LONG; kebalikan SHORT), **4H sebagai acuan** (StochRSI K≥D + RSI>50 + MACD DIF>0 → fokus LONG). 4H dikonfirmasi pakai candle CLOSED. Entry candle 15m berikutnya; SL swing 15m; TP1/2/3 Fibonacci 1.272/1.618/2.618×R.
- **FVG** (ca0ea11): hilang begitu harga MASUK gap (bukan harus tembus penuh); hanya tampilkan yang belum terisi.
- **Fix chart gagal muat** (75b2977): `fetchKlines` lanjut ke mirror berikutnya bila mirror pertama balas 200-kosong; popup fallback spot→futures.
- **Winrate rolling 30 hari** + **stats.monthly** (776ddbc): headline dihitung dari trade 30 hari terakhir; tambah `totalClosedAll`, `windowDays`, dan `monthly` (winrate/net/PF/W-L per bulan). `data/stats.json` di-regen (087cc3f).
- **Histori bulanan → sub-tab di dalam Robot Live** (433d37c): dibuat tab (Ringkasan/Histori Bulanan) via .live-tabs + showLiveTab.

### ⚠️ PENDING (belum selesai) — permintaan terakhir user: tab Live/Performa/History/Akun
Halaman Live TERNYATA sudah punya sistem tab sendiri: `setLiveTab('live'/'perf'/'acc')`
dengan pane `#live-pane-live/perf/acc` (tab: Live, Performa, Akun). Tab dash/monthly
yang saya tambah (`#live-subtabs` + `showLiveTab` + `#lv-monthly-section`) jadi
REDUNDAN (dobel bar tab). 

TODO berikutnya:
  1. Hapus `#live-subtabs`, `#lv-monthly-section`, fungsi `showLiveTab`, dan panggilan
     `renderMonthlyTable(stats)` di renderLive yang redundan.
  2. Tambah tab **History** ke `#live-tabs` (urutan: Live, Performa, History, Akun) +
     tambahkan 'history' ke array valid di `setLiveTab`.
  3. Buat pane `#live-pane-history` berisi tabel winrate & return per bulan
     (pakai renderMonthlyTable + `monthly-body`, atau tabel `lv-month-body` yg sudah ada
     di pane Akun — pindahkan ke History).
  4. Isi History = "return & winrate setiap bulan".


---

## 12. Cron 5m, fix chart 5m, mobile redesign, tab tunggal, landing Live

- **Cron** (21e84ae): `scanner.yml` diubah `*/15` → `*/5`. CATATAN: GitHub Actions
  sering menunda/melewati scheduled cron — nyatanya cuma jalan beberapa kali/hari
  (run otomatis terakhir 10:19 UTC). Sinyal FIB sejauh ini SEMUA dari pemicuan
  MANUAL (workflow_dispatch), belum ada yang otomatis. Solusi rencana: cron-job.org.
- **Fix chart 5m** (21e84ae): `fetchKlinesResilient` = Binance spot → futures →
  Bybit + 1× retry; dipakai popup chart & Multi-TF. Perbaiki "Tidak ada data diterima".
- **Jumlah coin dipindai**: topN=0, minQuoteVolume=$1jt → **±184 pair USDT** (dinamis
  ~150–250) di Binance spot; exclude leverage token + 10 stablecoin.
- **Tab Live dirapikan jadi SATU bar** (db27404): Live / Performa / History / Akun.
  - Hapus bar tab redundan (dash/monthly) + fungsi showLiveTab.
  - History = winrate & return per bulan (renderMonthlyTable + monthly-body).
  - Akun = simulasi modal + "Saldo Akun per Bulan" (lv-month-body, renderMonthly).
- **Mobile redesign** (db27404): g2 → 1 kolom ≤640px, bar tab sticky, tabel rapat,
  font/padding proporsional (≤640 & ≤380).
- **Fix popup terpotong** (68ebdb6): baris Validity(ring) & MACD height auto +
  overflow visible + nowrap → "MODERATE/100" & "NAIK MEMUDAR" tidak kepotong.
- **Landing = Robot Live** (6b06fc2, 8ab7056): default active dipindah ke Live
  (halaman+nav+bottomnav), onload `goPage('live')`, `history.scrollRestoration =
  'manual'` → hard-refresh selalu mulai di Robot Live paling atas (HP).

### TODO berikutnya
- Setup **cron-job.org** memanggil workflow_dispatch tiap 5 menit (pakai PAT
  fine-grained, izin Actions read&write) agar sinyal benar-benar otomatis.


---

## 13. Skor/validity sinkron + crosshair antar-pane + fix mobile overflow

- **Fix mobile overflow** (12c2d69): tab Performa/History/Akun sempat terpotong &
  "membesar" ke kanan di HP → `overflow-x:clip` (html/body/.main, tak merusak sticky)
  + `min-width:0` grid/kartu + `#dayChart max-width:100%`.
- **Landing = Robot Live** (6b06fc2, 8ab7056) + tab switch scroll ke bar tab (d1b1b89)
  supaya konten tab langsung terlihat.
- **Skor/validity SINKRON dgn strategi baru** (f0f62f7): masalah — sinyal FIB
  mayoritas WEAK karena masih pakai `buildIntel` lama (skor dari volume spike +
  RSI-oversold + taker → bertentangan dgn rumus baru). Solusi: `buildIntelIndicator`
  menilai confluence yg SAMA dgn sinyal (momentum RSI 15m, freshness StochRSI, MACD,
  kekuatan acuan 4H, keselarasan MTF, +bonus MA200). Base 45 + confluence;
  STRONG≥75, MODERATE≥58, WEAK<58. scanSymbol memakainya. Posisi FIB terbuka
  di-rescore (4a0e227) → distribusi jadi STRONG 14 / MODERATE 3 / WEAK 0.
- **Crosshair antar-pane** (303b9d8): `stratSyncCrosshair` → saat menahan/hover chart,
  garis vertikal muncul di SEMUA pane (main → StochRSI → RSI → MACD) via
  setCrosshairPosition, seolah satu garis menembus ke bawah sampai MACD.

### Cron otomatis: MASIH manual
Run otomatis (schedule) GitHub terakhir 10:19 UTC; semua sinyal FIB dari manual
(workflow_dispatch). Panduan setup di `docs/cron-setup.md` (cron-job.org).



---

## 14. Crosshair satu garis tembus ke MACD + fix halaman kepotong di HP (sesi lanjutan)

Sesi lanjutan (2026-08-29 malam). Semua di branch `main`.

### 14a. Crosshair popup: satu garis vertikal menembus dari chart utama sampai MACD
- **Masalah:** implementasi lama pakai `setCrosshairPosition(price, time, series)` per
  pane — tidak andal menggambar garis vertikal di subpane (StochRSI/RSI/MACD); di HP
  hanya garis di chart utama yang tampak.
- **Solusi (`stratSyncCrosshair` ditulis ulang):** overlay `<div class="strat-xhair">`
  (garis putus-putus, `pointer-events:none`, z-index 20) disuntik ke tiap kontainer pane
  (`#stratChartWrap` + 3 `.strat-sub-wrap`). Saat `subscribeCrosshairMove`, koordinat-x
  dihitung `chart.timeScale().timeToCoordinate(time)` (fallback `param.point.x`) lalu
  SEMUA garis diposisikan di x yang sama → tampak seperti satu garis kontinu menembus ke
  bawah sampai MACD. Sembunyi saat pointer keluar (`param.time == null`).
- Garis vertikal native lightweight-charts dimatikan (`crosshair.vertLine.visible:false`)
  di chart utama & subpane agar tidak dobel dengan overlay; garis horizontal tetap ada.
- Elemen overlay dibersihkan di `cleanupStratChart` (`_stratXhairEls`).

### 14b. Halaman "kepotong" di HP pada tab selain Live (Home/Backtest/Kalkulator/Scanner)
- **Root cause (flexbox min-width:auto trap):** `#app{display:flex}` dan `.main{flex:1}`.
  Tanpa `min-width:0`, min-width otomatis flex item = min-content-nya → kartu/tabel/canvas
  lebar (mis. tabel 8 kolom "Rekap Semua Trade" saat ADA data, atau canvas chart 600px)
  MEMAKSA `.main` melebar dari viewport, lalu ujung kanannya dipotong `overflow-x:clip`.
  Terlihat hanya saat halaman terisi data (makanya render kosong tampak normal).
- **Verifikasi:** render headless Chromium (Playwright) di lebar HP 390/412px + muat data
  demo → terbukti seluruh `.main` melebar (Home ~652px, Backtest ~468px di viewport 412).
- **Fix (di `@media (max-width:900px)`):**
  - `#app{min-width:0}` + `.main{min-width:0}` → `.main` menyusut pas layar; tabel lebar
    kini digeser di dalam `.tbl-wrap{overflow-x:auto}`-nya, bukan memaksa halaman.
  - `.chart-box{overflow:hidden}` + `.chart-box canvas{max-width:100%}` → canvas chart
    (dashboard/equity/day) tak meluber dari kotaknya.
- **Hasil:** di 412px semua halaman `leaves=[]`/`scrollers=[]` (kecuali tabel yang memang
  scroll dalam wrapper). Cutoff hilang.

### Verifikasi
- Sintaks JS inline `index.html` dicek OK (`new Function`).
- Layout diverifikasi via screenshot Playwright headless di 390/412px (chart popup butuh
  CDN + data Binance → tidak diuji render live karena sandbox INTEGRATIONS_ONLY; hanya
  halaman tab yang diverifikasi visual).



---

## 14. Fix layout HP kepotong + "fresh cross" StochRSI (anti entry saat kelelahan)

- **Fix mobile kepotong** (commit `18da4c4`): konten tab **Performa/History/Akun** (mis. kartu
  hero WIN RATE/SYSTEM SIGNALS ikut kepotong) karena `.main` adalah flex item tanpa
  `min-width:0` → tabel lebar di pane non-Live memaksa `.main` melebihi viewport, dan
  `overflow-x:clip` yang ada cuma menyembunyikan (memotong) kelebihannya. Solusi: tambah
  `min-width:0` di `.main` dan `min-width:0;max-width:100%` di `#app`. Tabel lebar kini
  scroll di dalam wrapper-nya sendiri; kartu hero tak kepotong lagi.

- **Pertanyaan user (foto BONKUSDT SHORT, skor 89 STRONG)**: kenapa lolos? Analisa —
  sinyal lolos harfiah tapi filter punya titik buta: cross StochRSI 15m dari **zona tengah**
  (K=57.8, bukan dari overbought), MACD state `fading_up` (momentum turun sudah melemah)
  malah dinilai +, dan acuan 4H StochRSI K=7.6 (oversold ekstrem → rawan mantul). Badge
  STRONG di-freeze saat entry sedangkan chart popup menampilkan indikator LIVE → tampak
  kontradiktif setelah harga mantul.

- **Aturan entry baru — "fresh cross"** (commit `e34cbe4`) di `detectSignalIndicator`:
  begitu 4H close & bias searah, JANGAN langsung entry. StochRSI 15m harus muncul dari zona
  ekstrem lawan arah dulu:
  - **LONG**: %K sempat **oversold** (≤`stochLower`) dalam `stochZoneLookback` (default 8)
    candle terakhir, LALU cross↑ saat %K masih di **paruh bawah** (< `stochCrossZone`=50).
  - **SHORT**: %K sempat **overbought** (≥`stochUpper`) lalu cross↓ saat %K > (100−`stochCrossZone`).
  - Param config baru: `stochFreshCross` (true), `stochZoneLookback` (8), `stochCrossZone` (50).
    Set `stochFreshCross:false` untuk kembali ke perilaku lama.
  - `reasons.stochFrom` mencatat nilai %K ekstrem asal cross. Label strategi jadi
    `StochRSI oversold→cross↑` / `overbought→cross↓`.
  - Diuji: cross dari tengah / BONKUSDT-like (kMaxRecent 62, tak pernah ≥80) DITOLAK;
    cross dari oversold/overbought DITERIMA.
  - Catatan: 38 posisi lama tetap (dibuka sebelum aturan ini). Aturan berlaku untuk sinyal baru.
