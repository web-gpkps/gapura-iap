# IAP Monitoring Dashboard

Dashboard Next.js untuk Improvement Action Plan PT Gapura Angkasa. Semua read dan
write aplikasi melalui **Supabase**; Google Sheets menjadi mirror dua arah.
Traffic dashboard tidak memakai quota Sheets.

## Konfigurasi

```bash
npm install
npm run dev
```

Environment server pada `.env.local`:

```dotenv
DATA_BACKEND=supabase
SUPABASE_URL=https://your-project.supabase.co # opsional; default NEXT_PUBLIC_SUPABASE_URL
SUPABASE_IAP_SERVER_TOKEN=token_gateway_server
IAP_SYNC_TOKEN=token_worker_mirror
```

Gateway `iap-data` hanya mengizinkan RPC snapshot dan CRUD IAP. Token divalidasi
terhadap Vault; service role key tetap berada di runtime Supabase Edge. Alternatif:
isi `SUPABASE_SERVICE_ROLE_KEY` pada server untuk akses REST langsung.
Secret key `sb_secret_...` juga didukung. Semua credentials harus server-only,
tanpa awalan `NEXT_PUBLIC_`.

Mode offline harus dipilih eksplisit dengan `DATA_BACKEND=memory` dan
`SHEETS_TRANSPORT=memory`; mode ini memakai fixture 66 item dan sembilan konteks.
Konfigurasi Supabase yang salah tidak beralih ke Sheets atau fixture.

## Schema dan performa

`iap_tracker` mempertahankan mapping **Tracker A–W**:

| Sheets | Supabase |
| --- | --- |
| A–E | no, iap_id, title, station, step_no |
| F–J | step, action, pic, timeline, target_date |
| K–O | status, progress, actual_date, stored_overdue, evidence |
| P–Q | context_note, evidence_link |
| R–W | incident, parties, purpose, effective_date, root_cause, kpis |

A, E, L adalah integer. Tanggal dan KPI tetap text untuk menjaga format Indonesia
dan newline Sheets. Primary key `(iap_id, step_no)` juga melayani query per kasus;
index urutan melayani snapshot. Trigger menambah version dan updated_at pada edit,
termasuk perubahan langsung melalui Studio.

CRUD memakai transaksi RPC: create beserta konteks, update metadata beserta konteks,
append evidence multi-key, penomoran langkah dan delete. Penomoran memakai lock
database singkat, tanpa menahan lock saat panggilan Google. Evidence di-union
secara atomik agar link penulis lain tidak hilang.

Item dan konteks dashboard berbagi satu snapshot per render. Snapshot RPC
menghindari pemotongan response tabel PostgREST 1.000 baris. Tidak ada cache
antar request. Browser terlihat refresh setiap menit ketika formulir tertutup.
Overdue dihitung dengan tanggal Asia/Jakarta; save memperbaiki N, page load tidak
menulis.

RLS aktif pada ketiga tabel IAP; grants anon/authenticated dicabut. Akses data
melalui server. Model akses aplikasi tetap tanpa login seperti sebelumnya.

## Mirror dua arah

Edge Function `iap-google-mirror` dipicu **Apps Script webhook saat sheet diedit**,
dengan **pg_cron + pg_net** sebagai jaring pengaman berkala.
Credentials Google service account berada di Vault, bukan browser atau repository.

Worker memakai lease untuk mencegah overlap, memvalidasi header dan composite key,
lalu membandingkan Sheets, database, dan baseline terakhir per kolom. Perubahan
kolom berbeda digabung. Konflik pada kolom sama mempertahankan Supabase dan
mencatat kedua nilai di `iap_sync_conflicts`.

Inbound memakai compare-and-set version dalam transaksi. Outbound membaca ulang
Sheets untuk mendeteksi edit dan pergeseran baris, menulis hanya sel yang berubah
dalam batch atomik, lalu memverifikasi hasil sebelum mengakui baseline.
Range tetap membuat retry idempotent, tanpa append yang berisiko duplikat setelah
timeout. Grid diperluas dalam batch yang sama bila diperlukan.

