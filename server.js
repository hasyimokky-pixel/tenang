/**
 * Tenang — server kecil tanpa dependency (Node 18+)
 *
 * Tugas:
 *  1. Menyajikan file PWA dari /public
 *  2. GET /api/quote  -> "realtime": pakai AI kalau API key tersedia,
 *                        kalau tidak -> pilih acak dari kurasi lokal.
 *
 * Jalankan:  node server.js          (default port 3000)
 * Opsional   OPENAI_API_KEY=sk-...  node server.js
 *            GEMINI_API_KEY=...     node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const push = require('./push');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(PUBLIC_DIR, 'data', 'quotes.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

/* ========================= notifikasi pagi (web push) ========================= */

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SUBS_FILE = path.join(DATA_DIR, 'push-subs.json');
const MAX_SUBS = Number(process.env.MAX_PUSH_SUBS || 5000);

function loadSubs() {
  try {
    return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSubs(subs) {
  fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true });
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

function upsertSub(subscription, { time, tzOffset, mood, lastMood }) {
  const subs = loadSubs();
  const cleanTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(time)) ? time : '06:30';
  const tz = Number.isFinite(Number(tzOffset)) ? Math.max(-840, Math.min(840, Number(tzOffset))) : 0;
  const idx = subs.findIndex((s) => s.endpoint === subscription.endpoint);
  const entry = {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    time: cleanTime,
    tzOffset: tz,
    mood: mood || 'auto',
    lastMood: lastMood || null,
    lastSent: idx >= 0 ? subs[idx].lastSent : null,
    recent: idx >= 0 ? subs[idx].recent || [] : [],
    createdAt: idx >= 0 ? subs[idx].createdAt : new Date().toISOString()
  };
  if (idx >= 0) subs[idx] = entry;
  else if (subs.length < MAX_SUBS) subs.push(entry);
  else return { ok: false, error: 'batas pelanggan tercapai' };
  saveSubs(subs);
  return { ok: true, total: subs.length };
}

function removeSub(endpoint) {
  const subs = loadSubs().filter((s) => s.endpoint !== endpoint);
  saveSubs(subs);
  return subs.length;
}

function quoteForPush(sub) {
  let pool = dataset.quotes.filter((q) => q.mood[0] === sub.mood);
  if (!pool.length) {
    const fallbackMood = sub.lastMood || 'syukur';
    pool = dataset.quotes.filter((q) => q.mood[0] === fallbackMood);
  }
  if (!pool.length) pool = dataset.quotes;
  const fresh = pool.filter((q) => !(sub.recent || []).includes(q.id));
  const list = fresh.length ? fresh : pool;
  return list[Math.floor(Math.random() * list.length)];
}

function morningPayload(sub) {
  const q = quoteForPush(sub);
  const text = q.text.length > 165 ? q.text.slice(0, 162).trimEnd() + '…' : q.text;
  const mood = q.mood[0];
  return {
    quoteId: q.id,
    mood,
    payload: {
      title: 'Tenang · pagi ini',
      body: `"${text}" — ${q.tokoh}`,
      mood,
      url: `/?mood=${mood}`
    }
  };
}

async function sendMorning(sub, label = 'pagi') {
  const { payload, quoteId, mood } = morningPayload(sub);
  const result = await push.sendPush(
    { endpoint: sub.endpoint, keys: sub.keys },
    payload,
    { ttl: 21600, urgency: 'normal', topic: 'tenang-pagi-' + label }
  );
  return { ...result, quoteId, mood };
}

// jam lokal pelanggan berdasarkan offset (menit) dari getTimezoneOffset()
function localClock(tzOffset) {
  const local = new Date(Date.now() - Number(tzOffset || 0) * 60000);
  return {
    hm: `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`,
    date: local.toISOString().slice(0, 10),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes()
  };
}

// toleransi susulan: kalau server sempat mati/lambat, notifikasi tetap dikirim
const CATCHUP_MINUTES = Number(process.env.PUSH_CATCHUP_MIN || 20);

function isDue(sub, clock) {
  const [h, m] = String(sub.time || '06:30').split(':').map(Number);
  const target = h * 60 + m;
  const diff = clock.minutes - target; // menit sejak waktu kirim
  return diff >= 0 && diff <= CATCHUP_MINUTES;
}

