// Rules engine. Pure functions over a JSON-serialisable state object:
//   createGame(options)      -> state
//   applyAction(state, act)  -> { ok: true, state } | { ok: false, error }
// The host of a game runs this; everybody else just renders the state.

import { rand, shuffle } from './rng.js';
import { getGeometry } from './geometry.js';
import { buildBoard } from './maps.js';
import { resolveRules } from './modes.js';

export const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️' };
export const TERRAIN_RES = { forest: 'wood', hills: 'brick', pasture: 'sheep', fields: 'wheat', mountains: 'ore', desert: null };
export const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};
export const PLAYER_COLORS = ['#e5484d', '#3e63dd', '#f5a524', '#30a46c', '#8e4ec6', '#12a594'];
export const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
export const DEV_NAMES = {
  knight: 'Knight', vp: 'Victory Point', roadbuilding: 'Road Building',
  yearofplenty: 'Year of Plenty', monopoly: 'Monopoly',
};
const MAX_PIECES = { road: 15, settlement: 5, city: 4 };

export class GameError extends Error {}
const fail = (m) => { throw new GameError(m); };

export const geoOf = (s) => getGeometry(s.board.coords);
export const zero = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
export const total = (r) => RES.reduce((a, k) => a + (r[k] || 0), 0);
export const canPay = (have, cost) => RES.every((k) => (have[k] || 0) >= (cost[k] || 0));

function pay(pl, cost) {
  if (!canPay(pl.res, cost)) fail('Not enough resources.');
  for (const k of RES) pl.res[k] -= cost[k] || 0;
}
function log(s, p, text) {
  s.log.push({ p, text });
  if (s.log.length > 80) s.log.shift();
}
const gainText = (g) => RES.filter((k) => g[k]).map((k) => `${g[k]}${RES_ICON[k]}`).join(' ');

// ---------------------------------------------------------------- creation

export function createGame({ players, mapId = 'classic', modeId = 'classic', overrides = {}, seed }) {
  const n = players.length;
  if (n < 2 || n > 6) throw new Error('A game needs 2–6 players.');
  const s = { v: 1, rev: 0, rng: ((seed ?? Math.floor(Math.random() * 4294967296)) >>> 0) || 1 };
  const rnd = () => rand(s);
  const rules = resolveRules(modeId, overrides);
  s.config = { mapId, modeId, rules, nPlayers: n };

  const order = shuffle(players.map((_, i) => i), rnd);
  s.players = order.map((idx, i) => ({
    uid: players[idx].uid,
    name: players[idx].name,
    photo: players[idx].photo || null,
    bot: !!players[idx].bot,
    color: i,
    res: zero(),
    dev: [],
    devNew: [],
    knights: 0,
    left: { ...MAX_PIECES },
  }));

  const board = buildBoard(mapId, rnd, n);
  let robber = -1;
  if (rules.robber) {
    robber = board.hexes.findIndex((h) => h.terrain === 'desert');
    if (robber < 0) robber = 0;
  }
  s.board = { coords: board.coords, hexes: board.hexes, harbors: board.harbors, robber };
  s.roads = {};
  s.buildings = {};

  const big = n > 4;
  const deck = [
    ...Array(big ? 20 : 14).fill('knight'),
    ...Array(5).fill('vp'),
    ...Array(big ? 3 : 2).fill('roadbuilding'),
    ...Array(big ? 3 : 2).fill('yearofplenty'),
    ...Array(big ? 3 : 2).fill('monopoly'),
  ];
  s.devDeck = shuffle(deck, rnd);
  s.diceDeck = [];
  s.dice = null;
  s.devPlayed = false;
  s.freeRoads = 0;
  s.discard = null;
  s.trade = null;
  s.returnPhase = 'main';
  s.longestRoad = { holder: null, len: 0 };
  s.largestArmy = { holder: null };
  s.winner = null;
  s.turnNo = 0;
  s.log = [];

  const seq = [...Array(n).keys()];
  s.phase = 'setup';
  s.setup = { seq: [...seq, ...[...seq].reverse()], i: 0, expect: 'settlement', last: null };
  s.turn = seq[0];
  log(s, null, `Game on! First to ${rules.vpToWin} victory points wins.`);
  return s;
}

