// UI controller: home → setup → (lobby) → game. Plain DOM + template strings.

import { ONLINE_ENABLED } from '../config.js';
import {
  createGame, RES, RES_ICON, COSTS, PLAYER_COLORS, DEV_NAMES, zero, total, canPay,
  settlementSpots, citySpots, roadSpots, robberVictims, tradeRatio, publicVP, totalVP, geoOf,
} from '../engine/game.js';
import { MAPS } from '../engine/maps.js';
import { MODES, resolveRules } from '../engine/modes.js';
import { BOT_NAMES } from '../engine/bot.js';
import { getGeometry } from '../engine/geometry.js';
import { makeRng } from '../engine/rng.js';
import { GameHost } from '../net/host.js';
import { renderBoard } from './board.js';
import * as online from '../net/online.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const app = {
  user: null, authReady: !ONLINE_ENABLED, screen: 'home', offline: false,
  cfg: defaultCfg(), lobbyId: null, lobby: null, lobbies: [], lobbiesErr: null, joinCode: '',
  unsubs: [], browseUnsub: null, host: null, isHost: false, state: null, me: -1, ui: {}, lastErr: 0, started: false,
};

function defaultCfg() {
  return { name: '', mapId: 'classic', modeId: 'classic', overrides: {}, players: 4, isPrivate: false };
}

// ------------------------------------------------------------------ helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 3200);
}

function avatar(p, size = 28) {
  const col = PLAYER_COLORS[p.color ?? 0];
  if (p.photo) return `<img class="avatar" width="${size}" height="${size}" referrerpolicy="no-referrer" src="${esc(p.photo)}" alt="">`;
  const ch = p.bot ? '🤖' : esc((p.name || '?')[0].toUpperCase());
  return `<span class="avatar ph" style="width:${size}px;height:${size}px;background:${col}">${ch}</span>`;
}

function miniMap(mapId) {
  const def = MAPS[mapId];
  const coords = def.coords(makeRng(11), 3);
  const g = getGeometry(coords);
  const b = g.bounds;
  const polys = g.hexes.map((hx) => `<polygon points="${hx.vertices.map((v) => `${g.vertices[v].x.toFixed(2)},${g.vertices[v].y.toFixed(2)}`).join(' ')}"/>`).join('');
  return `<svg class="mini" viewBox="${b.minX - 0.2} ${b.minY - 0.2} ${b.maxX - b.minX + 0.4} ${b.maxY - b.minY + 0.4}">${polys}</svg>`;
}

function indexOfMe(s) {
  const uid = app.offline ? 'me' : app.user?.uid;
  return s.players.findIndex((p) => p.uid === uid && !p.bot);
}

function teardown() {
  for (const u of app.unsubs) { try { u(); } catch { /* noop */ } }
  app.unsubs = [];
  if (app.host) app.host.stop();
  Object.assign(app, { host: null, isHost: false, state: null, me: -1, ui: {}, lobby: null, lobbyId: null, started: false, lastErr: 0 });
}

// -------------------------------------------------------------- navigation

function goHome() {
  teardown();
  app.screen = 'home';
  app.offline = false;
  startBrowse();
  render();
}

function startBrowse() {
  if (app.browseUnsub) { app.browseUnsub(); app.browseUnsub = null; }
  if (!ONLINE_ENABLED || !app.user) return;
  online.watchOpenLobbies(
    (list) => { app.lobbies = list; app.lobbiesErr = null; if (app.screen === 'home') render(); },
    (e) => { app.lobbiesErr = e.message; if (app.screen === 'home') render(); },
  ).then((u) => { app.browseUnsub = u; }).catch((e) => { app.lobbiesErr = e.message; });
}

async function enterLobby(id) {
  if (app.browseUnsub) { app.browseUnsub(); app.browseUnsub = null; }
  teardown();
  app.lobbyId = id;
  app.screen = 'lobby';
  try { localStorage.setItem('catan:lastLobby', id); } catch { /* noop */ }
  render();
  app.unsubs.push(await online.watchLobby(id, onLobby, (e) => toast(e.message)));
}

async function onLobby(l) {
  if (!l) {
    toast('That lobby was closed.');
    try { localStorage.removeItem('catan:lastLobby'); } catch { /* noop */ }
    goHome();
    return;
  }
  app.lobby = l;
  if (l.status !== 'waiting' && !app.started && l.players.some((p) => p.uid === app.user.uid)) {
    app.started = true;
    await beginOnlineGame(l);
    return;
  }
  if (app.screen === 'lobby') render();
}

async function beginOnlineGame(l) {
  app.screen = 'game';
  app.ui = {};
  app.isHost = l.hostUid === app.user.uid;
  try {
    if (app.isHost) {
      const st = await online.readState(l.id);
      if (!st) throw new Error('Game state not found.');
      app.host = new GameHost(st, {
        onState: (s) => {
          app.state = s;
          app.me = indexOfMe(s);
          render();
          online.writeState(l.id, s).catch((e) => toast('Sync error: ' + e.message));
          if (s.phase === 'ended') online.finishLobby(l.id);
        },
        onReject: (uid, msg) => online.writeState(l.id, app.host.state, { uid, msg }).catch(() => {}),
      });
      app.unsubs.push(await online.watchActions(l.id, (uid, act) => app.host && app.host.submitFrom(uid, act)));
    } else {
      app.unsubs.push(await online.watchState(l.id, (s, err) => {
        app.state = s;
        app.me = indexOfMe(s);
        if (err && err.uid === app.user.uid && err.n !== app.lastErr) { app.lastErr = err.n; toast(err.msg); }
        render();
      }, (e) => toast(e.message)));
    }
  } catch (e) {
    toast(e.message);
    goHome();
  }
}

