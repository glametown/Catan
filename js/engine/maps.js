// Map layouts + board generation (terrain, number tokens, harbors).

import { getGeometry, edgeMid, HEX_DIRS } from './geometry.js';
import { shuffle } from './rng.js';

const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const RES_TERRAIN = { wood: 'forest', brick: 'hills', sheep: 'pasture', wheat: 'fields', ore: 'mountains' };

// Row lengths -> axial coords. Each row must satisfy (len - 1 + rowIndex) even.
function rows(lens) {
  const out = [];
  lens.forEach((len, r) => {
    for (let i = 0; i < len; i++) out.push([Math.round(i - (len - 1) / 2 - r / 2), r]);
  });
  return out;
}

const dist = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;

function within(filter, R) {
  const out = [];
  for (let q = -R; q <= R; q++) {
    for (let r = -R; r <= R; r++) if (filter(q, r)) out.push([q, r]);
  }
  return out;
}

// Random, compact, connected blob of n hexes.
function wild(n, rnd) {
  const set = new Map([['0,0', [0, 0]]]);
  while (set.size < n) {
    const cand = new Map();
    for (const [q, r] of set.values()) {
      for (const [dq, dr] of HEX_DIRS) {
        const key = q + dq + ',' + (r + dr);
        if (set.has(key)) continue;
        const c = cand.get(key) || { q: q + dq, r: r + dr, n: 0 };
        c.n++;
        cand.set(key, c);
      }
    }
    const list = [...cand.values()];
    const weights = list.map((c) => Math.pow(c.n, 1.6));
    let roll = rnd() * weights.reduce((a, b) => a + b, 0);
    let pick = list[list.length - 1];
    for (let i = 0; i < list.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { pick = list[i]; break; }
    }
    set.set(pick.q + ',' + pick.r, [pick.q, pick.r]);
  }
  return [...set.values()];
}

export const MAPS = {
  classic: {
    name: 'Classic', icon: '🏝️', min: 2, max: 4, deserts: 1,
    desc: 'The familiar 19-hex island.',
    coords: () => rows([3, 4, 5, 4, 3]),
  },
  grand: {
    name: 'Grand Island', icon: '🗺️', min: 3, max: 6, deserts: 2,
    desc: '30 hexes — room for five or six players.',
    coords: () => rows([3, 4, 5, 6, 5, 4, 3]),
  },
  blossom: {
    name: 'Blossom', icon: '🌸', min: 2, max: 3, deserts: 1,
    desc: 'A compact 13-hex island for duels and trios.',
    coords: () => within((q, r) => dist(q, r) <= 1 || (dist(q, r) === 2 && !(q % 2 === 0 && r % 2 === 0 && (q === 0 || r === 0 || q + r === 0))), 2),
  },
  delta: {
    name: 'Delta', icon: '🔺', min: 2, max: 3, deserts: 1,
    desc: 'A triangular island — tight, tactical and cut-throat.',
    coords: () => rows([1, 2, 3, 4, 5]),
  },
  hourglass: {
    name: 'Hourglass', icon: '⏳', min: 3, max: 5, deserts: 1,
    desc: 'Two lands joined by a narrow pass. Whoever holds the neck wins.',
    coords: () => rows([5, 4, 3, 2, 3, 4, 5]),
  },
  crater: {
    name: 'Crater Lake', icon: '🌋', min: 3, max: 6, deserts: 2,
    desc: 'A ring of land around a sea lake — harbors on both coasts.',
    coords: () => within((q, r) => dist(q, r) >= 2 && dist(q, r) <= 3, 3),
  },
  wild: {
    name: 'Wild Lands', icon: '🎲', min: 2, max: 6, deserts: (n) => (n >= 28 ? 2 : 1),
    desc: 'A brand-new random coastline every game.',
    coords: (rnd, players) => wild(10 + 4 * players, rnd),
  },
};

const TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
const EXTRA = [6, 8, 5, 9, 4, 10, 3, 11, 6, 8, 5, 9];
const REMOVE = [2, 12, 3, 11, 4, 10, 5, 9];

