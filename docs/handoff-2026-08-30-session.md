# Handoff / Log Percakapan — Sesi 2026-08-30

Lanjutan dari `docs/handoff-2026-08-29-popup-chart.md`. Semua perubahan di branch `main`.
Sesi ini fokus: fitur dashboard (tab Akun & notifikasi), penyesuaian chart, setup
cron otomatis (cron-job.org), evaluasi kondisi sistem, dan penambahan catatan rumus strategi.

---

## 1. Donut winrate mengikuti bulan aktif kalender (tab Akun)

**Permintaan:** winrate (donut di sub-tab Akun) mengikuti bulan yang aktif di kalender
return harian — tiap bulan punya angka winrate sendiri. Taruh di main.

**Aksi (commit `aee553f`):**
- `renderWinratePie()` tidak lagi seluruh histori → difilter per **bulan aktif**
  (`calYear`/`calMonth`, cocokkan `exitTime` = `YYYY-MM`).
- Dipanggil dari dalam `renderPnlCalendar()` → ganti bulan (nav ‹/›) otomatis update donut.
- Tambah chip **label bulan** di header kartu Winrate (mis. "Agu 2026"); tampil `—` bila
  bulan tanpa trade.
- Data terbukti beda per bulan: Jun 35.4% / Jul 38.7% / Agu 41.3%.

---

## 2. Toggle chart popup: 5m/15m/4H → 1D/4H/15m (default 4H)

**Permintaan:** chart 5m sering gagal muat; ganti jadi 1D/4H/15m, default 4H. Tanpa
mengubah rumus.

**Aksi (commit `91bcf46`):**
- Tombol toggle chart jadi **1D / 4H / 15m** (default aktif 4H). `5m` dihapus (memang tak
  ada di `STRAT_TF_MS` → penyebab gagal muat).
- Panel **Multi-TF** ikut jadi **D / 4H / 15m** (hapus 5m), grid jadi 3 kolom
  (`.mtf-grid repeat(3,1fr)`).
- Rumus strategi/scanner TIDAK disentuh.

---

## 3. Setup scanner otomatis 24/7 via cron-job.org (BERHASIL)

**Konteks:** scheduled cron GitHub tak andal. Workflow `scanner.yml` sudah keep-alive
(loop scan tiap 5 menit selama ~5,25 jam per run) + bisa dipicu `workflow_dispatch`.

**Yang dilakukan user (dipandu step-by-step):**
- Buat **Fine-grained PAT** khusus `winrate_backtest` (izin **Actions: Read & write**).
  (User sebelumnya punya cronjob untuk repo `terminal`; token itu fine-grained & hanya
  akses repo terminal, jadi dibuat token/akun baru agar terminal tak tersentuh.)
- Buat cronjob baru di cron-job.org:
  - URL: `https://api.github.com/repos/chamdani49-boop/winrate_backtest/actions/workflows/scanner.yml/dispatches`
  - Method **POST**, body `{"ref":"main"}`
  - Headers: `Accept: application/vnd.github+json`, `Authorization: Bearer <PAT>`,
    `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
  - Schedule tiap 5 menit (disarankan bisa diperjarang ke 15–30 menit karena keep-alive).
- **Test run → HTTP 204 (sukses).**

**Validasi (dilakukan agent via `gh api` + git log):**
- Run `#1363` (schedule) **in_progress** = loop aktif memindai.
- Trigger cron-job.org masuk sebagai `workflow_dispatch` ("Manually run by chamdani49-boop"),
  berstatus **pending** karena `concurrency: scanner` mengantre di belakang run in-progress
  (perilaku benar, tidak menumpuk).
- Commit `chore(scanner): update data …` konsisten tiap **±5m24s** tanpa putus
  (mis. 11:47 → 11:53 → … → 12:41Z). **Kesimpulan: scanner 100% jalan 24/7 & sehat.**

**Cara user memantau sendiri:** cek **Commits** (indikator paling akurat), tab **Actions**
(ada run In progress / workflow_dispatch berkala), atau chip "Data per …" di dashboard.

> Catatan: secret `SCANNER_PAT` (self-relaunch internal) TIDAK jadi dipakai karena
> cron-job.org sudah menangani pemicuan ulang. Opsi itu tetap tersedia bila mau tanpa
> layanan eksternal.

---

## 4. Interval update harga (penjelasan, tanpa perubahan kode)

- **Harga coin posisi terbuka (dashboard):** realtime via WebSocket Binance *miniTicker*
  ~**1 detik**; fallback REST polling tiap **30 detik** bila WS putus/diblok.
- **Harga BTC ticker:** tiap **20 detik** (`updateBtcLive`).
- **Data JSON (posisi/stats/history):** reload tiap **60 detik** (`loadLiveData`).
- **Event lonceng:** tiap **90 detik** (`fetchEventsOnce`).
- **Scanner (backend):** memindai & commit tiap **±5 menit**.

**Konfirmasi:** return **posisi terbuka** (floating P&L per kartu + "Floating" di simulasi
modal + Total Now) IKUT harga realtime (WS onmessage → update `lastPrice` → `scheduleRender`
→ `renderCapitalSim`/`simulateCapital` pakai `lastPrice`). Statistik **closed** (winrate,
net, PF, kalender, "Modal Sekarang" realized) TIDAK berubah oleh harga realtime — memang
terkunci di harga exit yang dicatat scanner.

---

## 5. Evaluasi kondisi sistem (penilaian jujur, berbasis data)