function startOffline() {
  const cfg = app.cfg;
  const map = MAPS[cfg.mapId];
  const n = clamp(cfg.players, map.min, map.max);
  const players = [{ uid: 'me', name: app.user?.name || 'You', photo: app.user?.photo || null }];
  for (let i = 0; i < n - 1; i++) players.push({ uid: 'bot-' + i, name: BOT_NAMES[i], bot: true });
  teardown();
  app.offline = true;
  app.screen = 'game';
  app.isHost = true;
  const st = createGame({ players, mapId: cfg.mapId, modeId: cfg.modeId, overrides: cfg.overrides });
  app.host = new GameHost(st, {
    onState: (s) => { app.state = s; app.me = indexOfMe(s); render(); },
  });
}

async function send(action) {
  if (app.me < 0) return;
  const act = { ...action, p: app.me };
  if (app.host) {
    const r = app.host.submit(act);
    if (!r.ok) toast(r.error);
  } else {
    try { await online.sendAction(app.lobbyId, app.user.uid, action); } catch (e) { toast(e.message); }
  }
}

// ------------------------------------------------------------------ render

function render() {
  const fn = { home: homeScreen, setup: setupScreen, lobby: lobbyScreen, game: gameScreen }[app.screen];
  const changed = render.last !== app.screen;
  render.last = app.screen;
  const scroll = window.scrollY;
  fn();
  if (app.screen === 'game') {
    const l = $app.querySelector('.log-list');
    if (l) l.scrollTop = l.scrollHeight;
  }
  window.scrollTo(0, changed ? 0 : scroll);
}

// -------------------------------------------------------------------- home

function homeScreen() {
  let online_html;
  if (!ONLINE_ENABLED) {
    online_html = `<div class="panel muted-panel">
      <h3>🌐 Online multiplayer</h3>
      <p>Google sign-in and online lobbies need a free Firebase project. Add its keys to <code>js/config.js</code> — the README walks through it in about five minutes.</p>
    </div>`;
  } else if (!app.authReady) {
    online_html = `<div class="panel"><p class="muted">Connecting…</p></div>`;
  } else if (!app.user) {
    online_html = `<div class="panel">
      <h3>🌐 Play online</h3>
      <p>Sign in with Google to create or join lobbies and play with friends anywhere.</p>
      <button class="btn google" data-act="signin"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.5-4.1 7-10.2 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg> Sign in with Google</button>
    </div>`;
  } else {
    let last = null;
    try { last = localStorage.getItem('catan:lastLobby'); } catch { /* noop */ }
    online_html = `<div class="panel">
      <div class="row between"><h3>🌐 Online lobbies</h3>
        <div class="row gap"><span class="chip">${avatar(app.user, 22)} ${esc(app.user.name)}</span><button class="btn small ghost" data-act="signout">Sign out</button></div></div>
      <div class="row gap wrap">
        <button class="btn primary" data-act="newLobby">＋ Create lobby</button>
        ${last ? `<button class="btn" data-act="rejoin" data-id="${esc(last)}">↩ Rejoin last game</button>` : ''}
        <form class="row gap" data-form="code"><input class="input code" maxlength="5" placeholder="CODE" value="${esc(app.joinCode)}" data-input="joinCode"><button class="btn">Join by code</button></form>
      </div>
      <h4>Open games</h4>
      ${app.lobbiesErr ? `<p class="error">${esc(app.lobbiesErr)}</p>` : ''}
      <div class="lobby-list">${app.lobbies.length ? app.lobbies.map((l) => `
        <div class="lobby-row">
          <div class="lobby-title"><b>${esc(l.name)}</b><span class="muted">${MAPS[l.mapId]?.icon || ''} ${esc(MAPS[l.mapId]?.name || l.mapId)} · ${MODES[l.modeId]?.icon || ''} ${esc(MODES[l.modeId]?.name || l.modeId)}</span></div>
          <div class="row gap">${l.players.slice(0, 6).map((p) => avatar(p, 24)).join('')}<span class="muted">${l.players.length}/${l.maxPlayers}</span>
          <button class="btn small primary" data-act="joinLobby" data-id="${esc(l.id)}" ${l.players.length >= l.maxPlayers ? 'disabled' : ''}>Join</button></div>
        </div>`).join('') : '<p class="muted">No open games right now — create one and invite a friend with its code!</p>'}</div>
    </div>`;
  }

  $app.innerHTML = `
    <div class="home">
      <header class="hero">
        <div class="logo">⬡</div>
        <h1>Isles &amp; Islands</h1>
        <p>A Catan-style game of trade, build and settle — 7 maps, 6 modes, online with friends or offline against bots.</p>
      </header>
      <div class="home-grid">
        <div class="panel">
          <h3>🤖 Play offline</h3>
          <p>Jump straight in against computer opponents. No account needed.</p>
          <button class="btn primary big" data-act="newOffline">Start a game</button>
        </div>
        ${online_html}
      </div>
      <footer class="muted">Settle ✦ Trade ✦ Build ✦ Win</footer>
    </div>`;
}

