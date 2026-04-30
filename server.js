// Tiny leaderboard server for Flappy Bird.
// Usage: npm install && npm start  -> http://localhost:3000

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'scores.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_NAME = 16;
const MAX_ENTRIES = 100;
const MAX_SCORE = 500;            // sane upper bound for a flappy bird run
const MS_PER_SCORE = 1300;        // a pipe takes ~1.5s; allow a little grace
const MS_OVERHEAD = 1500;         // initial pre-first-pipe time
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 15;              // submissions per window per IP

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

// In-memory rate limiter
const submissions = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (submissions.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  submissions.set(ip, arr);
  return arr.length > RATE_MAX;
}

// One-time startup cleanup: remove the score-100 cheat entry.
(function startupCleanup() {
  const list = loadScores();
  const cleaned = list.filter(e => e.score !== 100);
  if (cleaned.length !== list.length) {
    saveScores(cleaned);
    console.log(`Startup cleanup: removed ${list.length - cleaned.length} score-100 entries`);
  }
})();

app.get('/api/scores', (req, res) => {
  const list = dedupeByName(loadScores()).slice(0, 20);
  res.json(list);
});

app.post('/api/scores', (req, res) => {
  const ip = (req.ip || 'unknown').toString();
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'too many requests' });
  }

  let { name, score, skin, duration } = req.body || {};
  if (typeof name !== 'string' || typeof score !== 'number') {
    return res.status(400).json({ error: 'invalid payload' });
  }
  name = name.trim().slice(0, MAX_NAME) || 'Anon';
  score = Math.floor(score);

  // Sanity: score must be in plausible range.
  if (score < 0 || score > MAX_SCORE) {
    return res.status(400).json({ error: 'score out of range' });
  }

  // Time-of-play check: anything meaningful must come with a play
  // duration that is physically achievable given the pipe spawn rate.
  if (score > 3) {
    if (typeof duration !== 'number' || !isFinite(duration)) {
      return res.status(400).json({ error: 'missing duration' });
    }
    const minMs = MS_OVERHEAD + score * MS_PER_SCORE;
    if (duration < minMs) {
      return res.status(400).json({ error: 'duration too short for score' });
    }
    if (duration > 60 * 60 * 1000) {
      return res.status(400).json({ error: 'duration too long' });
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