function tokenList(n) {
  let list = TOKENS.slice();
  if (n > list.length) {
    for (let i = 0; list.length < n; i++) list.push(EXTRA[i % EXTRA.length]);
  } else {
    for (let i = 0; list.length > n; i++) {
      const at = list.indexOf(REMOVE[i % REMOVE.length]);
      list.splice(at >= 0 ? at : list.length - 1, 1);
    }
  }
  return list;
}

function terrainList(n, deserts) {
  const weights = { wood: 4, brick: 3, sheep: 4, wheat: 4, ore: 3 };
  const nres = n - deserts;
  const counts = {};
  const frac = [];
  let used = 0;
  for (const r of RES) {
    const exact = (nres * weights[r]) / 18;
    counts[r] = Math.floor(exact);
    used += counts[r];
    frac.push([exact - counts[r], r]);
  }
  frac.sort((a, b) => b[0] - a[0]);
  for (let i = 0; used < nres; i++, used++) counts[frac[i % frac.length][1]]++;
  const out = [];
  for (const r of RES) for (let i = 0; i < counts[r]; i++) out.push(RES_TERRAIN[r]);
  for (let i = 0; i < deserts; i++) out.push('desert');
  return out;
}

function placeHarbors(geo, rnd) {
  const coastal = shuffle(geo.edges.filter((e) => e.hexes.length === 1), rnd);
  const want = Math.max(4, Math.round(geo.hexes.length * 0.47));
  const mids = new Map(coastal.map((e) => [e.id, edgeMid(geo, e)]));
  const chosen = [];
  const blocked = new Set();
  while (chosen.length < want) {
    let best = null;
    let bestD = -1;
    for (const c of coastal) {
      if (blocked.has(c.a) || blocked.has(c.b)) continue;
      const m = mids.get(c.id);
      let d = 1e9;
      for (const o of chosen) {
        const om = mids.get(o.id);
        d = Math.min(d, Math.hypot(m.x - om.x, m.y - om.y));
      }
      if (d > bestD) { bestD = d; best = c; }
    }
    if (!best) break;
    chosen.push(best);
    for (const v of [best.a, best.b]) {
      blocked.add(v);
      for (const adj of geo.vertices[v].adj) blocked.add(adj);
    }
  }
  const generic = Math.round((chosen.length * 4) / 9);
  const types = [];
  for (let i = 0; i < generic; i++) types.push('any');
  const specific = shuffle(RES.slice(), rnd);
  for (let i = 0; types.length < chosen.length; i++) types.push(specific[i % specific.length]);
  shuffle(types, rnd);
  return chosen.map((e, i) => ({ edge: e.id, type: types[i] }));
}

export function buildBoard(mapId, rnd, nPlayers) {
  const def = MAPS[mapId] || MAPS.classic;
  const coords = def.coords(rnd, nPlayers);
  const geo = getGeometry(coords);
  const n = coords.length;
  const deserts = typeof def.deserts === 'function' ? def.deserts(n) : def.deserts;
  const terrains = shuffle(terrainList(n, deserts), rnd);
  const hexes = terrains.map((terrain) => ({ terrain, number: null }));
  const resIdx = hexes.map((h, i) => (h.terrain === 'desert' ? -1 : i)).filter((i) => i >= 0);
  const tokens = tokenList(resIdx.length);

  let attempt = 0;
  let order;
  do {
    order = shuffle(tokens.slice(), rnd);
    attempt++;
  } while (
    attempt < 400 &&
    resIdx.some((hi, a) => {
      if (order[a] !== 6 && order[a] !== 8) return false;
      return geo.hexes[hi].adjHexes.some((nb) => {
        const b = resIdx.indexOf(nb);
        return b >= 0 && (order[b] === 6 || order[b] === 8);
      });
    })
  );
  resIdx.forEach((hi, a) => { hexes[hi].number = order[a]; });

  return { coords, hexes, harbors: placeHarbors(geo, rnd) };
}
