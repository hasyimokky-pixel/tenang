# Tenang — PWA quote islami penenang hati

Ruang kecil untuk hati yang sedang berat. Pilih perasaanmu (rezeki, cinta, kesepian, dll),
lalu muncul satu kalimat dari tokoh islam ternama yang menenangkan.

Dua mode quote:

| Mode | Kapan aktif | Kebutuhan |
|---|---|---|
| **Kurasi lokal** (default) | selalu | tidak ada. **540 quote** sudah tertanam, jalan **offline** |
| **AI realtime** (hybrid) | kalau server punya API key | `OPENAI_API_KEY` atau `GEMINI_API_KEY` |

Tanpa API key aplikasi tetap jalan penuh — tombol *Cari lebih dalam* otomatis memilih dari kurasi.

---

> **Mau langsung online?** Baca **[DEPLOY.md](DEPLOY.md)** — panduan deploy khusus pemula
> (rekomendasi: Render gratis, ±15 menit tanpa terminal).

## 1. Jalankan

Butuh Node 18+ (tanpa `npm install`, tanpa dependency).

```bash
cd tenang
node server.js                 # http://localhost:3000
PORT=8080 node server.js       # ganti port
```

Buka `http://localhost:3000` di browser. Di HP, buka lewat IP komputer (`http://192.168.x.x:3000`)
lalu pilih **Tambahkan ke layar utama** supaya jadi aplikasi PWA.

## 2. Aktifkan mode AI realtime (opsional)

```bash
# OpenAI
OPENAI_API_KEY=sk-xxxx node server.js

# model / base URL lain (OpenRouter, Groq, LM Studio, dsb — apa pun yang OpenAI-compatible)
OPENAI_API_KEY=sk-xxxx \
OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
OPENAI_MODEL=meta-llama/llama-3.3-70b-instruct \
node server.js

# Google Gemini
GEMINI_API_KEY=xxxx node server.js
GEMINI_MODEL=gemini-2.0-flash
```

Setelah itu badge di kanan atas berubah jadi **“AI realtime · <model>”**, dan tiap kali kamu
menekan *Cari lebih dalam* (atau bercerita di kolom cerita), server menulis quote baru
khusus untukmu lewat prompt di `server.js` (`buildPrompt`).

Kalau API gagal/timeout, server otomatis falls back ke kurasi — aplikasi tidak pernah “kosong”.

## 3. Notifikasi pagi (web push)

Fitur ini mengirim **satu quote setiap pagi** ke HP pengguna, walaupun aplikasi sedang tertutup.
Implementasinya memakai Web Push asli (RFC 8030/8291/8292) yang ditulis dari nol dengan
`node:crypto` — **tanpa library**, di `push.js`.

### Cara mengaktifkan (dari sisi pengguna)
Beranda → kartu **Pengingat pagi** → nyalakan sakelar → izinkan notifikasi → atur jam & tema.
Ada tombol *Kirim notifikasi uji sekarang* untuk memastikan semuanya jalan.

### Cara kerja
```
browser                        server (server.js)              push service
  |  subscribe(pushManager) ->         |                             |
  |  POST /api/push/subscribe          |  simpan endpoint + jam + tz  |
  |                                    |                             |
  |                                    |  tiap 30 dtk: cek jam lokal  |
  |                                    |  tiap pelanggan (tz offset)  |
  |                                    |  pilih quote -> enkripsi     |
  |                                    |  aes128gcm + VAPID JWT ------>| --> HP
  |<------------- notifikasi quote pagi (sw.js: event 'push') --------|
```

- Kunci VAPID dibuat otomatis saat server pertama kali jalan dan disimpan di `data/vapid.json`
  (jangan di-commit; `data/` sudah masuk `.gitignore`). Bisa diatur `VAPID_SUBJECT=mailto:kamu@domain`.
