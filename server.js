// Tiny leaderboard server for Flappy Bird with anti-cheat.
// Usage: npm install && npm start  -> http://localhost:3000

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'scores.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const MAX_NAME = 16;
const MAX_ENTRIES = 100;
const MAX_SCORE = 500;
const MS_PER_SCORE = 800;        // generous grace below pipe rate (~1.58s)
const MS_OVERHEAD = 0;           // no fixed overhead — page-load buffer covers it
const NO_TOKEN_MAX = 15;         // small scores skip the token check entirely
const MS_SESSION_TTL = 60 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;            // generous; per IP per min

// Names that have been caught cheating. They will be silently rejected and
// any historical entries scrubbed at startup.
const BANNED_NAMES = new Set([
  'yamayhamayha',
]);

app.set('trust proxy', true);
app.use(express.json({ limit: '4kb' }));
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function loadScores() {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const raw = fs.readFileSync(DB_FILE, 'utf8') || '[]';
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveScores(list) {
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function dedupeByName(list) {
  const best = new Map();
  for (const e of list) {
    const key = (e.name || '').trim().toLowerCase();
    if (!key) continue;
    const prev = best.get(key);
    if (!prev || e.score > prev.score) best.set(key, e);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

function sanitizeSkin(s) {
  if (!s || typeof s !== 'object') return null;
  const color = (typeof s.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.color))
    ? s.color : '#f7d51d';
  const style = typeof s.style === 'string' ? s.style.slice(0, 20) : 'Classic';
  const hat = typeof s.hat === 'string' ? s.hat.slice(0, 20) : 'None';
  return { color, style, hat };
}

// Per-IP rate limiter
const rate = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (rate.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rate.set(ip, arr);
  return arr.length > RATE_MAX;
}

// Server-issued session tokens. Client requests one (typically once per page
// load) and reuses it for as many games as they play within the TTL. The
// server measures real elapsed time from token creation — clients can't fake it.
const sessions = new Map(); // token -> { createdAt, ip, uses }

function gcSessions() {
  const now = Date.now();
  for (const [t, s] of sessions) {
    if (now - s.createdAt > MS_SESSION_TTL) sessions.delete(t);
  }
}

// Startup cleanup: remove any cheat entries (score-100 spam, banned names).
(function startupCleanup() {
  const list = loadScores();
  const cleaned = list.filter(e => {
    if (e.score === 100 && (!e.duration || e.duration === 0)) return false;
    if (BANNED_NAMES.has((e.name || '').toLowerCase())) return false;
    return true;
  });
  if (cleaned.length !== list.length) {
    saveScores(cleaned);
    console.log(`Startup cleanup: removed ${list.length - cleaned.length} cheat entries`);
  }
})();

app.get('/api/scores', (req, res) => {
  const list = dedupeByName(loadScores()).slice(0, 20);
  res.json(list);
});

// Quick debug: total stored entries + DB file path. Useful for verifying
// that the Railway volume is mounted correctly.
app.get('/api/health', (req, res) => {
  const list = loadScores();
  res.json({
    ok: true,
    total: list.length,
    unique: dedupeByName(list).length,
    dbFile: DB_FILE,
    persistent: DB_FILE !== path.join(__dirname, 'scores.json'),
  });
});

// Issue a fresh play-session token. Required before submitting a score.
app.post('/api/session', (req, res) => {
  const ip = (req.ip || 'unknown').toString();
  if (rateLimited(ip)) return res.status(429).json({ error: 'too many requests' });
  gcSessions();
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, { createdAt: Date.now(), ip, uses: 0 });
  res.json({ token });
});

app.post('/api/scores', (req, res) => {
  const ip = (req.ip || 'unknown').toString();
  if (rateLimited(ip)) return res.status(429).json({ error: 'too many requests' });

  let { name, score, skin, token } = req.body || {};
  if (typeof name !== 'string' || typeof score !== 'number') {
    return res.status(400).json({ error: 'invalid payload' });
  }
  name = name.trim().slice(0, MAX_NAME) || 'Anon';
  score = Math.floor(score);

  if (BANNED_NAMES.has(name.toLowerCase())) {
    return res.status(403).json({ error: 'name banned' });
  }
  if (score < 0 || score > MAX_SCORE) {
    return res.status(400).json({ error: 'score out of range' });
  }

  // Server-side timing check via session token.
  if (score > NO_TOKEN_MAX) {
    if (typeof token !== 'string' || !sessions.has(token)) {
      return res.status(400).json({ error: 'invalid or missing session' });
    }
    const sess = sessions.get(token);
    if (sess.ip !== ip) return res.status(403).json({ error: 'session ip mismatch' });
    const realDuration = Date.now() - sess.createdAt;
    const minMs = MS_OVERHEAD + score * MS_PER_SCORE;
    if (realDuration < minMs) {
      return res.status(400).json({
        error: 'too fast',
        needMs: minMs,
        gotMs: realDuration,
      });
    }
    if (realDuration > MS_SESSION_TTL) {
      sessions.delete(token);
      return res.status(400).json({ error: 'session expired' });
    }
    sess.uses++;
    // Hard cap so a single token can't be abused indefinitely.
    if (sess.uses > 200) {
      sessions.delete(token);
      return res.status(400).json({ error: 'session exhausted' });
    }
  }

  const sk = sanitizeSkin(skin);
  const all = loadScores();
  all.push({ name, score, skin: sk, at: Date.now() });
  const deduped = dedupeByName(all);
  saveScores(deduped.slice(0, MAX_ENTRIES));

  res.json({ ok: true, top: deduped.slice(0, 20) });
});

// Admin: delete by name. Set ADMIN_TOKEN env var on Railway.
// Example: DELETE /api/scores/alice?token=YOUR_TOKEN
app.delete('/api/scores/:name', (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const target = (req.params.name || '').toLowerCase();
  const list = loadScores();
  const cleaned = list.filter(e => (e.name || '').toLowerCase() !== target);
  saveScores(cleaned);
  res.json({ ok: true, removed: list.length - cleaned.length });
});

app.listen(PORT, () => {
  console.log(`Flappy leaderboard running on :${PORT}`);
});
