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


### 14b. Ralat user: 15m tak perlu tunggu ekstrem

User revisi: di 15m **tidak perlu** menunggu overbought/oversold. Cukup **cross bullish +
candle sudah CLOSE** (walau di zona tengah). → `stochFreshCross` di-set **false** (gate
dinonaktifkan; kode gate tetap ada untuk optionalitas). Label strategi otomatis kembali ke
`StochRSI cross↑ / cross↓`. Deteksi cross tetap pada candle 15m yang sudah close (pakai
`small.slice(0,-1)`). Bias 4H tetap jadi acuan arah.



---

## 15. Cek manual sinyal + 24/7 keep-alive + SL dikunci (tanpa trailing)

- **Cek manual** (dispatch run 16:04Z, id 33261931533, sukses): provider binance-vision
  (735 pair), watchlist 167 (vol≥$1jt), 151 dipindai. Run ini menutup 11 posisi — a.l.
  **BONKUSDT SELL → SL −2.13%** (sinyal yg ditanya user; mantul naik → kena SL, sesuai dugaan),
  TWTUSDT BUY → TP1,TP2 +4.09%. Totals: open=27 (6 FIB + 21 Spike lama), closed=1996,
  winrate 41.9%, net +219.58%. Mesin sehat end-to-end (fetch→scan→advance→stats→commit/push).
  Run ini 0 sinyal baru (normal — belum ada cross di candle 15m baru close + bias 4H searah).

- **Masalah 24/7**: scheduled cron GitHub tidak andal (gap sampai 7 jam). Repo PUBLIC →
  Actions gratis tanpa batas. Solusi: **workflow keep-alive self-perpetuating** (`scanner.yml`
  ditulis ulang): satu run memindai tiap 5 menit selama ~5,25 jam (loop internal), lalu
  **memicu dirinya sendiri** via `workflow_dispatch` (butuh secret **SCANNER_PAT**, fine-grained
  PAT izin Actions read&write). Node dinaikkan ke 22. Schedule diubah `*/5`→`*/30` sbg jaring
  pengaman restart. Tanpa PAT: tetap memindai ~5,25 jam per trigger (jauh lebih baik dari 1
  scan/trigger), lalu andalkan schedule.
  ⚠️ TODO USER: buat secret `SCANNER_PAT` (Settings → Secrets → Actions) agar benar-benar nonstop.
  Langkah PAT sama dengan docs/cron-setup.md Langkah 1.

- **SL dikunci — tidak dinaikkan** (permintaan user): `strategy.trailing` di-set **false**.
  SL TETAP di harga stop-loss awal sepanjang posisi hidup — tidak pindah ke breakeven/entry
  saat TP1, tidak ke TP1 saat TP2. Staged exit tetap (tiap TP tutup 1/3). Diuji via
  advancePosition (SL tetap 95 walau TP1&TP2 kena). 7 posisi terbuka yang SL-nya sudah
  terlanjur dinaikkan (ZBT, EUL, KAITO, GMX, FIL, AXS, TRUMP) di-reset ke `slInit`.
  Komentar header & `management` string diperbarui.



---

## 16. Halaman Performa: tanggal "data per" + kolom tanggal close per coin

- **Tanggal halaman Performa**: chip `📅 Data per <dd Mmm yyyy, HH:MM>` di atas tab Performa
  (id `perf-asof`, diisi dari `stats.updatedAt` via `fmtDateTime`).