- Langganan pengguna disimpan di `data/push-subs.json` (endpoint + jam + zona waktu).
- Quote dipilih dari kategori sesuai pengaturan, dan 12 quote terakhir tidak diulang.
- Langganan kedaluwarsa (HTTP 404/410) otomatis dihapus.

### Syarat & batasan
- **HTTPS wajib** di produksi (localhost boleh HTTP). Web Push tidak jalan di HTTP biasa.
- Chrome/Edge/Firefox/Android: penuh. **iOS Safari 16.4+**: hanya jika PWA sudah *dipasang* ke layar utama.
- Kalau push tidak tersedia (mis. mode incognito), aplikasi otomatis jatuh ke **mode lokal**:
  notifikasi muncul saat aplikasi terbuka — tidak error, hanya statusnya berubah.
- Di Chrome terpasang, ada cadangan `periodicsync` (service worker) untuk menampilkan quote harian
  bila server push tidak aktif.
- Endpoint:

  | Endpoint | Fungsi |
  |---|---|
  | `GET /api/push/key` | VAPID public key untuk `PushManager.subscribe` |
  | `POST /api/push/subscribe` | daftar/ubah jadwal (`subscription`, `time`, `tzOffset`, `mood`) |
  | `POST /api/push/unsubscribe` | hapus langganan |
  | `POST /api/push/test` | kirim satu notifikasi uji sekarang |

## 4. Struktur file

```
tenang/
├─ server.js                   # server statis + /api/quote + /api/push/* + penjadwal pagi
├─ push.js                     # web push dari nol: enkripsi aes128gcm + VAPID JWT
├─ data/                       # dibuat otomatis (vapid.json, push-subs.json) — jangan di-commit
└─ public/
   ├─ index.html               # 3 layar: beranda, quote, favorit, tentang
   ├─ styles.css               # tema gelap/terang, kartu quote, animasi napas
   ├─ app.js                   # seluruh logika (tanpa framework)
   ├─ sw.js                    # service worker: offline-first
   ├─ manifest.webmanifest     # metadata PWA + shortcut
   ├─ icons/                   # ikon 192/512/maskable/apple-touch
   └─ data/quotes.json         # ← semua quote & kategori ada di sini
```

### Menambah / mengubah quote

Edit `public/data/quotes.json`:

```json
{
  "id": "rz99",
  "mood": ["rezeki", "cemas"],          // mood pertama = kategori utama
  "text": "Kalimat penenangnya…",
  "tokoh": "Ibnu Qayyim al-Jauziyyah",
  "sumber": "Zaadul Ma'ad",
  "status": "parafrase"                 // "nukilan" | "parafrase" | "dinisbatkan"
}
```

Script bantu di `tools/` (`add_quotes_batch*.py`) adalah contoh cara menambah banyak quote
sekaligus: script itu mengecek duplikat teks, memberi id otomatis, dan menulis ulang JSON dengan rapi.

Menambah kategori baru: tambahkan objek di array `moods` (`id`, `label`, `sub`, `keywords`).
`keywords` dipakai untuk mencocokkan cerita bebas pengguna dengan kategori.

> Naikkan `VERSION` di `sw.js` setiap kali mengubah file statis, supaya cache pengguna
> yang sudah memasang PWA ikut ter-update.

## 5. Fitur

- **540 quote** dalam **14 kategori** perasaan, 23–47 quote per kategori:

  | Kategori | Quote | Kategori | Quote |
  |---|---|---|---|
  | Rezeki | 47 | Kesepian | 39 |
  | Cinta & jodoh | 47 | Lelah & ingin menyerah | 37 |
  | Sedih tanpa sebab | 42 | Cobaan & sakit | 42 |
  | Cemas & overthinking | 42 | Kehilangan orang tersayang | 40 |
  | Gagal & merasa kurang | 42 | Merasa berdosa | 40 |
  | Keluarga & orang tua | 38 | Ingin tenang & bersyukur | 38 |
  | Direndahkan & dibully (baru) | 23 | Rindu & jauh dari rumah (baru) | 23 |

