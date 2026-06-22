const express = require('express');
const cors = require('cors');
const db = require('better-sqlite3')('leaderboard.db');
const PL = require('./puzzleLogic');

const app = express();

// ── Rate limiting ────────────────────────────────────────────────────────────
// Simple in-memory rate limiter (no extra deps needed).
// For production, swap with the 'express-rate-limit' package.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_SUBMIT = 10;    // max 10 submissions per minute per IP
const RATE_LIMIT_MAX_LEADERBOARD = 30;

function rateLimit(maxRequests) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress;
    const key = `${req.path}::${ip}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, start: now };

    if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
      entry.count = 1;
      entry.start = now;
    } else {
      entry.count++;
    }
    rateLimitMap.set(key, entry);

    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}

// ── CORS ─────────────────────────────────────────────────────────────────────
// Restrict to your actual frontend origin in production.
// Replace the origin below (or set ALLOWED_ORIGIN env var).
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

// ── Body parser – hard cap at 50 KB ──────────────────────────────────────────
// Prevents oversized payload / DoS attacks.
app.use(express.json({ limit: '50kb' }));

// ── DB schema ─────────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  playerName TEXT    NOT NULL,
  seed       TEXT    NOT NULL,
  difficulty TEXT    NOT NULL,
  moveCount  INTEGER NOT NULL,
  timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ── Validation helpers ────────────────────────────────────────────────────────
const ALLOWED_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const MAX_PLAYER_NAME_LEN  = 32;
const MAX_SEED_LEN         = 64;
const MAX_MOVES            = 500; // sane upper bound for a 12-tube puzzle
const NUM_TUBES            = PL.NUM_TUBES;

function sanitizeName(name) {
  // Strip control chars; keep printable Unicode
  return name.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Submit score ──────────────────────────────────────────────────────────────
app.post('/api/submit', rateLimit(RATE_LIMIT_MAX_SUBMIT), (req, res) => {
  const { seed, difficulty, playerName, moves } = req.body;

  // ── 1. Presence check ──────────────────────────────────────────────────────
  if (!seed || !difficulty || !playerName || !Array.isArray(moves)) {
    return res.status(400).json({ success: false, error: 'Missing or malformed fields.' });
  }

  // ── 2. Type / length / whitelist checks ────────────────────────────────────
  if (typeof seed !== 'string' || seed.length > MAX_SEED_LEN) {
    return res.status(400).json({ success: false, error: 'Invalid seed.' });
  }
  if (!ALLOWED_DIFFICULTIES.has(difficulty)) {
    return res.status(400).json({ success: false, error: 'Invalid difficulty.' });
  }
  if (typeof playerName !== 'string' || playerName.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid playerName.' });
  }

  const cleanName = sanitizeName(playerName);
  if (cleanName.length === 0 || cleanName.length > MAX_PLAYER_NAME_LEN) {
    return res.status(400).json({ success: false, error: `playerName must be 1–${MAX_PLAYER_NAME_LEN} characters.` });
  }

  // ── 3. Moves array sanity ──────────────────────────────────────────────────
  if (moves.length === 0) {
    return res.status(400).json({ success: false, error: 'No moves submitted.' });
  }
  if (moves.length > MAX_MOVES) {
    return res.status(400).json({ success: false, error: `Too many moves (max ${MAX_MOVES}).` });
  }

  // ── 4. Replay verification ────────────────────────────────────────────────
  const initialState = PL.generatePuzzle(seed, difficulty, PL.DEFAULT_COLORS);
  let state = PL.deepCopyTubes(initialState);

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];

    // Each move must be a plain object with integer src/dst in valid range
    if (
      typeof move !== 'object' || move === null ||
      typeof move.src !== 'number' || typeof move.dst !== 'number' ||
      !Number.isInteger(move.src) || !Number.isInteger(move.dst) ||
      move.src < 0 || move.src >= NUM_TUBES ||
      move.dst < 0 || move.dst >= NUM_TUBES
    ) {
      return res.status(400).json({ success: false, error: `Invalid move at index ${i}.` });
    }

    if (!PL.performMove(state, move.src, move.dst)) {
      return res.status(400).json({ success: false, error: `Illegal move at index ${i}.` });
    }
  }

  if (!PL.isWinState(state)) {
    return res.status(400).json({ success: false, error: 'Puzzle not in win state after replaying moves.' });
  }

  // ── 5. Persist ────────────────────────────────────────────────────────────
  const moveCount = moves.length;
  db.prepare(
    'INSERT INTO scores (playerName, seed, difficulty, moveCount) VALUES (?, ?, ?, ?)'
  ).run(cleanName, seed, difficulty, moveCount);

  res.json({ success: true, moveCount });
});

// ── Leaderboard ───────────────────────────────────────────────────────────────
app.get('/api/leaderboard', rateLimit(RATE_LIMIT_MAX_LEADERBOARD), (req, res) => {
  const { seed, difficulty = 'medium' } = req.query;

  if (!seed || typeof seed !== 'string' || seed.length > MAX_SEED_LEN) {
    return res.status(400).json({ error: 'Missing or invalid seed parameter.' });
  }
  if (!ALLOWED_DIFFICULTIES.has(difficulty)) {
    return res.status(400).json({ error: 'Invalid difficulty parameter.' });
  }

  const top = db.prepare(`
    SELECT playerName, moveCount, seed, difficulty, timestamp
    FROM scores
    WHERE seed = ? AND difficulty = ?
    ORDER BY moveCount ASC
    LIMIT 50
  `).all(seed, difficulty);

  const { count: total } = db.prepare(`
    SELECT COUNT(*) AS count FROM scores WHERE seed = ? AND difficulty = ?
  `).get(seed, difficulty);

  res.json({ top, total });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
