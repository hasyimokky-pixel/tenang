/**
 * push.js — Web Push (RFC 8291 payload encryption + RFC 8292 VAPID)
 * Tanpa dependency, hanya node:crypto.
 *
 * Dipakai server.js untuk mengirim notifikasi quote pagi.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const DEFAULT_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:tenang@localhost';

/* ------------------------------- base64url ------------------------------- */
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (str) => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* ---------------------------------- VAPID -------------------------------- */
let vapidCache = null;

function loadVapid() {
  if (vapidCache) return vapidCache;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(VAPID_FILE)) {
    vapidCache = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    if (!vapidCache.subject) vapidCache.subject = DEFAULT_SUBJECT;
    return vapidCache;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });

  vapidCache = {
    // publicKey = uncompressed EC point 0x04 || X || Y (65 byte), base64url
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)])),
    privateJwk: priv,
    subject: DEFAULT_SUBJECT,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidCache, null, 2));
  return vapidCache;
}

function vapidHeader(endpoint) {
  const vapid = loadVapid();
  const audience = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 jam (RFC 8292 maks 24 jam)
    sub: vapid.subject
  }));
  const signingInput = `${header}.${claims}`;
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363' // raw r||s, bukan DER — wajib untuk JWT ES256
  });
  const jwt = `${signingInput}.${b64u(signature)}`;
  return `vapid t=${jwt}, k=${vapid.publicKey}`;
}

/* -------------------------------- HKDF -------- ------------------------- */
function hkdfExtract(salt, ikm) {
  return crypto.createHmac('sha256', salt && salt.length ? salt : Buffer.alloc(32)).update(ikm).digest();
}

function hkdfExpand(prk, info, length) {
  const chunks = [];
  let prev = Buffer.alloc(0);
  let counter = 1;
  let total = 0;
  while (total < length) {
    prev = crypto.createHmac('sha256', prk)
      .update(Buffer.concat([prev, info, Buffer.from([counter])]))
      .digest();
    chunks.push(prev);
    total += prev.length;
    counter += 1;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

/* --------------------- enkripsi payload (aes128gcm) ---------------------- */
/**
 * @param {Buffer} plaintext isi notifikasi (JSON string)
 * @param {string} p256dh    subscription key p256dh (base64url, 65 byte)
 * @param {string} auth      subscription key auth (base64url, 16 byte)
 * @returns {{body: Buffer, salt: Buffer, serverPublic: Buffer}}
 */
function encryptPayload(plaintext, p256dh, auth) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65) throw new Error('p256dh tidak valid (harus 65 byte)');
  if (authSecret.length !== 16) throw new Error('auth secret tidak valid (harus 16 byte)');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65 byte uncompressed
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const salt = crypto.randomBytes(16);

  // RFC 8291 §3.4
  const ikm = hkdfExpand(
    hkdfExtract(authSecret, sharedSecret),
    Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]),
    32
  );
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);

  // header record: salt(16) | rs(4) | idlen(1) | keyid(65)
  const header = Buffer.alloc(16 + 4 + 1 + 65);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(65, 20);
  asPublic.copy(header, 21);

  // delimiter 0x02 = akhir record (padding delimiter), wajib di aes128gcm
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag()
  ]);

  return { body: Buffer.concat([header, ciphertext]), salt, serverPublic: asPublic };
}

/* ------------------------------ kirim push ------------------------------- */
/**
 * @returns {Promise<{ok:boolean, status:number, gone:boolean, error?:string}>}
 */
async function sendPush(subscription, payload, { ttl = 43200, urgency = 'normal', topic = 'tenang-pagi' } = {}) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return { ok: false, status: 0, gone: false, error: 'subscription tidak lengkap' };
  }

  const body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), keys.p256dh, keys.auth);
  const headers = {
    Authorization: vapidHeader(endpoint),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency
  };
  if (topic) headers.Topic = topic;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: body.body,
      signal: AbortSignal.timeout(15000)
    });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
    return {
      ok: res.ok,
      status: res.status,
      gone: res.status === 404 || res.status === 410,
      error: res.ok ? undefined : `${res.status} ${text}`
    };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: err.message };
  }
}

module.exports = { loadVapid, encryptPayload, sendPush, b64u, unb64u };