Delete diteruskan kedua arah. Outbound delete mengosongkan A–W, sehingga baris
fisik/formula kolom lain tidak bergeser. Nomor A tetap berasal dari Supabase.
Tracker mendadak kosong ditolak jika baseline sebelumnya berisi data, untuk
mencegah wipe massal. Header berubah, key duplikat, angka/status invalid harus
diperbaiki operator sebelum worker dapat berjalan kembali.

**Batas konkurensi:** Sheets tidak memiliki compare-and-set untuk edit manual.
Edit tepat antara pembacaan terakhir dan batch masih dapat berbenturan. Worker
memverifikasi setelah write dan tidak mengakui baseline yang gagal diverifikasi.
Gunakan aplikasi sebagai jalur utama untuk edit bersamaan pada sel yang sama.

Save Supabase tetap berjalan ketika mirror menunggu retry.

### Real time

Dua lapis push menggantikan polling:

1. **Sheets → Supabase.** `scripts/apps-script/iap-sheet-webhook.gs` dipasang di
   spreadsheet sebagai installable trigger `onEdit` dan `onChange`. Setiap edit,
   insert, atau delete row memanggil Edge Function dengan `{"force":true}`.
   `iap_sync_acquire(p_token, p_force)` melewati cooldown 50 detik hanya bila
   siklus terakhir sehat (`failures=0`); backoff akibat error tetap dihormati,
   sehingga mirror rusak tidak dihantam rentetan edit. Edit yang datang saat
   sync berjalan ditandai `pending` dan disapu di putaran berikutnya.
2. **Supabase → dashboard.** Trigger statement-level `iap_tracker_broadcast`
   mengirim ping kosong lewat `realtime.send()` ke topik privat `iap-tracker`.
   Browser hanya menerima fakta "ada perubahan", lalu `router.refresh()` menarik
   render server yang tetap memfilter per cabang — tidak ada baris cabang lain
   yang melewati websocket. Policy pada `realtime.messages` membatasi topik itu
   ke user `authenticated`. Ping gagal tidak pernah me-rollback write pemicunya.

Latensi ujung ke ujung sekitar 3–6 detik. `useLiveRefresh` menyimpan interval
cadangan 2 menit untuk websocket yang diblokir proxy, dan menahan refresh selama
dialog terbuka agar isian tidak hilang.

Cron berjalan tiap 5 menit sebagai jaring pengaman; migration
`20261028120000_cut_sync_egress` mengubah jadwal job yang sudah ada. Edit dari
aplikasi sampai ke Sheets paling lambat 5 menit.

### Egress

Project pernah dibatasi Supabase karena egress: tiap menit worker mengunduh
seluruh tracker tiga kali (baseline bersama lease, snapshot sebelum dan sesudah
rekonsiliasi), sekitar 1,35 MB per siklus walau data tidak berubah.

Kini setiap write ke `iap_tracker` menaikkan `iap_tracker_rev` dalam transaksi
yang sama. `iap_sync_state` menyimpan fingerprint SHA-256 baseline dan rev saat
sync terakhir. Siklus tanpa perubahan hanya membandingkan fingerprint Sheets dan
rev, lalu selesai tanpa mengunduh apa pun. Baseline hanya diunduh bila Sheets dan
Supabase sama-sama berubah; snapshot kedua hanya diambil bila apply menulis baris.

Dashboard memakai `iap_snapshot_since(rev)`: server Next.js menyimpan snapshot
terakhir per instance dan hanya mengunduh ulang bila rev naik. Filter cabang tetap
berjalan per request.

### Quota