- **Kolom TERAKHIR CLOSE** di tabel "Performa per Coin": tanggal/waktu close trade terakhir
  per pair. Format via helper baru `closeLabel(iso)`: < 24 jam → relatif ("5 menit/jam yang
  lalu"), ≥ 24 jam → tanggal ("28 Agu 2026"). Hover = datetime lengkap.
- **Backend** (`computeStats`): tiap entri `byPair` kini punya `lastExit` = exitTime terbaru
  (max) trade pair itu. Diisi saat agregasi history; `_lastMs` sementara dihapus dari output.
- Diuji: computeStats mengambil exitTime terbaru per pair; closeLabel benar utk 30dtk/1mnt/
  5jam/23jam/25jam/3hari/null.
- Catatan: kolom baru terisi setelah run scanner berikutnya menulis `lastExit` ke stats.json
  (keep-alive loop akan pull kode baru & regen). Sebelum itu tampil "—".



---

## 17. Tabel per-coin scroll + verifikasi lastExit live + bereskan run macet

- **Tabel "Performa per Coin" scroll internal** (permintaan user, steering): wrapper diberi
  class `.tbl-scroll` (`max-height:360px; overflow:auto`, ≤640px 320px) + `thead th` sticky.
  Tabel tidak lagi memanjang ke bawah; header nempel saat digeser. Commit `bafaa11`.
- **Verifikasi lastExit LIVE**: sempat terlihat "belum terisi" karena run keep-alive 19:26
  (mulai loop 21:29) MACET — tidak push commit sejak 21:24 (kemungkinan push gagal/network
  transient di run itu; BUKAN karena kode — `computeStats` diuji dgn history asli 2001 trade
  → 358 pair semua dapat lastExit, tanpa error). Solusi: cancel run 19:26 (33270868267) &
  pending 23:03 (33280044049), dispatch run segar (33280487806). Run segar commit 23:14 dgn
  lastExit utk 358 pair. Kolom TERAKHIR CLOSE tampil benar: PEPE/INJ "8 jam yang lalu",
  ZAMA "28 Agu 2026".
- **Catatan**: keep-alive tetap butuh secret `SCANNER_PAT` agar benar-benar 24/7 (tanpa PAT
  loop berhenti ~5,25 jam & andalkan schedule yg tak andal). Sudah diingatkan ke user.



---

## 18. Breakdown akurasi per kategori sinyal (STRONG/MODERATE/WEAK) + daftar coin

Permintaan user: tiap coin punya kategori STRONG/MODERATE/WEAK — tampilkan akurasi %,
return, SL per kategori, dan coin apa saja di tiap kategori (lengkap skor), di History &
Performa.

- **Backend** (`computeStats` → `stats.byValidity`): untuk tiap kategori (STRONG≥75,
  MODERATE 58–74, WEAK<58, pakai `t.intel.validity`/score dari history) hitung: `trades`,
  `wins`, `winrate` (akurasi), `net`, `avgReturn` (net/trade), `sl` + `slRate`, `tp1/2/3`,
  `avgScore`, dan `coins[]` = daftar pair di kategori itu {pair, trades, winrate, net,
  avgScore} urut trade terbanyak.
- **Frontend**:
  - Tab **History**: kartu "🎯 Akurasi per Kategori Sinyal" — tabel ringkas (KATEGORI, SKOR,
    TRADE, AKURASI, RETURN, AVG/TRADE, SL%) via `mo-validity-body`.
  - Tab **Performa**: kartu sama (`lv-validity-body`) + **daftar coin per kategori** dalam
    `<details>` yang bisa diklik (`lv-validity-coins`) — tabel PAIR/SKOR/TRADE/WR/NET, scroll.
  - Fungsi `renderValidity(stats)` mengisi ketiga elemen; dipanggil di `renderLive`.
- Diuji dgn history asli (2007 trade): STRONG 893t/39.6% WR/net −238%/SL 90.7%/avgSc 81.9/276
  coin; MODERATE 1076t/39.6%/net −129%/SL 88.6%; WEAK 38t/31.6%/net −26%/SL 89.5%. Insight:
  akurasi antar-kategori mirip → skor tinggi belum tentu lebih akurat (bahan evaluasi strategi).
- Kolom baru terisi setelah run scanner berikutnya menulis `byValidity` ke stats.json.



### 18b. Detail TP1/TP2/TP3 per kategori + TP/SL per coin

Lanjutan #18 (permintaan user: akurasi TP1/TP2/TP3 & detail coin):
- **Backend** `byValidity`: tambah `tp1Rate/tp2Rate/tp3Rate` (% trade menyentuh target) per
  kategori; tiap coin di `coins[]` kini punya `tp1/tp2/tp3/sl` (count).
- **Frontend**: tabel kategori (History & Performa) kolom jadi KATEGORI·SKOR·TRADE·TP1·TP2·
  TP3·SL%·AKURASI·RETURN. Tabel coin per kategori (Performa) tambah kolom TP1·TP2·TP3·SL.
- Data live (all history): STRONG TP1 39.7%/TP2 20.1%/TP3 9.4%; MODERATE 39.6/22.6/11.4;
  WEAK 31.6/18.4/10.5. SL 88–91% semua. Commit di sesi ini.



### 18c. Tanggal close per coin + klik coin → popup trading plan

Permintaan user: tanggal (relatif <24j: "5 menit/3 jam yang lalu") di daftar coin, dan tiap
coin history bisa diklik → popup trading plan.
- **Backend** `byValidity.coins[]`: tambah `lastExit` (exitTime trade terbaru) + `lastId`
  (id trade terbaru) per coin.
- **Frontend** (daftar coin per kategori di Performa): nama coin diberi tanggal close di
  bawahnya via `closeLabel()` (relatif <24j, else tanggal). Baris jadi `.clickable-row`
  (hover biru) → `onclick=openStratModalFromHistory(lastId)` membuka popup trading plan
  (reuse modal `stratModal` + `showStratModal(t,true)`, infra sudah ada dari Recent Signals
  Log). Ikon 🔎 penanda bisa diklik.
- history.json TIDAK di-cap → semua id selalu ketemu di `liveHistory`. Diuji: lastId coin
  ada di history=true; syntax run.js & inline JS OK.
- Popup membuka trade TERBARU coin itu (per kategori). Semua trade lama tetap bisa dilihat
  via Recent Signals Log (tab Akun).