// ------------------------------------------------------------ query helpers

export function canSettleError(s, geo, vid, p, setup) {
  if (s.buildings[vid]) return 'That spot is taken.';
  const v = geo.vertices[vid];
  if (v.adj.some((a) => s.buildings[a])) return 'Too close to another settlement (keep two roads apart).';
  if (!setup && !v.edges.some((e) => s.roads[e] === p)) return 'A new settlement must connect to one of your roads.';
  return null;
}

export function settlementSpots(s, p, setup = false) {
  const geo = geoOf(s);
  return geo.vertices.filter((v) => !canSettleError(s, geo, v.id, p, setup)).map((v) => v.id);
}

export function citySpots(s, p) {
  return Object.entries(s.buildings).filter(([, b]) => b.p === p && b.type === 'settlement').map(([v]) => +v);
}

function roadConnected(s, geo, e, p) {
  const ed = geo.edges[e];
  for (const v of [ed.a, ed.b]) {
    const b = s.buildings[v];
    if (b) {
      if (b.p === p) return true;
      continue; // an opponent's building blocks the connection
    }
    if (geo.vertices[v].edges.some((o) => o !== e && s.roads[o] === p)) return true;
  }
  return false;
}

export function roadSpots(s, p) {
  const geo = geoOf(s);
  if (s.phase === 'setup') {
    if (s.setup.last == null) return [];
    return geo.vertices[s.setup.last].edges.filter((e) => s.roads[e] === undefined);
  }
  return geo.edges.filter((e) => s.roads[e.id] === undefined && roadConnected(s, geo, e.id, p)).map((e) => e.id);
}

export function robberVictims(s, hex, p) {
  const geo = geoOf(s);
  const set = new Set();
  for (const v of geo.hexes[hex].vertices) {
    const b = s.buildings[v];
    if (b && b.p !== p && total(s.players[b.p].res) > 0) set.add(b.p);
  }
  return [...set];
}

export function tradeRatio(s, p, res) {
  const geo = geoOf(s);
  const r = s.config.rules;
  let ratio = r.bankRatio;
  for (const h of s.board.harbors) {
    const e = geo.edges[h.edge];
    if (![e.a, e.b].some((v) => s.buildings[v] && s.buildings[v].p === p)) continue;
    if (h.type === 'any') ratio = Math.min(ratio, r.portAnyRatio);
    else if (h.type === res) ratio = Math.min(ratio, r.portResRatio);
  }
  return ratio;
}

export function publicVP(s, p) {
  let vp = 0;
  for (const b of Object.values(s.buildings)) if (b.p === p) vp += b.type === 'city' ? 2 : 1;
  if (s.longestRoad.holder === p) vp += 2;
  if (s.largestArmy.holder === p) vp += 2;
  return vp;
}

export function totalVP(s, p) {
  const pl = s.players[p];
  return publicVP(s, p) + pl.dev.filter((c) => c === 'vp').length + pl.devNew.filter((c) => c === 'vp').length;
}

export function longestRoadFor(s, p) {
  const geo = geoOf(s);
  const owned = Object.entries(s.roads).filter(([, o]) => o === p).map(([e]) => +e);
  if (!owned.length) return 0;
  const byVertex = new Map();
  for (const e of owned) {
    for (const v of [geo.edges[e].a, geo.edges[e].b]) {
      if (!byVertex.has(v)) byVertex.set(v, []);
      byVertex.get(v).push(e);
    }
  }
  let best = 0;
  const used = new Set();
  const dfs = (v, len) => {
    if (len > best) best = len;
    const b = s.buildings[v];
    if (b && b.p !== p) return;
    for (const e2 of byVertex.get(v) || []) {
      if (used.has(e2)) continue;
      used.add(e2);
      const ed = geo.edges[e2];
      dfs(ed.a === v ? ed.b : ed.a, len + 1);
      used.delete(e2);
    }
  };
  for (const e of owned) {
    const ed = geo.edges[e];
    for (const [from, to] of [[ed.a, ed.b], [ed.b, ed.a]]) {
      void from;
      used.clear();
      used.add(e);
      dfs(to, 1);
    }
  }
  return best;
}