**Bagus (infra/produk ≈ 9/10):** otomasi 24/7 mulus, dashboard kaya (harga realtime, chart
pro + SMC, tab Live/Performa/History/Akun, kalender, donut), pipeline data bersih.

**Perlu ditingkatkan (strategi/edge ≈ 5/10, rapuh):** angka 30 hari: winrate 41%,
net +158%, **PF 1.07 (nyaris impas)**. Bulanan: Agu +163%/PF1.07 tapi Jul −301%/PF0.75,
Jun −264%/PF0.66. `byValidity` all-time semua NEGATIF (tercampur strategi spike lama).
Masalah konkret:
1. **Fee & slippage TIDAK dimodelkan** (dicek di `run.js`) → dgn PF 1.07, biaya nyata
   kemungkinan bikin impas/rugi. **Prioritas #1.**
2. **SL rate ~89%** — hampir semua trade kena SL (SL terlalu ketat / entry telat).
3. **Skor STRONG/MODERATE/WEAK tak membedakan akurasi** (39.3/39.5/31.6%) → skoring
   kurang prediktif.
4. **Histori campur** (spike lama + FIB) → evaluasi keruh; sebaiknya pisah FIB-only.
5. **Tanpa time-stop, 57 posisi terbuka** → modal bisa nyangkut.

**Rekomendasi urutan garap:** (1) modelkan fee+slippage, (2) perbaiki SL/TP, (3) pisah
statistik FIB-only, (4) rework/drop skor validity. *(Belum dikerjakan — menunggu keputusan user.)*

---

## 6. Notifikasi lonceng bisa diklik → buka popup chart/trading plan

**Permintaan:** tiap item di dropdown "Notifikasi Robot" bisa diklik → popup chart seperti
yang sudah ada.

**Aksi (commit `a0eb82e`):**
- Fungsi baru `openStratModalFromEvent(pair, dir, ts)`: event hanya punya pair/dir/ts
  (tanpa TP/SL), jadi cocokkan ke trade lengkap → (1) posisi terbuka `liveOpen` (pair+dir),
  (2) fallback histori `liveHistory` dgn waktu (open/exit) paling dekat ke `ts`, lalu
  `showStratModal`. Bila tak ada → `notify` info.
- `renderBell()` tiap item diberi class `.clickable` + `onclick` + ikon 🔎; panel lonceng
  auto-tutup saat item diklik. CSS hover hijau ditambahkan.
- Reuse penuh popup `stratModal` yang sudah ada.

---

## 7. Catatan rumus strategi (BARU — belum diimplementasi)

Ditulis ke **`.kiro/steering/strategy-rules.md`** (agar persist & jadi acuan pengembangan)
dan handoff lama bagian **#19 & #20**.

### #19 — Gate zona cross StochRSI di 4H (commit `f2abc2f`)
Temuan user: SHORT saat StochRSI 4H cross bearish **di bawah 40** (oversold, StochRSI ~6)
= jelek. Aturan (acuan 4H, pakai %K):
- **SHORT** valid hanya bila cross/kondisi bearish **di ATAS 40** (bawah 40 = jangan short).
- **LONG** valid hanya bila cross/kondisi bullish **di BAWAH 80** (atas 80 = jangan long).
- Prinsip: short butuh "ruang turun" (%K>40); long butuh "ruang naik" (%K<80).

### #20 — Konfirmasi MACD "bar hijau/merah pertama" di 4H (commit `8b83097`)
Temuan user (sinyal LONG bagus): MACD 4H **bar histogram hijau pertama** (merah→hijau /
tembus 0 ke atas) = konfirmasi LONG bagus, didukung **RSI>50** & **StochRSI masih bullish
(%K≥%D) walau >80**. Lalu cek pemicu 15m. SHORT kebalikannya (bar merah pertama, RSI<50,
StochRSI bearish walau <20).
- **Interaksi dgn #19:** gate "long<80/short>40" = default hati-hati; **pengecualian** saat
  ada bar MACD hijau/merah pertama + RSI searah → StochRSI ekstrem searah momentum
  (long>80 / short<20) TETAP boleh.

**Rencana implementasi (tercatat, belum dikerjakan):**
- #19: param `stoch4hZoneGate`(true)/`stoch4hShortMin`(40)/`stoch4hLongMax`(80).
- #20: param `macdFirstBarConfirm` + deteksi transisi histogram (hijau pertama:
  `bar[t]>0 && bar[t-1]<=0`; merah kebalikannya).
- Keduanya di `detectSignalIndicator` bagian acuan 4H + selaraskan `buildIntelIndicator`.

---

## Urutan commit (branch main) — sesi ini
```
aee553f  feat(akun): donut winrate mengikuti bulan aktif kalender
91bcf46  fix(popup): toggle chart 1D/4H/15m (default 4H) + Multi-TF D/4H/15m
a0eb82e  feat(notif): item notifikasi lonceng clickable → popup chart/trading plan
f2abc2f  docs(rumus): #19 gate zona cross StochRSI 4H (short>40, long<80)
8b83097  docs(rumus): #20 konfirmasi MACD bar hijau/merah pertama di 4H
```
*(Di sela-sela ada banyak commit otomatis `chore(scanner): update data …` dari keep-alive.)*

## TODO berikutnya (menunggu keputusan user)
- Implementasikan catatan rumus #19 & #20 ke `scanner/run.js` + `config.json` bila diminta.
- Peningkatan strategi: modelkan fee+slippage (prioritas), perbaiki SL/TP (SL rate 89%),
  pisah statistik FIB-only, rework skor validity.
- (Opsional) turunkan frekuensi cron-job.org ke 15–30 menit agar antrean run tak ramai.
