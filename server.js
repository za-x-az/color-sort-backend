const express = require('express');
const cors = require('cors');
const db = require('better-sqlite3')('leaderboard.db');
const PL = require('./puzzleLogic');

const app = express();
app.use(cors());
app.use(express.json());

// Create table if not exists
db.exec(`CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playerName TEXT NOT NULL,
  seed TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  moveCount INTEGER NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Submit a solved game (server validates)
app.post('/api/submit', (req, res) => {
  const { seed, difficulty, playerName, moves } = req.body;
  if (!seed || !difficulty || !playerName || !Array.isArray(moves)) {
    return res.status(400).json({ success: false, error: 'Missing fields' });
  }

  // Regenerate puzzle with default colors
  const initialState = PL.generatePuzzle(seed, difficulty, PL.DEFAULT_COLORS);
  let state = PL.deepCopyTubes(initialState);

  for (let i = 0; i < moves.length; i++) {
    const { src, dst } = moves[i];
    if (typeof src !== 'number' || typeof dst !== 'number') {
      return res.status(400).json({ success: false, error: `Invalid move at ${i}` });
    }
    if (!PL.performMove(state, src, dst)) {
      return res.status(400).json({ success: false, error: `Illegal move at ${i}` });
    }
  }

  if (!PL.isWinState(state)) {
    return res.status(400).json({ success: false, error: 'Not solved' });
  }

  const moveCount = moves.length;
  db.prepare('INSERT INTO scores (playerName, seed, difficulty, moveCount) VALUES (?, ?, ?, ?)')
    .run(playerName.trim(), seed, difficulty, moveCount);

  res.json({ success: true, moveCount });
});

// Get leaderboard for a specific seed + difficulty
app.get('/api/leaderboard', (req, res) => {
  const seed = req.query.seed;
  const difficulty = req.query.difficulty || 'medium';
  if (!seed) {
    return res.status(400).json({ error: 'Missing seed parameter' });
  }

  // Get top 50
  const top = db.prepare(`
    SELECT playerName, moveCount, seed, difficulty, timestamp
    FROM scores
    WHERE seed = ? AND difficulty = ?
    ORDER BY moveCount ASC
    LIMIT 50
  `).all(seed, difficulty);

  // Get total count for this seed+difficulty
  const total = db.prepare(`
    SELECT COUNT(*) as count FROM scores WHERE seed = ? AND difficulty = ?
  `).get(seed, difficulty).count;

  res.json({ top, total });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
