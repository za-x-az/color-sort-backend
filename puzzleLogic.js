// puzzleLogic.js – works in browser AND Node.js
(function () {
  const DEFAULT_COLORS = [
    { name: 'Red',    hex: '#ff0040', letter: 'R' },
    { name: 'Green',  hex: '#00ff66', letter: 'G' },
    { name: 'Blue',   hex: '#0099ff', letter: 'B' },
    { name: 'Yellow', hex: '#ffdd00', letter: 'Y' },
    { name: 'Purple', hex: '#b300ff', letter: 'P' },
    { name: 'Orange', hex: '#ff6600', letter: 'O' },
    { name: 'Cyan',   hex: '#00ffff', letter: 'C' },
    { name: 'Pink',   hex: '#ff66b2', letter: 'K' },
    { name: 'Lime',   hex: '#ccff00', letter: 'L' },
    { name: 'Brown',  hex: '#cc9966', letter: 'W' }
  ];

  const NUM_TUBES    = 12;
  const SLOTS_PER_TUBE = 4;
  const NUM_COLORS   = 10;

  // ── Valid color names (used to guard server-side state manipulation) ────────
  const VALID_COLOR_NAMES = new Set(DEFAULT_COLORS.map(c => c.name));

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function deepCopyTubes(t) { return t.map(tube => [...tube]); }

  function getOccupiedCount(tube) {
    let c = 0;
    for (let i = 0; i < SLOTS_PER_TUBE; i++) {
      if (tube[i] !== null) c++;
      else break;
    }
    return c;
  }

  function getBottomBlock(tube) {
    const occ = getOccupiedCount(tube);
    if (!occ) return [];
    const color = tube[occ - 1];
    const block = [];
    for (let i = occ - 1; i >= 0 && tube[i] === color; i--) block.push(color);
    return block;
  }

  function canPlace(tube, color) {
    const occ = getOccupiedCount(tube);
    if (occ === 0) return true;
    if (occ >= SLOTS_PER_TUBE) return false;
    return tube[occ - 1] === color;
  }

  function availableSlots(tube) { return SLOTS_PER_TUBE - getOccupiedCount(tube); }

  function performMove(tubes, src, dst) {
    if (src === dst) return false;
    // ── Bounds check (important when called server-side) ──────────────────────
    if (src < 0 || src >= tubes.length || dst < 0 || dst >= tubes.length) return false;

    const srcT = tubes[src], dstT = tubes[dst];
    const block = getBottomBlock(srcT);
    if (!block.length) return false;
    const color = block[0];
    if (!canPlace(dstT, color)) return false;
    const cap = availableSlots(dstT);
    if (!cap) return false;
    const cnt = Math.min(block.length, cap);
    const srcOcc = getOccupiedCount(srcT);
    for (let i = 0; i < cnt; i++) srcT[srcOcc - 1 - i] = null;
    const dstOcc = getOccupiedCount(dstT);
    for (let i = 0; i < cnt; i++) dstT[dstOcc + i] = color;
    return true;
  }

  function isWinState(state) {
    const counts = {};
    for (let t of state) {
      const occ = getOccupiedCount(t);
      if (!occ) continue;
      if (occ !== SLOTS_PER_TUBE) return false;
      const first = t[0];
      if (t.some(c => c !== first)) return false;
      counts[first] = (counts[first] || 0) + 1;
    }
    return Object.keys(counts).length === NUM_COLORS &&
           Object.values(counts).every(v => v === 1);
  }

  function normalizeState(s) {
    return s.map(t => t.map(c => c || 'null').join(',')).sort().join('|');
  }

  function isSolvable(state, maxD = 40) {
    if (isWinState(state)) return true;
    const visited = new Set();
    const stack   = [{ s: deepCopyTubes(state), d: 0 }];
    visited.add(normalizeState(state));
    while (stack.length) {
      const { s, d } = stack.pop();
      if (d >= maxD) continue;
      for (let src = 0; src < s.length; src++) {
        const blk = getBottomBlock(s[src]);
        if (!blk.length) continue;
        const col = blk[0];
        for (let dst = 0; dst < s.length; dst++) {
          if (src === dst || !canPlace(s[dst], col) || !availableSlots(s[dst])) continue;
          const ns   = deepCopyTubes(s);
          const srcO = getOccupiedCount(ns[src]);
          const cap  = availableSlots(ns[dst]);
          const cnt  = Math.min(blk.length, cap);
          for (let i = 0; i < cnt; i++) ns[src][srcO - 1 - i] = null;
          const dstO = getOccupiedCount(ns[dst]);
          for (let i = 0; i < cnt; i++) ns[dst][dstO + i] = col;
          const key = normalizeState(ns);
          if (!visited.has(key)) {
            if (isWinState(ns)) return true;
            visited.add(key);
            stack.push({ s: ns, d: d + 1 });
          }
        }
      }
    }
    return false;
  }

  function generateRandomDistribution(rand, colors) {
    const pool = [];
    colors.forEach(c => { for (let i = 0; i < 4; i++) pool.push(c.name); });
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const state = Array.from({ length: NUM_TUBES }, () => new Array(SLOTS_PER_TUBE).fill(null));
    let idx = 0;
    for (let t = 0; t < NUM_TUBES; t++)
      for (let s = 0; s < SLOTS_PER_TUBE; s++)
        if (idx < pool.length) state[t][s] = pool[idx++];
    return state;
  }

  function generatePuzzle(seed, difficulty, colors = DEFAULT_COLORS) {
    // ── FIX: validate seed is a plain string to prevent prototype pollution ───
    if (typeof seed !== 'string') seed = String(seed).slice(0, 64);

    const maxAttempts = 100;
    for (let att = 0; att < maxAttempts; att++) {
      const r    = mulberry32(hashString(seed + '::' + att));
      const cand = generateRandomDistribution(r, colors);
      if (isSolvable(cand, 35 + att * 2)) return cand;
    }
    // Deterministic fallback (always solvable)
    return [
      ['Red',   'Green',  'Blue',  'Red'   ],
      ['Green', 'Blue',   'Red',   'Green' ],
      ['Blue',  'Red',    'Green', 'Blue'  ],
      ['Yellow','Purple', 'Orange','Yellow'],
      ['Purple','Orange', 'Cyan',  'Purple'],
      ['Orange','Cyan',   'Pink',  'Orange'],
      ['Cyan',  'Pink',   'Lime',  'Cyan'  ],
      ['Pink',  'Lime',   'Brown', 'Pink'  ],
      ['Lime',  'Brown',  'Yellow','Lime'  ],
      ['Brown', 'Yellow', 'Purple','Brown' ],
      [null, null, null, null],
      [null, null, null, null]
    ];
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  const exports = {
    DEFAULT_COLORS, VALID_COLOR_NAMES,
    NUM_TUBES, SLOTS_PER_TUBE, NUM_COLORS,
    mulberry32, hashString,
    deepCopyTubes, getOccupiedCount, getBottomBlock,
    canPlace, availableSlots, performMove, isWinState,
    normalizeState, isSolvable, generatePuzzle
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  } else {
    window.PuzzleLogic = exports;
  }
})();