// ----------------------------------------------------------------- mutation

function updateLongestRoad(s) {
  const lens = s.players.map((_, i) => longestRoadFor(s, i));
  const max = Math.max(...lens);
  const prev = s.longestRoad.holder;
  let holder = null;
  if (max >= 5) {
    const tied = lens.map((l, i) => (l === max ? i : -1)).filter((i) => i >= 0);
    if (prev != null && tied.includes(prev)) holder = prev;
    else if (tied.length === 1) holder = tied[0];
  }
  s.longestRoad = { holder, len: max };
  s.longestRoad.lens = lens;
  if (holder !== prev && holder != null) log(s, holder, `${s.players[holder].name} takes Longest Road (${max}).`);
}

function updateLargestArmy(s, p) {
  const me = s.players[p];
  const h = s.largestArmy.holder;
  if (me.knights >= 3 && h !== p && (h == null || me.knights > s.players[h].knights)) {
    s.largestArmy.holder = p;
    log(s, p, `${me.name} takes Largest Army (${me.knights} knights).`);
  }
}

function placeSettlement(s, p, v) {
  s.buildings[v] = { p, type: 'settlement' };
  s.players[p].left.settlement--;
}

function placeRoad(s, p, e) {
  s.roads[e] = p;
  s.players[p].left.road--;
}

function rollDice(s) {
  const r = s.config.rules;
  if (r.balancedDice) {
    if (!s.diceDeck.length) {
      const all = [];
      for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) all.push([a, b]);
      s.diceDeck = shuffle(all, () => rand(s));
    }
    return s.diceDeck.pop();
  }
  return [1 + Math.floor(rand(s) * 6), 1 + Math.floor(rand(s) * 6)];
}

function produce(s, geo, roll) {
  const gains = s.players.map(zero);
  const mult = s.config.rules.productionMultiplier;
  geo.hexes.forEach((h, i) => {
    const hx = s.board.hexes[i];
    if (hx.number !== roll || i === s.board.robber) return;
    const r = TERRAIN_RES[hx.terrain];
    if (!r) return;
    for (const v of h.vertices) {
      const b = s.buildings[v];
      if (b) gains[b.p][r] += (b.type === 'city' ? 2 : 1) * mult;
    }
  });
  let any = false;
  gains.forEach((g, i) => {
    if (!total(g)) return;
    any = true;
    for (const k of RES) s.players[i].res[k] += g[k];
    log(s, i, `${s.players[i].name} gets ${gainText(g)}`);
  });
  if (!any) log(s, null, 'No one gets any resources.');
}

function steal(s, from, to) {
  const pool = [];
  for (const k of RES) for (let i = 0; i < s.players[from].res[k]; i++) pool.push(k);
  if (!pool.length) return null;
  const k = pool[Math.floor(rand(s) * pool.length)];
  s.players[from].res[k]--;
  s.players[to].res[k]++;
  return k;
}

function beginRobber(s, returnPhase) {
  s.returnPhase = returnPhase;
  s.phase = 'robber';
}

const idx = (x, max, label) => {
  if (!Number.isInteger(x) || x < 0 || x >= max) fail(`Invalid ${label}.`);
  return x;
};

function cleanBundle(b) {
  const out = zero();
  for (const k of RES) {
    const v = (b && b[k]) || 0;
    if (!Number.isInteger(v) || v < 0 || v > 30) fail('Invalid trade.');
    out[k] = v;
  }
  return out;
}

