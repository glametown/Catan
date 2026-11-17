// Firebase layer: Google sign-in + lobby / game-state sync through Firestore.
//
//   lobbies/{id}                 lobby metadata + player list (see firestore.rules)
//   lobbies/{id}/state/current   { json, rev, err }  authoritative state, written by the host
//   lobbies/{id}/actions/{auto}  { uid, action, ts } requests from players, consumed by the host

import { firebaseConfig, ONLINE_ENABLED } from '../config.js';
import { createGame } from '../engine/game.js';
import { MAPS } from '../engine/maps.js';

const V = '10.14.1';
const CDN = `https://www.gstatic.com/firebasejs/${V}`;

let fb = null;

async function load() {
  if (!ONLINE_ENABLED) throw new Error('Online play is not configured yet (see README).');
  if (fb) return fb;
  const [app, auth, store] = await Promise.all([
    import(`${CDN}/firebase-app.js`),
    import(`${CDN}/firebase-auth.js`),
    import(`${CDN}/firebase-firestore.js`),
  ]);
  const a = app.initializeApp(firebaseConfig);
  fb = { auth: auth.getAuth(a), db: store.getFirestore(a), A: auth, S: store };
  return fb;
}

const toUser = (u) => (u ? { uid: u.uid, name: (u.displayName || 'Player').split(' ')[0].slice(0, 16), photo: u.photoURL || null } : null);

export async function onUser(cb) {
  const { auth, A } = await load();
  return A.onAuthStateChanged(auth, (u) => cb(toUser(u)));
}
export async function signIn() {
  const { auth, A } = await load();
  await A.signInWithPopup(auth, new A.GoogleAuthProvider());
}
export async function signOutUser() {
  const { auth, A } = await load();
  await A.signOut(auth);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export async function createLobby(user, cfg) {
  const { db, S } = await load();
  const map = MAPS[cfg.mapId];
  const ref = await S.addDoc(S.collection(db, 'lobbies'), {
    name: cfg.name.slice(0, 32) || `${user.name}'s game`,
    hostUid: user.uid,
    code: makeCode(),
    isPrivate: !!cfg.isPrivate,
    mapId: cfg.mapId,
    modeId: cfg.modeId,
    overrides: cfg.overrides || {},
    maxPlayers: Math.min(map.max, cfg.maxPlayers || map.max),
    status: 'waiting',
    players: [{ uid: user.uid, name: user.name, photo: user.photo, bot: false }],
    createdAt: Date.now(),
  });
  return ref.id;
}

export async function watchOpenLobbies(cb, onErr) {
  const { db, S } = await load();
  const q = S.query(S.collection(db, 'lobbies'), S.where('status', '==', 'waiting'), S.where('isPrivate', '==', false), S.limit(40));
  return S.onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => b.createdAt - a.createdAt);
    cb(list);
  }, onErr);
}

export async function findByCode(code) {
  const { db, S } = await load();
  const snap = await S.getDocs(S.query(S.collection(db, 'lobbies'), S.where('code', '==', code.trim().toUpperCase()), S.limit(1)));
  return snap.empty ? null : snap.docs[0].id;
}

export async function watchLobby(id, cb, onErr) {
  const { db, S } = await load();
  return S.onSnapshot(S.doc(db, 'lobbies', id), (d) => cb(d.exists() ? { id: d.id, ...d.data() } : null), onErr);
}

async function mutate(id, fn) {
  const { db, S } = await load();
  const ref = S.doc(db, 'lobbies', id);
  return S.runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('That lobby no longer exists.');
    const lobby = snap.data();
    const patch = fn(lobby);
    if (patch === 'delete') tx.delete(ref);
    else if (patch) tx.update(ref, patch);
  });
}

export function joinLobby(id, user) {
  return mutate(id, (l) => {
    if (l.players.some((p) => p.uid === user.uid)) return null;
    if (l.status !== 'waiting') throw new Error('That game has already started.');
    if (l.players.length >= l.maxPlayers) throw new Error('That lobby is full.');
    return { players: [...l.players, { uid: user.uid, name: user.name, photo: user.photo, bot: false }] };
  });
}

