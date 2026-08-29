# Setup Scanner Otomatis via cron-job.org

Tujuan: memicu workflow `scanner.yml` **tiap 5 menit** dari luar, karena cron
bawaan GitHub Actions sering ditunda/dilewati. cron-job.org (gratis) akan
mengirim request ke GitHub API tiap 5 menit untuk menjalankan scanner.

---

## Langkah 1 — Buat GitHub Personal Access Token (PAT)

1. Buka: https://github.com/settings/personal-access-tokens/new
   (Settings → Developer settings → **Fine-grained tokens** → Generate new token)
2. Isi:
   - **Token name**: `cron-scanner`
   - **Expiration**: 90 hari (atau custom; catat tanggal perpanjang)
   - **Resource owner**: akun kamu (chamdani49-boop)
   - **Repository access**: *Only select repositories* → pilih **winrate_backtest**
   - **Permissions** → *Repository permissions* → **Actions** = **Read and write**
     (izin lain biarkan No access)
3. **Generate token** → SALIN token-nya (muncul sekali saja), simpan aman.
   Formatnya seperti: `github_pat_xxxxxxxx...`

> ⚠️ Jangan pernah commit token ini ke repo / bagikan ke publik.

---

## Langkah 2 — Buat Cron Job di cron-job.org

1. Daftar/masuk di https://cron-job.org → **Create cronjob**.
2. **Title**: `TVBT Scanner`
3. **URL**:
   ```
   https://api.github.com/repos/chamdani49-boop/winrate_backtest/actions/workflows/scanner.yml/dispatches
   ```
4. **Schedule**: Every **5 minutes** (pilih "Every 5 minutes", atau custom `*/5 * * * *`).
5. Buka bagian **Advanced / Request settings**:
   - **Request method**: `POST`
   - **Request body** (raw):
     ```json
     {"ref":"main"}
     ```
   - **Headers** (tambahkan satu per satu):
     | Key | Value |
     |-----|-------|
     | `Accept` | `application/vnd.github+json` |
     | `Authorization` | `Bearer github_pat_xxxxxxxx...` (token dari Langkah 1) |
     | `X-GitHub-Api-Version` | `2022-11-28` |
     | `Content-Type` | `application/json` |
6. **Save**.

---

## Langkah 3 — Uji & verifikasi

- Klik **Run now** / **Test run** di cron-job.org. Respons sukses = **HTTP 204**
  (tanpa body). Kalau 401 → token salah/izin kurang; 404 → URL/nama workflow salah.
- Cek di GitHub → tab **Actions** → workflow **Scanner 24/7** harus muncul run baru
  dengan trigger `workflow_dispatch`.
- Setelah beberapa siklus, cek halaman **Robot Live** → sinyal baru muncul otomatis.

---

## Catatan
- **204 No Content** itu normal & artinya sukses (GitHub tidak mengembalikan body).
- Scanner tetap punya guard `concurrency: scanner` → run tidak akan tumpang tindih.
- Kalau token kadaluarsa (sesuai Expiration), job akan mulai gagal (401) → buat token
  baru dan update header Authorization di cron-job.org.
- Alternatif lebih andal: jalankan `node scanner/run.js` tiap 5 menit di VPS/Railway/
  Render cron (butuh push balik ke repo pakai token) — lebih kompleks, opsional.