- 54 tokoh/sumber berbeda: Ibnu Qayyim (38), Ali bin Abi Thalib (36), Imam Al-Ghazali (29),
  Buya Hamka (25), Umar bin Khattab (20), Al-Qur'an (20), Ibnu Atha'illah (18), Ibnul Jauzi,
  Imam Asy-Syafi'i, Al-Hasan al-Bashri, Imam Ahmad, Imam Malik, Imam An-Nawawi, Imam Abu Hanifah,
  Ibnu Taimiyah, Ibnu Hajar, Imam Al-Qurthubi, Abdul Qadir al-Jailani, Ibrahim bin Adham,
  Sufyan ats-Tsauri, Ibnu Hazm, Ibnu Mas'ud, Ibnu Abbas, Salman al-Farisi, Abu Dzar, Bilal,
  Sumayyah, Khadijah, Aisyah, Ummu Salamah, Fatimah, Abdurrahman bin Auf, Rabi'ah al-Adawiyah,
  Rumi, Sa'di asy-Syirazi, Al-Mutanabbi, 'Aidh al-Qarni (La Tahzan), K.H. Hasyim Asy'ari, dll.
- Filter **“Hanya quote dari tokoh bernama”** (di halaman Tentang): 392 dari 540 quote punya
  tokoh bernama, sisanya hikmah salaf tanpa nama
- Kolom “ceritakan perasaanmu” → deteksi kata kunci → kategori yang cocok
- Quote baru sekali ketuk, **AI realtime** untuk kalimat yang ditulis khusus
- Simpan favorit (localStorage), bagikan (Web Share / clipboard), unduh kartu quote PNG 4:5
- Bacakan quote (Web Speech API, suara Indonesia bila tersedia)
- **Notifikasi pagi (web push)** — jam & tema quote bisa diatur, ada tombol uji kirim
- Panduan napas 4-4-6-2 dengan animasi lingkaran
- Tema gelap/terang, animasi halus, haptic-free & ringan (< 40 KB kode, tanpa library)
- PWA installable, **offline penuh** untuk mode kurasi

## 6. Deploy

Panduan langkah demi langkah (termasuk Render, Railway, VPS, dan versi statis) ada di
**[DEPLOY.md](DEPLOY.md)**. Ringkasnya:

- **Render (free)** — paling simpel untuk pemula; auto-detect Node, HTTPS otomatis.
  Catatan: instance gratis tidur setelah ~15 menit (pakai cron-job.org tiap 10 menit) dan
  folder `data/` hilang saat redeploy (langganan push didaftarkan ulang otomatis oleh klien).
- **Railway** — tanpa tidur, ~$5/bulan setelah kredit percobaan.
- **VPS + pm2 + certbot** — paling murah jangka panjang, butuh SSH.
- **Statis (Netlify/Cloudflare Pages)** — 3 menit dengan drag & drop `public/`,
  tapi tombol AI realtime & notifikasi pagi tidak aktif.

File bantu: `render.yaml` (blueprint), `Dockerfile` (Railway/Fly/VPS), `package.json` (`npm start`).
Kalau butuh penyimpanan permanen untuk kunci VAPID & langganan, mount volume dan set `DATA_DIR`.

## 7. Catatan kejujuran sumber

Beberapa kalimat adalah **parafrase** (pengambilan makna) dari kitab aslinya, bukan terjemahan
kata per kata; sebagian lain populer dinisbatkan kepada tokohnya tanpa sanad yang pasti.
Label di tiap kartu (`nukilan` / `parafrase` / `dinisbatkan`) menunjukkan hal ini, dan penomoran
ayat/hadis dibuat konservatif — tidak ada nomor yang dikarang. Untuk kebutuhan kajian serius,
selalu rujuk kitab aslinya.

Aplikasi ini menemani, bukan mengobati. Jika kesedihan menetap atau muncul pikiran menyakiti diri,
tolong hubungi orang yang kamu percaya atau layanan kesehatan jiwa terdekat.