export function leaveLobby(id, uid) {
  return mutate(id, (l) => {
    if (l.status !== 'waiting') return null;
    if (l.hostUid === uid) return 'delete';
    return { players: l.players.filter((p) => p.uid !== uid) };
  });
}

export function updateLobby(id, patch) {
  return mutate(id, (l) => {
    const out = { ...patch };
    const map = MAPS[out.mapId || l.mapId];
    out.maxPlayers = Math.min(map.max, out.maxPlayers || l.maxPlayers);
    const humans = l.players.filter((p) => !p.bot);
    let players = l.players;
    if (players.length > out.maxPlayers) players = [...humans, ...players.filter((p) => p.bot)].slice(0, out.maxPlayers);
    out.players = players;
    return out;
  });
}

export function addBot(id) {
  return mutate(id, (l) => {
    if (l.players.length >= l.maxPlayers) throw new Error('Lobby is full.');
    const n = l.players.filter((p) => p.bot).length + 1;
    return { players: [...l.players, { uid: 'bot-' + n + '-' + Math.random().toString(36).slice(2, 6), name: ['Ada', 'Bram', 'Cleo', 'Dax', 'Esme', 'Finn'][(n - 1) % 6], photo: null, bot: true }] };
  });
}

export function removePlayer(id, uid) {
  return mutate(id, (l) => ({ players: l.players.filter((p) => p.uid !== uid) }));
}

export async function startGame(lobby) {
  const { db, S } = await load();
  const map = MAPS[lobby.mapId];
  const n = lobby.players.length;
  if (n < map.min) throw new Error(`${map.name} needs at least ${map.min} players (add bots if you like).`);
  if (n > map.max) throw new Error(`${map.name} supports at most ${map.max} players.`);
  const state = createGame({ players: lobby.players, mapId: lobby.mapId, modeId: lobby.modeId, overrides: lobby.overrides });
  await S.setDoc(S.doc(db, 'lobbies', lobby.id, 'state', 'current'), { json: JSON.stringify(state), rev: state.rev, err: null });
  await S.updateDoc(S.doc(db, 'lobbies', lobby.id), { status: 'playing', startedAt: Date.now() });
  return state;
}

export async function readState(id) {
  const { db, S } = await load();
  const d = await S.getDoc(S.doc(db, 'lobbies', id, 'state', 'current'));
  return d.exists() ? JSON.parse(d.data().json) : null;
}

export async function watchState(id, cb, onErr) {
  const { db, S } = await load();
  return S.onSnapshot(S.doc(db, 'lobbies', id, 'state', 'current'), (d) => {
    if (!d.exists()) return;
    const data = d.data();
    cb(JSON.parse(data.json), data.err || null);
  }, onErr);
}

let errN = 0;
export async function writeState(id, state, err = undefined) {
  const { db, S } = await load();
  const body = { json: JSON.stringify(state), rev: state.rev };
  if (err !== undefined) body.err = err ? { ...err, n: ++errN, t: Date.now() } : null;
  await S.setDoc(S.doc(db, 'lobbies', id, 'state', 'current'), body, { merge: true });
}

export async function finishLobby(id) {
  const { db, S } = await load();
  await S.updateDoc(S.doc(db, 'lobbies', id), { status: 'finished' }).catch(() => {});
}

export async function sendAction(id, uid, action) {
  const { db, S } = await load();
  await S.addDoc(S.collection(db, 'lobbies', id, 'actions'), { uid, action: JSON.stringify(action), ts: Date.now() });
}

// Host only: stream player requests; each is deleted once handled.
export async function watchActions(id, handler) {
  const { db, S } = await load();
  const q = S.query(S.collection(db, 'lobbies', id, 'actions'), S.orderBy('ts'));
  return S.onSnapshot(q, (snap) => {
    for (const ch of snap.docChanges()) {
      if (ch.type !== 'added') continue;
      const d = ch.doc.data();
      let action = null;
      try { action = JSON.parse(d.action); } catch { /* ignore */ }
      handler(d.uid, action);
      S.deleteDoc(ch.doc.ref).catch(() => {});
    }
  });
}
