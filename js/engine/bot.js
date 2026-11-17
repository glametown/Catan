// A simple heuristic bot. It never cheats: it only picks actions that the rules
// engine would accept, one at a time (the host calls chooseAction repeatedly).

import {
  RES, COSTS, PIPS, TERRAIN_RES, geoOf, total, canPay, settlementSpots, citySpots,
  roadSpots, robberVictims, tradeRatio, publicVP,
} from './game.js';

export const BOT_NAMES = ['Ada', 'Bram', 'Cleo', 'Dax', 'Esme', 'Finn'];

// Which bot (if any) needs to act right now?
export function pendingBot(s) {
  if (s.phase === 'ended') return null;
  if (s.phase === 'discard') {
    for (const k of Object.keys(s.discard.need)) if (s.players[+k].bot) return +k;
    return null;
  }
  if (s.trade && s.phase === 'main') {
    for (let i = 0; i < s.players.length; i++) {
      if (i === s.trade.from || !s.players[i].bot) continue;
      if (!s.trade.accepted.includes(i) && !s.trade.declined.includes(i)) return i;
    }
  }
  return s.players[s.turn].bot ? s.turn : null;
}

export function chooseAction(s, p) {
  if (s.phase === 'discard') return botDiscard(s, p);
  if (s.trade && s.phase === 'main' && s.trade.from !== p && !s.trade.accepted.includes(p) && !s.trade.declined.includes(p)) {
    return botTradeReply(s, p);
  }
  switch (s.phase) {
    case 'setup': return botSetup(s, p);
    case 'roll': return { type: 'roll', p };
    case 'robber': return botRobber(s, p);
    case 'main': return botMain(s, p);
    default: return null;
  }
}

// -------------------------------------------------------------- evaluation

function ownedTypes(s, geo, p) {
  const set = new Set();
  for (const [v, b] of Object.entries(s.buildings)) {
    if (b.p !== p) continue;
    for (const hi of geo.vertices[v].hexes) {
      const r = TERRAIN_RES[s.board.hexes[hi].terrain];
      if (r) set.add(r);
    }
  }
  return set;
}

function vertexScore(s, geo, vid, owned) {
  let score = 0;
  const types = new Set();
  for (const hi of geo.vertices[vid].hexes) {
    const h = s.board.hexes[hi];
    const r = TERRAIN_RES[h.terrain];
    if (!r) continue;
    score += PIPS[h.number] || 0;
    types.add(r);
  }
  score += types.size * 1.5;
  for (const t of types) if (!owned.has(t)) score += 1.5;
  for (const h of s.board.harbors) {
    const e = geo.edges[h.edge];
    if (e.a === vid || e.b === vid) { score += 1; break; }
  }
  return score;
}

const bestOf = (list, scoreFn) => {
  let best = list[0];
  let bs = -Infinity;
  for (const x of list) {
    const sc = scoreFn(x) + Math.random() * 0.01;
    if (sc > bs) { bs = sc; best = x; }
  }
  return best;
};

function botSetup(s, p) {
  const geo = geoOf(s);
  if (s.setup.expect === 'settlement') {
    const owned = ownedTypes(s, geo, p);
    const spots = settlementSpots(s, p, true);
    return { type: 'buildSettlement', p, vertex: bestOf(spots, (v) => vertexScore(s, geo, v, owned)) };
  }
  const edges = roadSpots(s, p);
  const owned = ownedTypes(s, geo, p);
  const last = s.setup.last;
  const edge = bestOf(edges, (e) => {
    const ed = geo.edges[e];
    const far = ed.a === last ? ed.b : ed.a;
    const free = !s.buildings[far] && geo.vertices[far].adj.every((x) => !s.buildings[x]);
    return free ? vertexScore(s, geo, far, owned) : 0;
  });
  return { type: 'buildRoad', p, edge };
}

function botDiscard(s, p) {
  const me = s.players[p];
  let need = s.discard.need[p];
  const cards = {};
  const have = { ...me.res };
  while (need > 0) {
    const k = RES.slice().sort((a, b) => have[b] - have[a])[0];
    have[k]--;
    cards[k] = (cards[k] || 0) + 1;
    need--;
  }
  return { type: 'discard', p, cards };
}

function botRobber(s, p) {
  const geo = geoOf(s);
  const hexes = geo.hexes.map((h) => h.id).filter((i) => i !== s.board.robber);
  const hex = bestOf(hexes, (hi) => {
    const hx = s.board.hexes[hi];
    const w = PIPS[hx.number] || 0;
    let sc = 0;
    for (const v of geo.hexes[hi].vertices) {
      const b = s.buildings[v];
      if (!b) continue;
      const m = b.type === 'city' ? 2 : 1;
      if (b.p === p) sc -= 3 * w * m;
      else sc += w * m * (1 + publicVP(s, b.p) / 10);
    }
    return sc;
  });
  const vics = robberVictims(s, hex, p);
  const victim = vics.length ? bestOf(vics, (i) => total(s.players[i].res)) : null;
  return { type: 'moveRobber', p, hex, victim };
}