function handle(s, a) {
  if (s.phase === 'ended') fail('The game is over.');
  const geo = geoOf(s);
  const p = a.p;
  const me = s.players[p];
  if (!me) fail('Unknown player.');
  const rules = s.config.rules;
  const needTurn = () => { if (s.turn !== p) fail("It's not your turn."); };
  const needMain = () => {
    needTurn();
    if (s.phase === 'roll') fail('Roll the dice first.');
    if (s.phase === 'robber') fail('Move the robber first.');
    if (s.phase === 'discard') fail('Waiting for players to discard.');
    if (s.phase !== 'main') fail('You cannot do that right now.');
    if (s.freeRoads > 0) fail('Place your free roads first.');
  };

  switch (a.type) {
    case 'roll': {
      needTurn();
      if (s.phase !== 'roll') fail('You have already rolled.');
      const d = rollDice(s);
      s.dice = d;
      const roll = d[0] + d[1];
      log(s, p, `${me.name} rolled ${roll} (${d[0]}+${d[1]}).`);
      if (roll !== 7) {
        produce(s, geo, roll);
        s.phase = 'main';
      } else if (!rules.robber) {
        log(s, null, 'A 7! The robber is sleeping, so nothing happens.');
        s.phase = 'main';
      } else {
        const need = {};
        s.players.forEach((pl, i) => {
          const t = total(pl.res);
          if (t > rules.discardLimit) need[i] = Math.floor(t / 2);
        });
        s.returnPhase = 'main';
        if (Object.keys(need).length) {
          s.phase = 'discard';
          s.discard = { need };
          log(s, null, 'A 7! Players with too many cards must discard half.');
        } else {
          s.phase = 'robber';
          log(s, null, 'A 7! Move the robber.');
        }
      }
      break;
    }

    case 'discard': {
      if (s.phase !== 'discard') fail('Nobody needs to discard.');
      const need = s.discard.need[p];
      if (!need) fail('You do not need to discard.');
      const cards = cleanBundle(a.cards);
      if (total(cards) !== need) fail(`Choose exactly ${need} cards to discard.`);
      if (!canPay(me.res, cards)) fail("You don't have those cards.");
      for (const k of RES) me.res[k] -= cards[k];
      delete s.discard.need[p];
      log(s, p, `${me.name} discarded ${need} cards.`);
      if (!Object.keys(s.discard.need).length) {
        s.discard = null;
        s.phase = 'robber';
        log(s, null, 'Move the robber.');
      }
      break;
    }

    case 'moveRobber': {
      needTurn();
      if (s.phase !== 'robber') fail('You cannot move the robber now.');
      const hex = idx(a.hex, geo.hexes.length, 'hex');
      if (hex === s.board.robber) fail('The robber must move to a different hex.');
      s.board.robber = hex;
      const vics = robberVictims(s, hex, p);
      let victim = a.victim;
      if (vics.length === 1 && victim == null) victim = vics[0];
      if (vics.length && !vics.includes(victim)) fail('Choose a player to steal from.');
      if (vics.length) {
        const got = steal(s, victim, p);
        log(s, p, `${me.name} moved the robber and stole a card from ${s.players[victim].name}.`);
        void got;
      } else {
        log(s, p, `${me.name} moved the robber.`);
      }
      s.phase = s.returnPhase;
      break;
    }

    case 'buildSettlement': {
      const v = idx(a.vertex, geo.vertices.length, 'spot');
      if (s.phase === 'setup') {
        needTurn();
        if (s.setup.expect !== 'settlement') fail('Place a road next.');
        const err = canSettleError(s, geo, v, p, true);
        if (err) fail(err);
        placeSettlement(s, p, v);
        s.setup.last = v;
        s.setup.expect = 'road';
        if (s.setup.i >= s.players.length) {
          const g = zero();
          for (const hi of geo.vertices[v].hexes) {
            const r = TERRAIN_RES[s.board.hexes[hi].terrain];
            if (r) g[r]++;
          }
          for (const k of RES) me.res[k] += g[k];
          if (total(g)) log(s, p, `${me.name} gets ${gainText(g)} from the second settlement.`);
        }
      } else {
        needMain();
        if (me.left.settlement <= 0) fail('You have no settlements left (upgrade some to cities).');
        const err = canSettleError(s, geo, v, p, false);
        if (err) fail(err);
        pay(me, COSTS.settlement);
        placeSettlement(s, p, v);
        log(s, p, `${me.name} built a settlement.`);
        updateLongestRoad(s);
      }
      break;
    }

    case 'buildRoad': {
      const e = idx(a.edge, geo.edges.length, 'road spot');
      if (s.roads[e] !== undefined) fail('There is already a road there.');
      if (s.phase === 'setup') {
        needTurn();
        if (s.setup.expect !== 'road') fail('Place a settlement first.');
        if (!geo.vertices[s.setup.last].edges.includes(e)) fail('Build the road next to your new settlement.');
        placeRoad(s, p, e);
        s.setup.i++;
        if (s.setup.i >= s.setup.seq.length) {
          s.phase = 'roll';
          s.turn = s.setup.seq[0];
          s.setup = null;
          s.turnNo = 1;
          const hand = rules.startHand;
          if (hand) {
            s.players.forEach((pl) => {
              if (hand === 'random6') for (let i = 0; i < 6; i++) pl.res[RES[Math.floor(rand(s) * 5)]]++;
              else for (const k of RES) pl.res[k] += hand[k] || 0;
            });
            log(s, null, 'Everyone receives their starting hand.');
          }
          updateLongestRoad(s);
          log(s, s.turn, `${s.players[s.turn].name} goes first — roll the dice!`);
        } else {
          s.turn = s.setup.seq[s.setup.i];
          s.setup.expect = 'settlement';
          s.setup.last = null;
        }
      } else {
        needTurn();
        if (s.phase !== 'main') fail('Roll the dice first.');
        if (me.left.road <= 0) fail('You have no roads left.');
        if (!roadConnected(s, geo, e, p)) fail('A road must connect to your roads or settlements.');
        if (s.freeRoads > 0) s.freeRoads--;
        else pay(me, COSTS.road);
        placeRoad(s, p, e);
        log(s, p, `${me.name} built a road.`);
        if (s.freeRoads > 0 && (me.left.road <= 0 || !roadSpots(s, p).length)) s.freeRoads = 0;
        updateLongestRoad(s);
      }
      break;
    }

    case 'buildCity': {
      needMain();
      const v = idx(a.vertex, geo.vertices.length, 'spot');
      const b = s.buildings[v];
      if (!b || b.p !== p || b.type !== 'settlement') fail('Upgrade one of your own settlements.');
      if (me.left.city <= 0) fail('You have no cities left.');
      pay(me, COSTS.city);
      b.type = 'city';
      me.left.city--;
      me.left.settlement++;
      log(s, p, `${me.name} upgraded a settlement to a city.`);
      break;
    }

    case 'buyDev': {
      needMain();
      if (!s.devDeck.length) fail('The development deck is empty.');
      pay(me, COSTS.dev);
      const card = s.devDeck.pop();
      me.devNew.push(card);
      log(s, p, `${me.name} bought a development card.`);
      break;
    }

    case 'playKnight': {
      needTurn();
      if (s.phase !== 'roll' && s.phase !== 'main') fail('You cannot play that now.');
      if (s.freeRoads > 0) fail('Place your free roads first.');
      if (s.devPlayed) fail('Only one development card per turn.');
      const at = me.dev.indexOf('knight');
      if (at < 0) fail('You have no playable Knight.');
      me.dev.splice(at, 1);
      me.knights++;
      s.devPlayed = true;
      log(s, p, `${me.name} played a Knight.`);
      updateLargestArmy(s, p);
      if (rules.robber) beginRobber(s, s.phase);
      break;
    }

    case 'playRoadBuilding': {
      needMain();
      if (s.devPlayed) fail('Only one development card per turn.');
      const at = me.dev.indexOf('roadbuilding');
      if (at < 0) fail('You have no playable Road Building card.');
      me.dev.splice(at, 1);
      s.devPlayed = true;
      log(s, p, `${me.name} played Road Building.`);
      s.freeRoads = Math.min(2, me.left.road);
      if (!roadSpots(s, p).length) s.freeRoads = 0;
      break;
    }

    case 'playYearOfPlenty': {
      needMain();
      if (s.devPlayed) fail('Only one development card per turn.');
      const at = me.dev.indexOf('yearofplenty');
      if (at < 0) fail('You have no playable Year of Plenty card.');
      if (!RES.includes(a.a) || !RES.includes(a.b)) fail('Choose two resources.');
      me.dev.splice(at, 1);
      s.devPlayed = true;
      me.res[a.a]++;
      me.res[a.b]++;
      log(s, p, `${me.name} played Year of Plenty and took ${RES_ICON[a.a]} ${RES_ICON[a.b]}.`);
      break;
    }

    case 'playMonopoly': {
      needMain();
      if (s.devPlayed) fail('Only one development card per turn.');
      const at = me.dev.indexOf('monopoly');
      if (at < 0) fail('You have no playable Monopoly card.');
      if (!RES.includes(a.res)) fail('Choose a resource.');
      me.dev.splice(at, 1);
      s.devPlayed = true;
      let got = 0;
      s.players.forEach((pl, i) => {
        if (i === p) return;
        got += pl.res[a.res];
        me.res[a.res] += pl.res[a.res];
        pl.res[a.res] = 0;
      });
      log(s, p, `${me.name} played Monopoly on ${RES_ICON[a.res]} and took ${got}.`);
      break;
    }

    case 'bankTrade': {
      needMain();
      if (!RES.includes(a.give) || !RES.includes(a.get) || a.give === a.get) fail('Pick two different resources.');
      const ratio = tradeRatio(s, p, a.give);
      if (me.res[a.give] < ratio) fail(`You need ${ratio} ${a.give} for that trade.`);
      me.res[a.give] -= ratio;
      me.res[a.get]++;
      log(s, p, `${me.name} traded ${ratio}${RES_ICON[a.give]} for 1${RES_ICON[a.get]}.`);
      break;
    }

    case 'offerTrade': {
      needMain();
      const give = cleanBundle(a.give);
      const get = cleanBundle(a.get);
      if (!total(give) || !total(get)) fail('A trade needs cards on both sides.');
      if (RES.some((k) => give[k] && get[k])) fail('You cannot offer and request the same resource.');
      if (!canPay(me.res, give)) fail("You don't have those cards.");
      s.trade = { from: p, give, get, accepted: [], declined: [] };
      log(s, p, `${me.name} offers ${gainText(give)} for ${gainText(get)}.`);
      break;
    }

    case 'acceptTrade':
    case 'declineTrade': {
      const t = s.trade;
      if (!t || s.phase !== 'main') fail('There is no open offer.');
      if (t.from === p) fail('That is your own offer.');
      t.accepted = t.accepted.filter((i) => i !== p);
      t.declined = t.declined.filter((i) => i !== p);
      if (a.type === 'acceptTrade') {
        if (!canPay(me.res, t.get)) fail("You don't have the cards for that trade.");
        t.accepted.push(p);
      } else {
        t.declined.push(p);
      }
      break;
    }

    case 'confirmTrade': {
      needTurn();
      const t = s.trade;
      if (!t) fail('There is no open offer.');
      const other = idx(a.with, s.players.length, 'player');
      if (!t.accepted.includes(other)) fail('That player has not accepted.');
      const o = s.players[other];
      if (!canPay(me.res, t.give) || !canPay(o.res, t.get)) fail('Someone no longer has the cards.');
      for (const k of RES) {
        me.res[k] += t.get[k] - t.give[k];
        o.res[k] += t.give[k] - t.get[k];
      }
      log(s, p, `${me.name} traded with ${o.name}.`);
      s.trade = null;
      break;
    }

    case 'cancelTrade': {
      needTurn();
      s.trade = null;
      break;
    }

    case 'endTurn': {
      needMain();
      for (const c of me.devNew) me.dev.push(c);
      me.devNew = [];
      s.devPlayed = false;
      s.trade = null;
      s.turn = (s.turn + 1) % s.players.length;
      s.phase = 'roll';
      s.turnNo++;
      s.dice = null;
      break;
    }

    default:
      fail('Unknown action.');
  }
}

export function applyAction(prev, action) {
  const s = structuredClone(prev);
  try {
    handle(s, action);
    if (s.phase !== 'setup' && s.phase !== 'ended') {
      const need = s.config.rules.vpToWin;
      if (totalVP(s, s.turn) >= need) {
        s.phase = 'ended';
        s.winner = s.turn;
        log(s, s.turn, `🏆 ${s.players[s.turn].name} wins with ${totalVP(s, s.turn)} victory points!`);
      }
    }
    s.rev = (s.rev || 0) + 1;
    return { ok: true, state: s };
  } catch (e) {
    if (e instanceof GameError) return { ok: false, error: e.message };
    throw e;
  }
}