let ticking = false;
async function tickMorning() {
  if (ticking) return;
  ticking = true;
  try {
    const subs = loadSubs();
    if (!subs.length) return;
    let changed = false;
    const dead = [];

    for (const sub of subs) {
      const clock = localClock(sub.tzOffset);
      if (sub.lastSent === clock.date || !isDue(sub, clock)) continue;

      const res = await sendMorning(sub);
      if (res.gone) {
        dead.push(sub.endpoint);
        continue;
      }
      if (res.ok) {
        sub.lastSent = clock.date;
        sub.recent = [(res.quoteId || ''), ...(sub.recent || [])].slice(0, 12);
        changed = true;
        console.log(`[tenang] notifikasi pagi terkirim (${sub.time} lokal) -> ${res.quoteId}`);
      } else {
        console.warn('[tenang] gagal kirim push:', res.error);
      }
    }

    if (dead.length) {
      saveSubs(subs.filter((s) => !dead.includes(s.endpoint)));
      console.log(`[tenang] ${dead.length} langganan kedaluwarsa dihapus`);
      changed = false;
    } else if (changed) {
      saveSubs(subs);
    }
  } catch (err) {
    console.warn('[tenang] tick gagal:', err.message);
  } finally {
    ticking = false;
  }
}

setInterval(tickMorning, 30000);

function readJson(req, limit = 32768) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/* ------------------------------ konfigurasi AI ------------------------------ */

function aiConfig() {
  if (process.env.OPENAI_API_KEY) {
    return {
      kind: 'openai',
      key: process.env.OPENAI_API_KEY,
      base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      kind: 'gemini',
      key: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash'
    };
  }
  return null;
}

function moodLabel(id) {
  const m = dataset.moods.find((x) => x.id === id);
  return m ? m.label : 'perasaan yang tidak spesifik';
}

function buildPrompt({ mood, story, excludeTexts }) {
  const contoh = dataset.quotes
    .filter((q) => q.mood.includes(mood))
    .slice(0, 4)
    .map((q) => `- "${q.text}" (${q.tokoh}, ${q.sumber})`)
    .join('\n');

  return [
    'Kamu adalah penulis konten islami yang lembut, hangat, dan tidak menghakimi.',
    `Pengguna sedang merasa sedih dengan tema: ${moodLabel(mood)}.`,
    story ? `Cerita/keluhan pengguna: "${story}"` : '',
    '',
    'Tulis SATU kutipan penenang dalam bahasa Indonesia (maksimal 45 kata) yang:',
    '1. Menggunakan sudut pandang islami yang menenangkan, bukan ceramah atau vonis dosa.',
    '2. Dinisbatkan pada tokoh islam ternama yang nyata (mis. Ibnu Qayyim al-Jauziyyah, Imam Al-Ghazali,',
    '   Ali bin Abi Thalib, Umar bin Khattab, Imam Asy-Syafi\'i, Ibnu Atha\'illah, Al-Hasan al-Bashri,',
    '   Rabi\'ah al-Adawiyah, Jalaluddin Rumi, Buya Hamka), atau pada hadis/Al-Qur\'an bila kamu yakin.',
    '3. Sertakan nama kitab/sumber bila kamu yakin; kalau ragu, tulis sumber yang jujur seperti',
    '   "nasihat salaf" atau "hikmah". JANGAN mengarang nomor hadis atau nomor ayat.',
    '4. Tidak mengulang kutipan berikut:',
    excludeTexts.length ? excludeTexts.map((t) => `   ~ ${t}`).join('\n') : '   (tidak ada)',
    '',
    contoh ? `Contoh gaya kutipan yang sudah ada di aplikasi:\n${contoh}` : '',
    '',
    'Balas HANYA JSON valid tanpa penjelasan, format:',
    '{"text":"...","tokoh":"...","sumber":"...","status":"nukilan|parafrase|dinisbatkan"}'
  ]
    .filter(Boolean)
    .join('\n');
}

