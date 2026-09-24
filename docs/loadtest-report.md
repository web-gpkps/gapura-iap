# Load test production — run `mufignw0cd19be` (2026-09-24)

Target `https://gapura-iap-tracker.vercel.app`, k6 via `npm run loadtest:run`, 200 akun seed (40 cabang × 5).
Stage: 0→10 (2m) → 50 (3m) → 200 (1m) → hold 200 (5m) → 20 (2m) → 0; total 20m25s termasuk graceful stop.

## Hasil

| Metrik | Nilai | Threshold | Status |
|---|---:|---|---|
| Request total / RPS rata-rata | 3.018 / 2,46 | cap 4 RPS | — |
| Latency p50 / p95 / p99 / max | 444 ms / 3,32 s / 4,05 s / 10,2 s | p95 < 5 s | lulus |
| Server wait (TTFB) p95 | 3,30 s | — | — |
| Error aplikasi (`request_errors`) | 1,03% (31) | < 5%, abort > 10% | lulus, target 1% sedikit terlewati |
| HTTP 429/503 | 0 | ≤ 3% | lulus |
| `FUNCTION_INVOCATION_TIMEOUT` | 0 | ≤ 10% | lulus |
| Client timeout 12 s | 1 | — | — |
| Upload 3 tahap sukses | 336/337 (99,7%) | > 99% | lulus |
| Aksi CRUD (create+update) | 261 | — | — |
| VU puncak | 200 | — | — |
| Durasi siklus login→logout median / p95 | 248 s / 559 s | target 120–160 s | lebih lama: think time + antrean cap 4 RPS |

Sampel live pukul 12:44 UTC: 44 sesi login, 228 record test, 13 record ter-update, 37 evidence; 127 record lama tidak berubah.

## Cleanup (terverifikasi 13:03 UTC)

Akun, profil, record tracker, konflik sinkronisasi, file Drive, baris Sheet, dan baseline mirror: semua 0 sisa. 127 record lama di DB dan Sheet identik dengan baseline. Cek independen SQL: `iap_tracker` 127 baris, `no` 1–127 kontinu.

## Tidak diuji

- Registrasi production: email konfirmasi aktif, `example.com` bukan inbox.
- Delete via aplikasi: `iap_mutate` menomori ulang record lain; cleanup memakai delete ID langsung.
- Waktu eksekusi function dan latency query DB: tidak diinstrumentasi; cocokkan jendela 12:34–13:03 UTC di Vercel Observability dan Supabase Query Performance.
- Render browser/Realtime; ini load test level HTTP.
