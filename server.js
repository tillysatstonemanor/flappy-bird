// Tiny leaderboard server for Flappy Bird.
// Usage: npm install && npm start  -> http://localhost:3000
// Share via LAN (your IP) or expose with a tunnel like ngrok / cloudflared.

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'scores.json');
const MAX_NAME = 16;
const MAX_ENTRIES = 100;

app.use(express.json({ limit: '4kb' }));
app.use(express.static(__dirname));

// CORS so it works if hosted separately from the static site.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

app.get('/api/scores', (req, res) => {
  const list = loadScores()
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  res.json(list);
});

app.post('/api/scores', (req, res) => {
  let { name, score } = req.body || {};
  if (typeof name !== 'string' || typeof score !== 'number') {
    return res.status(400).json({ error: 'invalid payload' });
  }
  name = name.trim().slice(0, MAX_NAME) || 'Anon';
  score = Math.max(0, Math.min(99999, Math.floor(score)));

  const list = loadScores();
  list.push({ name, score, at: Date.now() });
  list.sort((a, b) => b.score - a.score);
  saveScores(list.slice(0, MAX_ENTRIES));

  const top = list.slice(0, 20);
  res.json({ ok: true, top });
});

app.listen(PORT, () => {
  console.log(`Flappy leaderboard running: http://localhost:${PORT}`);
});