function botTradeReply(s, p) {
  const t = s.trade;
  const me = s.players[p];
  const gain = total(t.give);
  const cost = total(t.get);
  const ok = canPay(me.res, t.get) && gain > cost;
  return { type: ok ? 'acceptTrade' : 'declineTrade', p };
}

// -------------------------------------------------------------------- main

function inNetwork(s, geo, p, v) {
  const b = s.buildings[v];
  if (b && b.p === p) return true;
  return geo.vertices[v].edges.some((e) => s.roads[e] === p);
}

function bestRoad(s, geo, p) {
  const edges = roadSpots(s, p);
  if (!edges.length) return null;
  const V = geo.vertices.length;
  const dist = new Array(V).fill(Infinity);
  const queue = [];
  for (const v of geo.vertices) {
    if (!s.buildings[v.id] && v.adj.every((a) => !s.buildings[a])) { dist[v.id] = 0; queue.push(v.id); }
  }
  for (let h = 0; h < queue.length; h++) {
    const v = queue[h];
    for (const a of geo.vertices[v].adj) {
      if (dist[a] > dist[v] + 1) { dist[a] = dist[v] + 1; queue.push(a); }
    }
  }
  return bestOf(edges, (e) => {
    const ed = geo.edges[e];
    const a = inNetwork(s, geo, p, ed.a);
    const b = inNetwork(s, geo, p, ed.b);
    let far = ed.a;
    if (a && !b) far = ed.b;
    else if (b && !a) far = ed.a;
    else far = dist[ed.a] < dist[ed.b] ? ed.a : ed.b;
    return -dist[far] * 10 - (a && b ? 5 : 0);
  });
}

function missingFor(me, cost) {
  return RES.filter((r) => (cost[r] || 0) > me.res[r]);
}

function botBankTrade(s, p) {
  const me = s.players[p];
  const goals = [];
  if (me.left.city > 0 && citySpots(s, p).length) goals.push(COSTS.city);
  if (me.left.settlement > 0 && settlementSpots(s, p).length) goals.push(COSTS.settlement);
  if (s.devDeck.length) goals.push(COSTS.dev);
  for (const goal of goals) {
    const missing = missingFor(me, goal);
    if (!missing.length) continue;
    for (const give of RES) {
      if (missing.includes(give)) continue;
      const spare = me.res[give] - (goal[give] || 0);
      const ratio = tradeRatio(s, p, give);
      if (spare >= ratio) return { type: 'bankTrade', p, give, get: missing[0] };
    }
  }
  return null;
}

function botMain(s, p) {
  const geo = geoOf(s);
  const me = s.players[p];
  const rules = s.config.rules;
  const act = (type, extra = {}) => ({ type, p, ...extra });

  if (s.freeRoads > 0) {
    const e = bestRoad(s, geo, p);
    if (e != null) return act('buildRoad', { edge: e });
  }

  if (!s.devPlayed) {
    if (me.dev.includes('knight')) {
      const onMine = s.board.robber >= 0 && geo.hexes[s.board.robber].vertices.some((v) => s.buildings[v] && s.buildings[v].p === p);
      if (onMine || !rules.robber || Math.random() < 0.35) return act('playKnight');
    }
    if (me.dev.includes('yearofplenty')) {
      const goal = me.left.city > 0 && citySpots(s, p).length ? COSTS.city : COSTS.settlement;
      const need = RES.filter((r) => (goal[r] || 0) > me.res[r]);
      return act('playYearOfPlenty', { a: need[0] || 'ore', b: need[1] || need[0] || 'wheat' });
    }
    if (me.dev.includes('monopoly')) {
      const r = bestOf(RES, (k) => -me.res[k]);
      return act('playMonopoly', { res: r });
    }
    if (me.dev.includes('roadbuilding') && me.left.road >= 2 && roadSpots(s, p).length) return act('playRoadBuilding');
  }

  if (me.left.city > 0 && canPay(me.res, COSTS.city)) {
    const spots = citySpots(s, p);
    if (spots.length) {
      const own = ownedTypes(s, geo, p);
      return act('buildCity', { vertex: bestOf(spots, (v) => vertexScore(s, geo, v, own)) });
    }
  }
  if (me.left.settlement > 0 && canPay(me.res, COSTS.settlement)) {
    const spots = settlementSpots(s, p);
    if (spots.length) {
      const own = ownedTypes(s, geo, p);
      return act('buildSettlement', { vertex: bestOf(spots, (v) => vertexScore(s, geo, v, own)) });
    }
  }
  if (s.devDeck.length && canPay(me.res, COSTS.dev)) return act('buyDev');
  if (me.left.road > 0 && canPay(me.res, COSTS.road) && me.left.settlement > 0 && !settlementSpots(s, p).length) {
    const e = bestRoad(s, geo, p);
    if (e != null) return act('buildRoad', { edge: e });
  }
  const trade = botBankTrade(s, p);
  if (trade) return trade;
  return act('endTurn');
}
