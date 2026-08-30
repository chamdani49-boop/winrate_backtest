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