async function callOpenAI(cfg, prompt) {
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.key}`
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.9,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

async function callGemini(cfg, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.95, responseMimeType: 'application/json' }
    }),
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function extractJson(raw) {
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ------------------------------- pilih kurasi ------------------------------- */

const history = new Map(); // mood -> id terakhir yang dikirim per "sesi" sederhana

function pickCurated(mood, exclude) {
  let pool = dataset.quotes.filter((q) => q.mood[0] === mood);
  if (!pool.length) pool = dataset.quotes.filter((q) => q.mood.includes(mood));
  if (!pool.length) pool = dataset.quotes;
  const fresh = pool.filter((q) => !exclude.includes(q.id));
  const list = fresh.length ? fresh : pool;
  return list[Math.floor(Math.random() * list.length)];
}

/* --------------------------------- helpers --------------------------------- */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fallback SPA
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return send(res, 404, { error: 'not found' });
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(html);
        });
      }
      return send(res, 404, { error: 'not found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const cache =
      ext === '.html' || filePath.endsWith('sw.js') || filePath.endsWith('quotes.json')
        ? 'no-cache'
        : 'public, max-age=604800';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache
    });
    res.end(data);
  });
}

/* ---------------------------------- routes --------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    const cfg = aiConfig();
    return send(res, 200, {
      ok: true,
      mode: cfg ? 'ai' : 'kurasi',
      provider: cfg ? cfg.kind : 'local-dataset',
      model: cfg ? cfg.model : null,
      push: { enabled: true, subscribers: loadSubs().length }
    });
  }

  if (url.pathname === '/api/quote' && req.method === 'GET') {
    const mood = url.searchParams.get('mood') || 'sedih';
    const story = (url.searchParams.get('q') || '').slice(0, 400);
    const excludeIds = (url.searchParams.get('exclude') || '').split(',').filter(Boolean);
    const excludeTexts = (url.searchParams.get('excludeTexts') || '').split('||').filter(Boolean).slice(0, 6);
    const wantLive = url.searchParams.get('live') !== '0';
    const cfg = aiConfig();

    if (cfg && wantLive) {
      try {
        const prompt = buildPrompt({ mood, story, excludeTexts });
        const raw = cfg.kind === 'gemini' ? await callGemini(cfg, prompt) : await callOpenAI(cfg, prompt);
        const data = extractJson(raw);
        if (data && data.text && data.text.length > 20) {
          return send(res, 200, {
            source: 'ai',
            model: cfg.model,
            quote: {
              id: `ai-${Date.now()}`,
              mood: [mood],
              text: String(data.text).trim().slice(0, 400),
              tokoh: String(data.tokoh || 'Nasihat ulama').trim().slice(0, 90),
              sumber: String(data.sumber || 'hikmah').trim().slice(0, 90),
              status: ['nukilan', 'parafrase', 'dinisbatkan'].includes(data.status) ? data.status : 'dinisbatkan'
            }
          });
        }
        console.warn('[tenang] respons AI tidak valid, memakai kurasi.');
      } catch (err) {
        console.warn('[tenang] AI gagal:', err.message, '-> memakai kurasi.');
      }
    }

    const q = pickCurated(mood, excludeIds);
    return send(res, 200, { source: 'kurasi', model: null, quote: q });
  }

  /* --------------------------- notifikasi pagi --------------------------- */

  if (url.pathname === '/api/push/key') {
    const vapid = push.loadVapid();
    return send(res, 200, { enabled: true, publicKey: vapid.publicKey, subscribers: loadSubs().length });
  }

  if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || !body.subscription || !body.subscription.endpoint || !body.subscription.keys) {
      return send(res, 400, { error: 'subscription tidak valid' });
    }
    const r = upsertSub(body.subscription, body);
    if (!r.ok) return send(res, 429, r);
    console.log(`[tenang] langganan pengingat ${body.time || '06:30'} (${body.mood || 'auto'}) — total ${r.total}`);
    return send(res, 200, { ok: true, time: body.time || '06:30', total: r.total });
  }

  if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || !body.endpoint) return send(res, 400, { error: 'endpoint wajib' });
    const total = removeSub(body.endpoint);
    return send(res, 200, { ok: true, total });
  }

  if (url.pathname === '/api/push/test' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || !body.endpoint) return send(res, 400, { error: 'endpoint wajib' });
    const sub = loadSubs().find((s) => s.endpoint === body.endpoint);
    if (!sub) return send(res, 404, { error: 'langganan tidak ditemukan' });
    const r = await sendMorning(sub, 'uji');
    if (r.gone) {
      removeSub(sub.endpoint);
      return send(res, 410, { error: 'langganan kedaluwarsa, aktifkan ulang' });
    }
    return send(res, r.ok ? 200 : 502, { ok: r.ok, error: r.error, quoteId: r.quoteId });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'method not allowed' });
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  const cfg = aiConfig();
  console.log(`Tenang berjalan di http://${HOST}:${PORT}`);
  console.log(
    cfg
      ? `Mode quote: AI realtime (${cfg.kind} / ${cfg.model})`
      : 'Mode quote: kurasi lokal (set OPENAI_API_KEY atau GEMINI_API_KEY untuk mode AI realtime)'
  );
  const subs = loadSubs().length;
  console.log(
    `Pengingat pagi: aktif via web push — VAPID ${
      push.loadVapid().publicKey.slice(0, 12)
    }…, ${subs} pelanggan, cek tiap 30 detik (butuh HTTPS di produksi)`
  );
});
