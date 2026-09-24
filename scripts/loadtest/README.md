# Gapura: load test produksi dengan batas jelas

## Temuan aplikasi

- Next.js 15 Server Actions; **bukan** API REST CRUD `/api/items`.
- Supabase PostgreSQL + Supabase Auth; role/status/cabang dari `profiles`.
- 39 stasiun + PUSAT = **40 pilihan**, 5 akun per pilihan = **200 akun**.
- Evidence: POST sesi → PUT langsung ke Google Drive → PATCH konfirmasi. Byte file tidak melalui Vercel.
- Mirror Supabase ↔ Google Sheets terjadwal tiap menit. Menghapus DB saja belum membuktikan cleanup selesai.
- `iap_mutate` menomori ulang seluruh tracker setelah create/delete. Create menambah di akhir; delete bisa mengubah nomor record lain. Karena itu **production tidak menjalankan action delete**. Cleanup menghapus ID test langsung tanpa penomoran ulang. Skenario isolated menjalankan delete action untuk 10% VU.

## Yang benar-benar dijalankan

Lihat [laporan](../../docs/loadtest-report.md). Hasil smoke halaman login tidak membuktikan kapasitas dashboard, DB, upload, atau 200 pengguna.

`test-results/` diabaikan Git. Manifest berisi baseline data privat dan ID akun; simpan lokal, jangan dibagikan. Tidak berisi password, secret key, session URL, atau token auth. Laporan k6 hanya metrik agregat.

## Limit dan anggaran