// ------------------------------------------------------------------- setup

function setupForm(cfg, { offline, readOnly }) {
  const map = MAPS[cfg.mapId];
  const rules = resolveRules(cfg.modeId, cfg.overrides);
  const dis = readOnly ? 'disabled' : '';
  const mapCards = Object.entries(MAPS).map(([id, m]) => `
    <button class="pick-card ${cfg.mapId === id ? 'sel' : ''}" data-act="pickMap" data-id="${id}" ${dis}>
      ${miniMap(id)}<b>${m.icon} ${esc(m.name)}</b><small>${m.min}–${m.max} players</small><small class="dim">${esc(m.desc)}</small>
    </button>`).join('');
  const modeCards = Object.entries(MODES).map(([id, m]) => `
    <button class="pick-card mode ${cfg.modeId === id ? 'sel' : ''}" data-act="pickMode" data-id="${id}" ${dis}>
      <b>${m.icon} ${esc(m.name)}</b><small class="dim">${esc(m.desc)}</small>
    </button>`).join('');
  const counts = [];
  for (let n = map.min; n <= map.max; n++) counts.push(n);
  const vps = [5, 6, 7, 8, 9, 10, 12, 15, 20];
  if (!vps.includes(rules.vpToWin)) vps.push(rules.vpToWin);
  vps.sort((a, b) => a - b);
  const players = clamp(cfg.players, map.min, map.max);
  return `
    <h4>Map</h4><div class="pick-grid">${mapCards}</div>
    <h4>Mode</h4><div class="pick-grid modes">${modeCards}</div>
    <h4>Options</h4>
    <div class="options">
      <label>${offline ? 'Players (you + bots)' : 'Max players'}
        <select data-input="players" ${dis}>${counts.map((n) => `<option value="${n}" ${n === players ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Victory points to win
        <select data-input="vp" ${dis}>${vps.map((n) => `<option value="${n}" ${n === rules.vpToWin ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" data-input="balanced" ${rules.balancedDice ? 'checked' : ''} ${dis}> Fair dice (shuffled 36-roll deck)</label>
      <label class="check"><input type="checkbox" data-input="norobber" ${!rules.robber ? 'checked' : ''} ${dis}> No robber</label>
      ${!offline && !readOnly ? `<label class="check"><input type="checkbox" data-input="private" ${cfg.isPrivate ? 'checked' : ''}> Private (join by code only)</label>` : ''}
    </div>`;
}

function setupScreen() {
  const online_ = !app.offline;
  $app.innerHTML = `
    <div class="page">
      <div class="row between"><button class="btn ghost" data-act="home">← Back</button><h2>${online_ ? 'Create a lobby' : 'New offline game'}</h2><span></span></div>
      ${online_ ? `<label class="field">Lobby name<input class="input" maxlength="32" placeholder="${esc(app.user?.name || 'My')}'s game" value="${esc(app.cfg.name)}" data-input="lobbyName"></label>` : ''}
      ${setupForm(app.cfg, { offline: !online_, readOnly: false })}
      <div class="row end"><button class="btn primary big" data-act="${online_ ? 'createLobby' : 'startOffline'}">${online_ ? 'Create lobby' : 'Start game'}</button></div>
    </div>`;
}

// ------------------------------------------------------------------- lobby

function lobbyScreen() {
  const l = app.lobby;
  if (!l) { $app.innerHTML = '<div class="page"><p class="muted">Loading lobby…</p></div>'; return; }
  const isHost = l.hostUid === app.user.uid;
  const map = MAPS[l.mapId];
  const cfg = { mapId: l.mapId, modeId: l.modeId, overrides: l.overrides || {}, players: l.maxPlayers, isPrivate: l.isPrivate };
  const slots = [];
  for (let i = 0; i < l.maxPlayers; i++) {
    const p = l.players[i];
    slots.push(p ? `<div class="slot">${avatar(p, 34)}<b>${esc(p.name)}</b>${p.uid === l.hostUid ? '<span class="chip">👑 host</span>' : ''}${p.bot ? '<span class="chip">bot</span>' : ''}
      ${isHost && p.uid !== l.hostUid ? `<button class="btn small ghost" data-act="kick" data-id="${esc(p.uid)}">✕</button>` : ''}</div>`
      : `<div class="slot empty">Waiting for player…</div>`);
  }
  const ready = l.players.length >= map.min && l.players.length <= map.max;
  $app.innerHTML = `
    <div class="page">
      <div class="row between"><button class="btn ghost" data-act="leaveLobby">← Leave</button><h2>${esc(l.name)}</h2><span></span></div>
      <div class="panel code-panel">
        <div><small class="muted">Invite code</small><div class="big-code">${esc(l.code)}</div></div>
        <button class="btn" data-act="copyCode" data-code="${esc(l.code)}">Copy</button>
        <div class="muted">${l.isPrivate ? '🔒 Private' : '🌍 Public'} · ${l.players.length}/${l.maxPlayers} players</div>
      </div>
      <h4>Players</h4>
      <div class="slots">${slots.join('')}</div>
      ${isHost ? `<div class="row gap"><button class="btn" data-act="addBot" ${l.players.length >= l.maxPlayers ? 'disabled' : ''}>🤖 Add bot</button></div>` : ''}
      ${setupForm(cfg, { offline: false, readOnly: !isHost })}
      <div class="row end">
        ${isHost
          ? `<button class="btn primary big" data-act="startOnline" ${ready ? '' : 'disabled'}>${ready ? 'Start game' : `Need ${map.min}+ players`}</button>`
          : '<span class="muted">Waiting for the host to start…</span>'}
      </div>
    </div>`;
}

// -------------------------------------------------------------------- game

function bannerText(s, me) {
  const cur = s.players[s.turn];
  const mine = s.turn === me;
  const who = mine ? 'Your' : `${esc(cur.name)}'s`;
  switch (s.phase) {
    case 'setup':
      if (mine) return s.setup.expect === 'settlement' ? '🏠 Place a settlement' : '🛣️ Place a road next to it';
      return `${esc(cur.name)} is placing ${s.setup.expect === 'settlement' ? 'a settlement' : 'a road'}…`;
    case 'roll': return mine ? '🎲 Your turn — roll the dice!' : `${who} turn — waiting for the roll…`;
    case 'discard': {
      const names = Object.keys(s.discard.need).map((i) => esc(s.players[+i].name));
      return s.discard.need[me] ? '🃏 You must discard cards' : `Waiting for ${names.join(', ')} to discard…`;
    }
    case 'robber': return mine ? '🥷 Move the robber — tap a hex' : `${esc(cur.name)} is moving the robber…`;
    case 'main':
      if (s.freeRoads > 0 && mine) return `🛣️ Place ${s.freeRoads} free road${s.freeRoads > 1 ? 's' : ''}`;
      return mine ? 'Your turn — build, trade, or end turn' : `${who} turn`;
    case 'ended': return `🏆 ${esc(s.players[s.winner].name)} wins!`;
    default: return '';
  }
}

function computePick(s, me) {
  if (me < 0 || s.turn !== me) return null;
  const ui = app.ui;
  if (s.phase === 'setup') {
    if (s.setup.expect === 'settlement') return { kind: 'vertex', ids: settlementSpots(s, me, true), onPick: (v) => send({ type: 'buildSettlement', vertex: v }) };
    return { kind: 'edge', ids: roadSpots(s, me), onPick: (e) => send({ type: 'buildRoad', edge: e }) };
  }
  if (s.phase === 'robber') {
    const ids = geoOf(s).hexes.map((h) => h.id).filter((i) => i !== s.board.robber);
    return {
      kind: 'hex', ids,
      onPick: (hex) => {
        const v = robberVictims(s, hex, me);
        if (v.length > 1) { app.ui.victim = { hex, victims: v }; render(); } else send({ type: 'moveRobber', hex, victim: v[0] });
      },
    };
  }
  if (s.phase !== 'main') return null;
  if (s.freeRoads > 0) return { kind: 'edge', ids: roadSpots(s, me), onPick: (e) => send({ type: 'buildRoad', edge: e }) };
  if (ui.build === 'road') return { kind: 'edge', ids: roadSpots(s, me), onPick: (e) => { app.ui.build = null; send({ type: 'buildRoad', edge: e }); } };
  if (ui.build === 'settlement') return { kind: 'vertex', ids: settlementSpots(s, me), onPick: (v) => { app.ui.build = null; send({ type: 'buildSettlement', vertex: v }); } };
  if (ui.build === 'city') return { kind: 'vertex', ids: citySpots(s, me), onPick: (v) => { app.ui.build = null; send({ type: 'buildCity', vertex: v }); } };
  return null;
}

const costText = (c) => RES.filter((r) => c[r]).map((r) => `${c[r]}${RES_ICON[r]}`).join(' ');
const diceFace = (n) => ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][n - 1];

function playerRow(s, i, me) {
  const p = s.players[i];
  const col = PLAYER_COLORS[p.color];
  const vp = i === me ? totalVP(s, i) : publicVP(s, i);
  const road = s.longestRoad.lens ? s.longestRoad.lens[i] : 0;
  const badges = [
    s.longestRoad.holder === i ? '<span class="badge" title="Longest Road">🛣️ +2</span>' : '',
    s.largestArmy.holder === i ? '<span class="badge" title="Largest Army">⚔️ +2</span>' : '',
  ].join('');
  const botBtn = app.isHost && !app.offline && !p.bot && i !== me
    ? `<button class="btn tiny ghost" data-act="botify" data-i="${i}" title="Let a bot take over this seat">🤖</button>` : '';
  return `<div class="prow ${s.turn === i && s.phase !== 'ended' ? 'active' : ''}" style="--pc:${col}">
    ${avatar(p, 30)}
    <div class="pinfo">
      <div class="pname">${esc(p.name)}${i === me ? ' <small>(you)</small>' : ''} ${badges} ${botBtn}</div>
      <div class="pstats">
        <span title="Victory points">⭐ <b>${vp}</b></span>
        <span title="Resource cards">🃏 ${total(p.res)}</span>
        <span title="Development cards">📜 ${p.dev.length + p.devNew.length}</span>
        <span title="Knights played">⚔️ ${p.knights}</span>
        <span title="Longest road">🛣️ ${road}</span>
      </div>
    </div>
  </div>`;
}

function gameScreen() {
  const s = app.state;
  if (!s) { $app.innerHTML = '<div class="page"><p class="muted">Loading game…</p></div>'; return; }
  const me = app.me;
  const mine = s.turn === me;
  const pl = me >= 0 ? s.players[me] : null;
  const map = MAPS[s.config.mapId];
  const mode = MODES[s.config.modeId];
  const rules = s.config.rules;

  const canBuild = mine && s.phase === 'main' && !s.freeRoads;
  const btn = (act, label, ok, cost, tip) =>
    `<button class="btn act ${app.ui.build === act ? 'on' : ''}" data-act="${act === 'dev' ? 'buyDev' : 'build'}" data-what="${act}" ${canBuild && ok ? '' : 'disabled'} title="${esc(tip)}">${label}<small>${cost}</small></button>`;

  const hand = pl ? RES.map((r) => `<div class="rcard r-${r}" title="${r}"><span>${RES_ICON[r]}</span><b>${pl.res[r]}</b></div>`).join('') : '';

  let devHtml = '';
  if (pl) {
    const count = (arr) => arr.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {});
    const have = count(pl.dev), fresh = count(pl.devNew);
    const kinds = Object.keys(DEV_NAMES);
    devHtml = kinds.filter((k) => have[k] || fresh[k]).map((k) => {
      const playable = k !== 'vp' && have[k] && mine && !s.devPlayed && !s.freeRoads && (k === 'knight' ? (s.phase === 'roll' || s.phase === 'main') : s.phase === 'main');
      const label = k === 'vp' ? `🏆 ${DEV_NAMES[k]}` : DEV_NAMES[k];
      return `<button class="dcard" data-act="playDev" data-kind="${k}" ${playable ? '' : 'disabled'}>${label} <b>×${(have[k] || 0) + (fresh[k] || 0)}</b>${fresh[k] ? `<small>${fresh[k]} new</small>` : ''}</button>`;
    }).join('') || '<span class="muted">No development cards</span>';
  }

  const pick = computePick(s, me);
  const dice = s.dice ? `<div class="dice"><span>${diceFace(s.dice[0])}</span><span>${diceFace(s.dice[1])}</span><b>${s.dice[0] + s.dice[1]}</b></div>` : '';

  $app.innerHTML = `
    <div class="game">
      <div class="topbar">
        <button class="btn small ghost" data-act="quit">☰ Leave</button>
        <div class="gtitle"><b>${map.icon} ${esc(map.name)}</b> · ${mode.icon} ${esc(mode.name)} · first to <b>${rules.vpToWin}</b> ⭐${app.lobby ? ` · code <b>${esc(app.lobby.code)}</b>` : ''}</div>
        <button class="btn small ghost" data-act="help">?</button>
      </div>
      <div class="banner ${mine && s.phase !== 'ended' ? 'mine' : ''}">${bannerText(s, me)}</div>
      <div class="board-wrap"><svg id="board" class="board"></svg></div>
      <aside class="side">
        <div class="players">${s.players.map((_, i) => playerRow(s, i, me)).join('')}</div>
        ${tradeCard(s, me)}
        <div class="log"><div class="log-list">${s.log.slice(-40).map((e) => `<div class="log-row">${e.p != null ? `<i style="background:${PLAYER_COLORS[s.players[e.p].color]}"></i>` : '<i class="sys"></i>'}${esc(e.text)}</div>`).join('')}</div></div>
      </aside>
      ${pl ? `<div class="dock">
        <div class="hand">${hand}</div>
        <div class="actions">
          ${mine && s.phase === 'roll' ? `<button class="btn primary big pulse" data-act="roll">🎲 Roll dice</button>` : dice}
          ${btn('road', '🛣️ Road', pl.left.road > 0 && canPay(pl.res, COSTS.road), costText(COSTS.road), 'Road')}
          ${btn('settlement', '🏠 Settlement', pl.left.settlement > 0 && canPay(pl.res, COSTS.settlement), costText(COSTS.settlement), 'Settlement (1 VP)')}
          ${btn('city', '🏙️ City', pl.left.city > 0 && canPay(pl.res, COSTS.city), costText(COSTS.city), 'City (2 VP)')}
          ${btn('dev', '📜 Dev card', s.devDeck.length > 0 && canPay(pl.res, COSTS.dev), costText(COSTS.dev), 'Development card')}
          <button class="btn act" data-act="openTrade" ${canBuild ? '' : 'disabled'}>🤝 Trade</button>
          <button class="btn act end" data-act="endTurn" ${canBuild ? '' : 'disabled'}>End turn ➜</button>
        </div>
        <div class="devs">${devHtml}</div>
      </div>` : '<div class="dock"><span class="muted">Spectating</span></div>'}
      ${modals(s, me)}
    </div>`;

  renderBoard(document.getElementById('board'), s, pick);
}

function tradeCard(s, me) {
  const t = s.trade;
  if (!t || s.phase !== 'main') return '';
  const from = s.players[t.from];
  const line = (b) => RES.filter((r) => b[r]).map((r) => `<span class="bundle-i">${b[r]} ${RES_ICON[r]}</span>`).join('');
  let body;
  if (t.from === me) {
    body = `<div class="muted">Waiting for answers…</div>
      ${s.players.map((p, i) => i === me ? '' : `<div class="row between tline"><span>${esc(p.name)}</span>${
        t.accepted.includes(i) ? `<button class="btn small primary" data-act="confirmTrade" data-with="${i}">✔ Trade</button>`
        : t.declined.includes(i) ? '<span class="muted">declined</span>' : '<span class="muted">…</span>'}</div>`).join('')}
      <button class="btn small ghost" data-act="cancelTrade">Cancel offer</button>`;
  } else if (me >= 0) {
    const ok = canPay(s.players[me].res, t.get);
    const mineAccepted = t.accepted.includes(me), mineDeclined = t.declined.includes(me);
    body = `<div class="row gap">
      <button class="btn small primary" data-act="acceptTrade" ${ok && !mineAccepted ? '' : 'disabled'}>${mineAccepted ? 'Accepted ✓' : 'Accept'}</button>
      <button class="btn small" data-act="declineTrade" ${mineDeclined ? 'disabled' : ''}>${mineDeclined ? 'Declined' : 'Decline'}</button></div>
      ${ok ? '' : '<div class="muted">You lack the cards for this.</div>'}`;
  } else body = '';
  return `<div class="tradecard"><b>${esc(from.name)} offers</b><div class="bundle">${line(t.give)}</div><b>for</b><div class="bundle">${line(t.get)}</div>${body}</div>`;
}

function stepper(kind, r, val) {
  return `<div class="step"><span>${RES_ICON[r]}</span>
    <button class="btn tiny" data-act="step" data-kind="${kind}" data-res="${r}" data-d="-1">−</button><b>${val}</b>
    <button class="btn tiny" data-act="step" data-kind="${kind}" data-res="${r}" data-d="1">＋</button></div>`;
}

function modal(title, body, close = true) {
  return `<div class="overlay"><div class="modal"><div class="row between"><h3>${title}</h3>${close ? '<button class="btn small ghost" data-act="closeModal">✕</button>' : ''}</div>${body}</div></div>`;
}

function modals(s, me) {
  const ui = app.ui;
  const pl = me >= 0 ? s.players[me] : null;

  if (s.phase === 'ended') {
    const rank = s.players.map((p, i) => ({ p, i, vp: totalVP(s, i) })).sort((a, b) => b.vp - a.vp);
    return modal(`🏆 ${esc(s.players[s.winner].name)} wins!`, `
      <div class="scoreboard">${rank.map((r, k) => `<div class="prow ${r.i === s.winner ? 'active' : ''}" style="--pc:${PLAYER_COLORS[r.p.color]}">${avatar(r.p, 30)}<b>${k + 1}. ${esc(r.p.name)}</b><span>⭐ ${r.vp}</span></div>`).join('')}</div>
      <div class="row end gap">${app.offline ? '<button class="btn" data-act="rematch">Play again</button>' : ''}<button class="btn primary" data-act="home">Back to menu</button></div>`, false);
  }

  if (s.phase === 'discard' && pl && s.discard.need[me]) {
    const need = s.discard.need[me];
    const d = ui.discard || zero();
    const n = total(d);
    return modal(`🃏 Discard ${need} cards`, `
      <p class="muted">A 7 was rolled and you hold more than ${s.config.rules.discardLimit} cards.</p>
      <div class="steps">${RES.map((r) => stepper('discard', r, d[r])).join('')}</div>
      <div class="row between"><span>Selected ${n}/${need}</span><button class="btn primary" data-act="doDiscard" ${n === need ? '' : 'disabled'}>Discard</button></div>`, false);
  }

  if (ui.victim) {
    return modal('Steal from…', `<div class="col gap">${ui.victim.victims.map((i) => `<button class="btn" data-act="pickVictim" data-v="${i}">${esc(s.players[i].name)} <small>(${total(s.players[i].res)} cards)</small></button>`).join('')}</div>`);
  }

  if (ui.modal === 'yop') {
    const sel = ui.yop || [];
    return modal('📜 Year of Plenty', `<p class="muted">Take any two resources from the bank.</p>
      <div class="row gap wrap">${RES.map((r) => `<button class="btn rbtn" data-act="yopPick" data-res="${r}">${RES_ICON[r]}</button>`).join('')}</div>
      <div class="row between"><span>Chosen: ${sel.map((r) => RES_ICON[r]).join(' ') || '—'}</span>
      <button class="btn primary" data-act="doYop" ${sel.length === 2 ? '' : 'disabled'}>Take</button></div>`);
  }

  if (ui.modal === 'monopoly') {
    return modal('📜 Monopoly', `<p class="muted">Every other player hands you all of one resource.</p>
      <div class="row gap wrap">${RES.map((r) => `<button class="btn rbtn" data-act="doMonopoly" data-res="${r}">${RES_ICON[r]}</button>`).join('')}</div>`);
  }

  if (ui.modal === 'help') {
    return modal('How to play', `<div class="help">
      <p><b>Goal:</b> be first to ${s.config.rules.vpToWin} ⭐ victory points. Settlements are 1⭐, cities 2⭐, Longest Road (5+ roads) and Largest Army (3+ knights) are 2⭐ each, and some development cards hide a ⭐.</p>
      <p><b>Turn:</b> roll the dice → hexes matching the roll pay out to adjacent settlements (cities pay double) → build, trade and play one development card → end turn.</p>
      <p><b>A 7</b> triggers the robber: players with over ${s.config.rules.discardLimit} cards discard half, then the roller moves the robber and steals a card.</p>
      <p><b>Costs:</b> 🛣️ ${costText(COSTS.road)} · 🏠 ${costText(COSTS.settlement)} · 🏙️ ${costText(COSTS.city)} · 📜 ${costText(COSTS.dev)}</p>
      <p><b>Trading:</b> with the bank at ${s.config.rules.bankRatio}:1, or better via harbors you settle next to. Offer swaps to other players too.</p>
      <p>Settlements must be at least two roads apart. A new development card can't be played the turn you buy it.</p></div>`);
  }

  if (ui.modal === 'trade' && pl) {
    const t = ui.trade;
    const tab = t.tab;
    const ratio = tradeRatio(s, me, t.bankGive);
    let body;
    if (tab === 'bank') {
      body = `<p class="muted">Give <b>${ratio}</b> ${RES_ICON[t.bankGive]} for 1 card of your choice.</p>
        <h4>You give</h4><div class="row gap wrap">${RES.map((r) => `<button class="btn rbtn ${t.bankGive === r ? 'sel' : ''}" data-act="bankGive" data-res="${r}">${RES_ICON[r]} <small>${pl.res[r]}</small><small class="rt">${tradeRatio(s, me, r)}:1</small></button>`).join('')}</div>
        <h4>You get</h4><div class="row gap wrap">${RES.filter((r) => r !== t.bankGive).map((r) => `<button class="btn rbtn ${t.bankGet === r ? 'sel' : ''}" data-act="bankGet" data-res="${r}">${RES_ICON[r]}</button>`).join('')}</div>
        <div class="row end"><button class="btn primary" data-act="doBank" ${pl.res[t.bankGive] >= ratio && t.bankGet && t.bankGet !== t.bankGive ? '' : 'disabled'}>Trade with bank</button></div>`;
    } else {
      const ok = total(t.give) && total(t.get) && canPay(pl.res, t.give) && !RES.some((r) => t.give[r] && t.get[r]);
      body = `<h4>You give</h4><div class="steps">${RES.map((r) => stepper('give', r, t.give[r])).join('')}</div>
        <h4>You want</h4><div class="steps">${RES.map((r) => stepper('get', r, t.get[r])).join('')}</div>
        <div class="row end"><button class="btn primary" data-act="doOffer" ${ok ? '' : 'disabled'}>Send offer</button></div>`;
    }
    return modal('🤝 Trade', `<div class="tabs"><button class="tab ${tab === 'bank' ? 'sel' : ''}" data-act="tradeTab" data-tab="bank">Bank / Harbor</button><button class="tab ${tab === 'players' ? 'sel' : ''}" data-act="tradeTab" data-tab="players">Players</button></div>${body}`);
  }
  return '';
}

// ---------------------------------------------------------------- handlers

const H = {
  async signin() { try { await online.signIn(); } catch (e) { toast(e.message); } },
  async signout() { await online.signOutUser(); },
  home() { goHome(); },
  newOffline() { app.offline = true; app.cfg = defaultCfg(); app.screen = 'setup'; render(); },
  newLobby() { app.offline = false; app.cfg = defaultCfg(); app.screen = 'setup'; render(); },

  pickMap(t) {
    const id = t.dataset.id;
    if (app.screen === 'lobby') return lobbyPatch({ mapId: id });
    app.cfg.mapId = id;
    const m = MAPS[id];
    app.cfg.players = clamp(app.cfg.players, m.min, m.max);
    render();
  },
  pickMode(t) {
    const id = t.dataset.id;
    if (app.screen === 'lobby') return lobbyPatch({ modeId: id, overrides: {} });
    app.cfg.modeId = id;
    app.cfg.overrides = {};
    render();
  },

  startOffline() { startOffline(); },
  async createLobby() {
    try {
      const id = await online.createLobby(app.user, { ...app.cfg, maxPlayers: app.cfg.players });
      await enterLobby(id);
    } catch (e) { toast(e.message); }
  },
  async joinLobby(t) {
    try { await online.joinLobby(t.dataset.id, app.user); await enterLobby(t.dataset.id); } catch (e) { toast(e.message); }
  },
  async rejoin(t) {
    try { await enterLobby(t.dataset.id); } catch (e) { toast(e.message); }
  },
  async leaveLobby() {
    const id = app.lobbyId;
    try { await online.leaveLobby(id, app.user.uid); } catch (e) { toast(e.message); }
    try { localStorage.removeItem('catan:lastLobby'); } catch { /* noop */ }
    goHome();
  },
  async kick(t) { try { await online.removePlayer(app.lobbyId, t.dataset.id); } catch (e) { toast(e.message); } },
  async addBot() { try { await online.addBot(app.lobbyId); } catch (e) { toast(e.message); } },
  async startOnline() { try { await online.startGame(app.lobby); } catch (e) { toast(e.message); } },
  copyCode(t) {
    navigator.clipboard?.writeText(t.dataset.code).then(() => toast('Code copied!'), () => toast('Code: ' + t.dataset.code));
  },

  quit() {
    if (app.state && app.state.phase !== 'ended' && !confirm(app.isHost && !app.offline ? 'You are the host. If you leave, the game pauses for everyone until you come back (use “Rejoin last game”). Leave anyway?' : 'Leave this game?')) return;
    if (app.offline) { goHome(); return; }
    if (!app.isHost) { try { localStorage.removeItem('catan:lastLobby'); } catch { /* noop */ } }
    goHome();
  },
  help() { app.ui.modal = 'help'; render(); },
  closeModal() { app.ui.modal = null; app.ui.victim = null; render(); },
  rematch() {
    const { mapId, modeId, rules } = app.state.config;
    app.cfg = { ...defaultCfg(), mapId, modeId, overrides: { vpToWin: rules.vpToWin, balancedDice: rules.balancedDice, robber: rules.robber }, players: app.state.players.length };
    startOffline();
  },

  roll() { send({ type: 'roll' }); },
  build(t) { app.ui.build = app.ui.build === t.dataset.what ? null : t.dataset.what; render(); },
  buyDev() { app.ui.build = null; send({ type: 'buyDev' }); },
  endTurn() { app.ui = {}; send({ type: 'endTurn' }); },
  botify(t) {
    if (confirm('Let a bot take over this seat?')) app.host.botify(+t.dataset.i);
  },

  playDev(t) {
    const k = t.dataset.kind;
    if (k === 'knight') send({ type: 'playKnight' });
    else if (k === 'roadbuilding') send({ type: 'playRoadBuilding' });
    else if (k === 'yearofplenty') { app.ui.modal = 'yop'; app.ui.yop = []; render(); }
    else if (k === 'monopoly') { app.ui.modal = 'monopoly'; render(); }
  },
  yopPick(t) {
    const arr = app.ui.yop || (app.ui.yop = []);
    if (arr.length < 2) arr.push(t.dataset.res);
    render();
  },
  doYop() { const [a, b] = app.ui.yop; app.ui.modal = null; send({ type: 'playYearOfPlenty', a, b }); },
  doMonopoly(t) { app.ui.modal = null; send({ type: 'playMonopoly', res: t.dataset.res }); },

  pickVictim(t) {
    const { hex } = app.ui.victim;
    app.ui.victim = null;
    send({ type: 'moveRobber', hex, victim: +t.dataset.v });
  },
  doDiscard() { const cards = app.ui.discard; app.ui.discard = null; send({ type: 'discard', cards }); },

  openTrade() { app.ui.modal = 'trade'; app.ui.trade = { tab: 'bank', bankGive: 'wood', bankGet: 'brick', give: zero(), get: zero() }; render(); },
  tradeTab(t) { app.ui.trade.tab = t.dataset.tab; render(); },
  bankGive(t) { app.ui.trade.bankGive = t.dataset.res; if (app.ui.trade.bankGet === t.dataset.res) app.ui.trade.bankGet = null; render(); },
  bankGet(t) { app.ui.trade.bankGet = t.dataset.res; render(); },
  doBank() { const { bankGive, bankGet } = app.ui.trade; send({ type: 'bankTrade', give: bankGive, get: bankGet }); app.ui.trade.bankGet = null; },
  doOffer() { const { give, get } = app.ui.trade; app.ui.modal = null; send({ type: 'offerTrade', give, get }); },
  step(t) {
    const kind = t.dataset.kind, r = t.dataset.res, d = +t.dataset.d;
    const bag = kind === 'discard' ? (app.ui.discard || (app.ui.discard = zero())) : app.ui.trade[kind];
    const max = kind === 'discard' ? app.state.players[app.me].res[r] : 19;
    bag[r] = clamp(bag[r] + d, 0, max);
    if (kind === 'give' && bag[r] > 0) app.ui.trade.get[r] = 0;
    if (kind === 'get' && bag[r] > 0) app.ui.trade.give[r] = 0;
    render();
  },
  acceptTrade() { send({ type: 'acceptTrade' }); },
  declineTrade() { send({ type: 'declineTrade' }); },
  confirmTrade(t) { send({ type: 'confirmTrade', with: +t.dataset.with }); },
  cancelTrade() { send({ type: 'cancelTrade' }); },
};

async function lobbyPatch(patch) {
  try { await online.updateLobby(app.lobbyId, patch); } catch (e) { toast(e.message); }
}

function setOverride(key, value) {
  if (app.screen === 'lobby') {
    const cur = { ...(app.lobby.overrides || {}), [key]: value };
    lobbyPatch({ overrides: cur });
  } else {
    app.cfg.overrides[key] = value;
    render();
  }
}

const I = {
  joinCode(el) { app.joinCode = el.value.toUpperCase(); el.value = app.joinCode; },
  lobbyName(el) { app.cfg.name = el.value; },
  players(el) {
    const n = +el.value;
    if (app.screen === 'lobby') lobbyPatch({ maxPlayers: n }); else { app.cfg.players = n; render(); }
  },
  vp(el) { setOverride('vpToWin', +el.value); },
  balanced(el) { setOverride('balancedDice', el.checked); },
  norobber(el) { setOverride('robber', !el.checked); },
  private(el) { app.cfg.isPrivate = el.checked; },
};

$app.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const fn = H[t.dataset.act];
  if (fn) fn(t, e);
});
$app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.type === 'text' && t.dataset.input) I[t.dataset.input]?.(t);
});
$app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.input && t.type !== 'text') I[t.dataset.input]?.(t);
});
$app.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.dataset.form !== 'code') return;
  try {
    const id = await online.findByCode(app.joinCode);
    if (!id) { toast('No lobby with that code.'); return; }
    await online.joinLobby(id, app.user);
    await enterLobby(id);
  } catch (err) { toast(err.message); }
});

// -------------------------------------------------------------------- boot

render();
if (ONLINE_ENABLED) {
  online.onUser((u) => {
    app.user = u;
    app.authReady = true;
    if (u && app.screen === 'home') startBrowse();
    if (!u && app.screen !== 'game') { app.screen = 'home'; }
    if (app.screen === 'home') render();
  }).catch((e) => { app.authReady = true; toast(e.message); render(); });
}