Siklus tanpa perubahan memakai satu read Sheets; siklus dengan perubahan memakai tiga.
Write menambah satu metadata read dan satu batch.
Request dijarakkan minimal 1,5 detik per jenis quota. 429/5xx memakai exponential
backoff, jitter, Retry-After, maksimal empat attempt. Permission/validation error
tidak diulang cepat. Job gagal memakai backoff persisten 1–60 menit; lease worker
crash kedaluwarsa setelah lima menit. Retry-After yang lebih panjang menjadi batas
minimum jadwal retry; worker Edge membatasi panggilan Google sampai tiga menit.
Payload batch dibatasi 1,8 MB; tracker
melampaui batas memerlukan pemecahan batch lebih lanjut.

Lihat [quota resmi Sheets](https://developers.google.com/workspace/sheets/api/limits).

### Operasi dan setup project baru

```bash
npm run migrate:preview # validasi Sheets tanpa write
npm run migrate:supabase # import awal / rekonsiliasi terverifikasi
npm run sync:sheets # satu siklus; dapat dilewati karena lease/backoff
npm run sync:bundle # salin shared source sebelum redeploy worker
```

Apply SQL di supabase/migrations terlebih dahulu. Versi lokal sesuai history
remote, termasuk empat migration auth yang sudah ada sebelumnya. Isi Vault:
- `iap_google_mirror`: JSON berisi spreadsheetId, clientEmail, privateKey, tab.
- `iap_sync_token`: token worker yang sama dengan IAP_SYNC_TOKEN.
- `iap_server_token`: token yang sama dengan SUPABASE_IAP_SERVER_TOKEN.

Deploy iap-data dan iap-google-mirror dengan JWT verification nonaktif;
keduanya tetap memverifikasi token server. Urutan deploy: migration, lalu kedua
function, lalu Next.js — gateway harus sudah mengizinkan `iap_snapshot_since`
sebelum aplikasi memanggilnya. Setelah import berhasil, aktifkan cron:

```sql
select cron.schedule('iap-google-mirror', '*/5 * * * *', $job$
 select net.http_post(
  url := 'https://YOUR_PROJECT.supabase.co/functions/v1/iap-google-mirror',
  headers := jsonb_build_object('Content-Type','application/json',
   'x-iap-sync-token',(select decrypted_secret from vault.decrypted_secrets where name='iap_sync_token')),
  body := '{}'::jsonb, timeout_milliseconds := 90000
 );
$job$);
```

Pantau iap_sync_state.last_success_at, last_error, failures, next_run_at.
History konflik ada di iap_sync_conflicts; __row__ menandakan konflik delete/edit.
Cron history hanya membuktikan dispatch; keberhasilan mirror diperiksa dari state.

## Evidence, export, dan deployment

File evidence tetap di Drive. URL disimpan di Supabase lalu dimirror ke Q.
HTTP/HTTPS divalidasi dan link Drive dibuat view-only. Upload ke My Drive memakai
OAuth akun pemilik folder. Isi GOOGLE_DRIVE_EVIDENCE_FOLDER_ID dan tiga
GOOGLE_DRIVE_OAUTH_* credentials; lihat .env.example. Jalankan
`npm run authorize-drive` untuk menyimpan refresh token baru ke `.env.local`.
DOCX dan PDF/print membaca repository Supabase yang sama.

Set environment Supabase/gateway di host Next.js serta credentials Drive bila
upload diperlukan. .env.local tidak ikut deployment. Mirror berjalan di Supabase,
tanpa cron Vercel.

## Verifikasi

```bash
npm run typecheck
npm run build
npm run test:sync
npm run test:only
npm run verify:supabase
npm run verify:app # jalankan Next.js Supabase di port 3102 dahulu, atau set IAP_VERIFY_URL
```

Unit tests menguji merge, konflik, delete, lease, CAS failure dan recovery.
supabase/tests/transaction_checks.sql menguji CRUD, overdue, rollback multi-key,
version, CAS, dan grants dalam transaksi rollback. verify:supabase memakai
ID unik sementara di project terhubung dan menghapusnya dalam finally.

Playwright memakai memory backend eksplisit dengan tanggal/timezone terkontrol.
Suite UI tersebut tidak membuktikan integrasi cloud; RPC dan mirror live diuji
terpisah. Endpoint /api/test/* tidak tersedia pada backend Supabase.
