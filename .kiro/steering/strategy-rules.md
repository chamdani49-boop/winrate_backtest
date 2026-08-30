# Catatan Rumus Strategi (winrate_backtest)

Kumpulan aturan/koreksi strategi robot sinyal. Terapkan saat mengubah
`scanner/run.js` (`detectSignalIndicator`) & `scanner/config.json`, dan saat
menilai kualitas sinyal di `index.html` (`buildIntelIndicator`).

Ringkas strategi aktif (FIB): **pemicu di 15m**, **acuan arah di 4H**.
Entry candle 15m berikutnya; SL swing 15m; TP1/2/3 = ekstensi Fibonacci ×R.

---

## Aturan zona cross StochRSI di 4H (acuan arah)

> Ditambahkan atas temuan user: ada sinyal **SHORT** saat StochRSI **4H** cross
> bearish tetapi cross-nya berada **di bawah level 40** (StochRSI ~6, sudah sangat
> oversold) → rawan mantul naik, sinyal jelek. Aturan ini mencegah entry di area
> "sudah kelelahan / berlawanan dengan zona".

**Berlaku untuk timeframe 4H (acuan), memakai StochRSI %K:**

- **SHORT (cross/kondisi bearish %K ≤ %D):**
  hanya valid jika terjadi **DI ATAS level 40**.
  Jika di **bawah 40** (oversold) → **JANGAN SHORT** (rawan pantulan naik).
  → syarat: `stochK_4h > 40`.

- **LONG (cross/kondisi bullish %K ≥ %D):**
  hanya valid jika terjadi **DI BAWAH level 80**.
  Jika di **atas 80** (overbought) → **JANGAN LONG** (rawan koreksi turun).
  → syarat: `stochK_4h < 80`.

**Intinya:** untuk short, StochRSI 4H harus masih punya "ruang turun" (di atas 40);
untuk long, masih punya "ruang naik" (di bawah 80). Jangan melawan zona ekstrem.

### Rencana implementasi (belum diterapkan — ini baru catatan)
- Param config yang diusulkan (di dalam `strategy`):
  - `stoch4hZoneGate` (bool, default `true`) — aktifkan gate zona 4H.
  - `stoch4hShortMin` (default `40`) — SHORT hanya jika `stochK_4h > nilai ini`.
  - `stoch4hLongMax` (default `80`) — LONG hanya jika `stochK_4h < nilai ini`.
- Lokasi: `detectSignalIndicator(small, big, strat)` pada bagian evaluasi **acuan
  4H** — setelah menghitung StochRSI 4H (`big`), tambahkan filter di atas sebelum
  mengizinkan arah LONG/SHORT.
- Konsistenkan juga `buildIntelIndicator` di `index.html` agar skor tidak memberi
  nilai positif pada cross 4H yang melawan zona (short <40 / long >80).



---

## Aturan konfirmasi MACD "bar hijau/merah pertama" di 4H (acuan arah)

> Ditambahkan atas temuan user (gambar sinyal LONG yang bagus): saat MACD **4H**
> pada candle close menampilkan **bar histogram hijau PERTAMA** (momentum baru
> berbalik naik), itu konfirmasi kuat untuk LONG — dan pada kondisi ini StochRSI
> yang **masih bullish walau di atas 80** tetap OK (tidak dianggap "kelelahan").

**Berlaku untuk timeframe 4H (acuan). Memakai MACD histogram (DIF − DEA), RSI, StochRSI %K/%D:**

- **LONG (bagus) bila di 4H:**
  1. MACD histogram menunjukkan **bar hijau pertama** — histogram baru berubah dari
     negatif (merah) ke positif (hijau) / menembus garis 0 ke atas (momentum shift up).
  2. **RSI(14) > 50** (didukung momentum).
  3. **StochRSI masih bullish (%K ≥ %D)** — **boleh di atas 80** dalam kasus ini,
     karena momentum MACD baru berbalik naik (bukan sinyal kelelahan).
  4. Lalu **cek pemicu di 15m** (aturan pemicu 15m tetap seperti biasa).

- **SHORT (kebalikannya) bila di 4H:**
  1. MACD histogram **bar merah pertama** (baru berubah dari hijau → merah / menembus 0 ke bawah).
  2. **RSI(14) < 50**.
  3. **StochRSI masih bearish (%K ≤ %D)** — boleh di bawah 20.
  4. Lalu cek pemicu 15m.

**Catatan interaksi dengan aturan zona StochRSI (bagian sebelumnya):**
gate "long <80 / short >40" adalah kehati-hatian umum; **pengecualiannya** adalah
saat ada **bar MACD hijau/merah pertama + RSI searah** → StochRSI di zona ekstrem
searah momentum (long >80 / short <20) TETAP boleh, karena momentum baru berbalik.

### Status: baru CATATAN (belum diimplementasi).
Rencana: tambah param `macdFirstBarConfirm` (bool) & logika deteksi transisi
histogram (bar[t] > 0 && bar[t-1] <= 0 untuk hijau pertama; kebalikannya merah)
di `detectSignalIndicator` bagian acuan 4H, plus penyesuaian `buildIntelIndicator`.
