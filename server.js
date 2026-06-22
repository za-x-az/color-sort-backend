const express = require('express');
const cors = require('cors');
const db = require('better-sqlite3')('leaderboard.db');
const PL = require('./puzzleLogic');

const app = express();
app.use(cors());
app.use(express.json());

db.exec(`CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playerName TEXT NOT NULL,
  seed TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  moveCount INTEGER NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

app.post('/api/submit', (req, res) => {
  const { seed, difficulty, playerName, moves } = req.body;
  if (!seed || !difficulty || !playerName || !Array.isArray(moves)) {
    return res.status(400).json({ success: false, error: 'Missing fields' });
  }

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

app.get('/api/leaderboard', (req, res) => {
  const difficulty = req.query.difficulty || 'medium';
  const rows = db.prepare('SELECT playerName, moveCount, seed FROM scores WHERE difficulty = ? ORDER BY moveCount ASC LIMIT 20').all(difficulty);
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));