[Vercel Hobby](https://vercel.com/docs/plans/hobby): 4 CPU-jam, 1 juta Edge Requests, dan 360 GB-jam provisioned memory. Hobby untuk penggunaan pribadi nonkomersial; sistem perusahaan perlu dievaluasi terhadap ketentuan itu. [Batas function](https://vercel.com/docs/functions/limitations): Fluid Compute Hobby default/maksimum 300 detik; konfigurasi lama bisa berbeda. `vercel.json` repo tidak menetapkan timeout. Batas concurrency platform bukan anggaran aman aplikasi.

[Vercel load-testing guidance](https://vercel.com/kb/guide/how-to-effectively-load-test-your-vercel-application) menyarankan gradual ramp dan pengujian integrasi aplikasi; preview dalam tim sama tetap memakai kuota tim. Tidak ada jaminan “tidak pause” jika sisa kuota diabaikan. CPU aktif **bukan** latency × jumlah request. Pantau CPU/memory/invocation/transfer di Usage selama tes. Anggaran request tidak membatasi konsumsi CPU secara pasti.

[Supabase Auth](https://supabase.com/docs/guides/auth/rate-limits): mailer bawaan 2 email/jam, token endpoint default 150/5 menit per IP dengan burst 30. Limit `/user` dan signup juga berlaku. Middleware aplikasi memanggil Auth untuk request halaman; login saja bukan satu-satunya pemakai kuota. Jangan rotasi IP atau mematikan proteksi untuk melewati limit. Project aktual dapat berbeda; 429 langsung menghentikan suite.

Production default:

| Batas | Nilai |
|---|---:|
| Peak terkonfigurasi | 200 VU; terukur bisa lebih rendah jika dihentikan |
| Global rate | 4 request/detik, satu proses k6 |
| Jumlah request target | ≤ 50 × peak + 50 setup; default ≤ 10.050 |
| Durasi ramp | 13 menit 30 detik + drain maksimal 3 menit |
| File | 1–3/VU sekali selama run; default total 401 file untuk 200 VU |
| Ukuran fixture | PDF kecil, JPG sekitar 15 KB, PNG sekitar 49 KB; **bukan uji payload maksimum** |
| Maksimum file yang diterima skrip | 2 MiB/file |
| Seed | 200 akun confirmed tanpa email + 200 record baru |
| Registrasi production | Tidak dijalankan; email konfirmasi aktif, alamat example.com bukan inbox uji |
| Cleanup | Di luar durasi workload; menunggu inflight + mirror |

RPS cap menambah antrean di generator. 200 VU tidak sama dengan 200 request serentak. Target siklus 120–160 detik, tetapi throttling/latency dapat memperpanjangnya; jangan mengklaim target 2–3 menit tercapai tanpa mengukur iterasi. Login pertama mendapat stagger 0–4 detik per cabang, selain ramp global dan batas RPS.

## Perintah

Prasyarat: Node, dependency repo, k6 lokal. Tidak perlu dependency aplikasi tambahan. Fixture memakai `sharp` yang sudah tersedia melalui Next.js.

```sh
npm run loadtest:check
k6 run scripts/loadtest/k6-check.js  # tanpa jaringan
npm run loadtest:plan

# Di .env.local: key Admin Supabase, koneksi Supabase yang sama dengan deployment,
# koneksi owner Google Drive, service account Sheets, folder dan spreadsheet target.
# Key admin hanya di mesin operator. Jangan tambahkan NEXT_PUBLIC_ pada secret.
export LOADTEST_PASSWORD='<password akun test>'

npm run loadtest:seed
npm run loadtest:run
npm run loadtest:verify
```

`BASE_URL` default production yang diminta. `PEAK=10` mengurangi peak, bukan jumlah akun seed. `MAX_RPS` default/maksimum 4. `K6_BIN` menerima path executable jika k6 tidak di PATH. Setup/capture action IDs dilakukan terhadap deployment yang sedang diuji; redeploy di tengah tes dapat menggagalkan action dan harus dianggap run tidak valid.

Jangan menjalankan dua runner bersamaan. Jangan menjalankan file journey langsung: wrapper menjamin cleanup setelah exit, kegagalan setup, atau SIGINT. SIGKILL/mesin mati tidak bisa menjalankan `finally`; pemulihan:

```sh
npm run loadtest:cleanup
npm run loadtest:verify
```

Manifest lama tidak ditimpa/reuse. Setelah verification `clean: true`, arsipkan seluruh `test-results/loadtest/` ke direktori privat lain sebelum run baru. Akun berpola sama yang sudah ada **menolak seed**, tidak diambil alih atau dihapus.

Smoke publik berdiri sendiri; maksimal 100 GET `/login`, tanpa akun/record/file:

```sh
k6 run scripts/loadtest/smoke.js
```

## Skenario dan correlation

- 100% login via form Next aktual, GET dashboard, GET refresh, logout.
- Dari setiap kelompok 10 VU: 5 create, 3 update, 1 delete (delete hanya isolated). Peluang dijadikan pembagian deterministik agar dapat diaudit; sample kecil tidak mencerminkan rasio persis.
- Update/upload hanya pada seed record milik VU. Create memakai ID `loadtest_<run>_<vu>_<cycle>`.
- Form hidden `$ACTION_*` dibaca ulang, cookie jar k6 menerima cookie Supabase dari login. Logout memakai form aktual. Tidak menyalin token milik pengguna existing, tidak memalsukan JWT.
- CRUD action IDs diambil dari JavaScript deployment aktif. Hasil RSC action row `1` harus `ok:true`, bukan hanya HTTP 200.
- Upload mengikuti alur aktual, termasuk nonce/fileId/session URL dinamis. FileId hasil upload harus diterima PATCH sebelum sukses.
- GET transient 0/502/504 mendapat maksimal dua retry dengan backoff 2s, 4s + jitter dan `Retry-After`. POST/PATCH/PUT tidak diulang ketika hasil ambigu; cleanup menemukan orphan lewat prefix sesi + fingerprint target.
- HTTP 429/503 menghentikan seluruh tes pada kejadian pertama, lebih konservatif dari batas 3%.
- `/api/test/reset`, delete-all, dan reset tidak pernah dipanggil.
- HTTP-level workload tidak menjalankan rendering browser, asset lengkap setiap kunjungan, atau websocket Realtime. Hasil tidak mengukur biaya render/refresh otomatis pengguna browser.

## Threshold dan metrik

| Metrik | Aturan |
|---|---|
| `request_errors` | Target <1%; gagal ≥5%; abort >10% sesudah 10s |
| `app_latency` | p50/median, p95, p99; gagal p95 ≥5s |
| `overload` | Gagal >3%; wrapper request langsung abort pada 429/503 |
| `function_timeouts` | Marker `FUNCTION_INVOCATION_TIMEOUT`; gagal >10% |
| `client_timeouts` | Terpisah; timeout client 12s tidak membuktikan timeout function |
| `upload_success` | Semua tiga tahap selesai; threshold >99% |
| `http_reqs`, `target_requests` | Count dan RPS aktual; termasuk setup/discovery/retry |
| `vus`, `vus_max` | Gauge VU aktif dan alokasi; bukan jumlah pengguna yang berhasil login |
| `iteration_duration` | Durasi siklus termasuk think time/throttling |
| 3 request >10s berturut-turut | Abort global, streak dihitung per VU |

[Jenis threshold k6](https://grafana.com/docs/k6/latest/using-k6/thresholds/): `abortOnFail` dievaluasi periodik, bukan limiter atomik. Request budget skrip bersifat per-VU, menjamin batas jumlah konservatif tanpa modul global bersama. Setup terpisah punya budget 50. Final summary JSON disimpan di `test-results/loadtest/summary.json`; exit nonzero berarti gagal atau abort.

Function execution time dan DB query latency **belum terinstrumentasi**. `app_latency` adalah waktu HTTP end-to-end, bukan CPU/query time. Cocokkan rentang waktu dan header `X-Loadtest-Run` dengan Vercel Runtime Logs/Observability serta Supabase Query Performance/logs. Jangan menyimpulkan “DB cepat” dari latency halaman login.

## Cleanup dan pembuktian

1. Journal identitas direncanakan sebelum pembuatan akun. Jika timeout terjadi setelah commit, akun tetap dapat ditemukan.
2. Akun baru dinonaktifkan, lalu Admin API menghapusnya; profil cascade. Kecocokan email, marker run, dan waktu pembuatan wajib. Tidak ada wildcard delete akun lama.
3. Tunggu 65 detik untuk call Drive yang masih berjalan setelah client berhenti.
4. Hapus Drive file hanya jika prefix run, creation time, dan fingerprint target cocok. Ini mencakup file yang PUT-nya berhasil tetapi PATCH gagal.
5. Hapus row DB dengan **ID dalam manifest AND title dalam daftar ID**; hapus konflik sinkronisasi dengan ID yang sama. Tidak memakai RPC delete yang menomori ulang.
6. Tunggu mirror normal. Verifikasi DB, akun, profil, Drive, Sheet, dan baseline mirror kosong dari sesi ini. Gagal verifikasi = cleanup belum selesai; jangan klaim sukses.
7. Bandingkan seluruh field 127 record baseline sebelum/sesudah, termasuk version/timestamp, serta konten record lama di Sheets. Perubahan legitimate pengguna lain juga ditandai; skrip tidak memulihkan snapshot dan menimpa perubahan mereka.

Signup penuh 80 akun dan delete action tersedia hanya lewat `ISOLATED=1 REGISTRATION=1` saat seed, dengan tracker kosong, Supabase/Drive/Sheets terpisah, serta email sink/non-delivery Auth staging. Runner menolak flag isolated pada URL/project production yang dikenal. Jangan menonaktifkan konfirmasi email production untuk tes.

Alternatif Artillery/Locust tidak ditambahkan: satu implementasi k6 mempertahankan satu aturan ownership dan cleanup. Tambahkan alternatif hanya jika k6 tidak dapat dijalankan; jangan mengklaim coverage dari skrip placeholder.
