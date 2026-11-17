// SVG board renderer. Pure view: takes a game state and an optional "pick"
// descriptor ({ kind: 'vertex'|'edge'|'hex', ids, onPick }) for clickable spots.

import { geoOf, PIPS, PLAYER_COLORS, RES_ICON } from '../engine/game.js';
import { edgeMid } from '../engine/geometry.js';

const S = 54; // px per hex radius
const NS = 'http://www.w3.org/2000/svg';

const TERRAIN = {
  forest: { fill: '#2f7d3b', icon: '🌲' },
  hills: { fill: '#c4572f', icon: '🧱' },
  pasture: { fill: '#8fcf5a', icon: '🐑' },
  fields: { fill: '#e8c547', icon: '🌾' },
  mountains: { fill: '#8a8f9c', icon: '⛰️' },
  desert: { fill: '#e3d3a0', icon: '🏜️' },
};

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

const pts = (arr) => arr.map((p) => `${(p.x * S).toFixed(1)},${(p.y * S).toFixed(1)}`).join(' ');

export function renderBoard(svg, s, pick, lastPlaced) {
  const geo = geoOf(s);
  const b = geo.bounds;
  const pad = 1.9;
  const x0 = b.minX - pad, y0 = b.minY - pad;
  const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
  svg.setAttribute('viewBox', `${x0 * S} ${y0 * S} ${w * S} ${h * S}`);
  svg.replaceChildren();

  const defs = el('defs', {}, svg);
  const glow = el('filter', { id: 'shadow', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
  el('feDropShadow', { dx: 0, dy: 1.5, stdDeviation: 1.6, 'flood-opacity': 0.45 }, glow);

  const gSea = el('g', {}, svg);
  const gHex = el('g', {}, svg);
  const gPort = el('g', {}, svg);
  const gRoad = el('g', {}, svg);
  const gBuild = el('g', {}, svg);
  const gTok = el('g', {}, svg);
  const gRob = el('g', {}, svg);
  const gPick = el('g', {}, svg);

  // Sea backdrop: every land hex inflated, drawn as pale water.
  geo.hexes.forEach((hx) => {
    const ring = hx.vertices.map((v) => {
      const vv = geo.vertices[v];
      return { x: hx.x + (vv.x - hx.x) * 1.55, y: hx.y + (vv.y - hx.y) * 1.55 };
    });
    el('polygon', { points: pts(ring), class: 'sea' }, gSea);
  });

  // Land hexes
  geo.hexes.forEach((hx, i) => {
    const hd = s.board.hexes[i];
    const t = TERRAIN[hd.terrain];
    const poly = el('polygon', {
      points: pts(hx.vertices.map((v) => geo.vertices[v])),
      fill: t.fill,
      class: 'hex',
    }, gHex);
    poly.dataset.hex = i;
    const ic = el('text', { x: hx.x * S, y: hx.y * S - 17, 'text-anchor': 'middle', class: 'hex-icon' }, gHex);
    ic.textContent = t.icon;
  });

  // Harbors
  for (const hb of s.board.harbors) {
    const e = geo.edges[hb.edge];
    const hx = geo.hexes[e.hexes[0]];
    const m = edgeMid(geo, e);
    const dx = m.x - hx.x, dy = m.y - hx.y;
    const len = Math.hypot(dx, dy);
    const px = m.x + (dx / len) * 0.78, py = m.y + (dy / len) * 0.78;
    for (const v of [e.a, e.b]) {
      el('line', { x1: px * S, y1: py * S, x2: geo.vertices[v].x * S, y2: geo.vertices[v].y * S, class: 'pier' }, gPort);
    }
    el('circle', { cx: px * S, cy: py * S, r: 15, class: 'port' }, gPort);
    const label = el('text', { x: px * S, y: py * S - 1, 'text-anchor': 'middle', class: 'port-ratio' }, gPort);
    const any = hb.type === 'any';
    label.textContent = any ? `${s.config.rules.portAnyRatio}:1` : `${s.config.rules.portResRatio}:1`;
    const sub = el('text', { x: px * S, y: py * S + 10, 'text-anchor': 'middle', class: 'port-res' }, gPort);
    sub.textContent = any ? '❓' : RES_ICON[hb.type];
  }

  // Roads
  for (const [eid, p] of Object.entries(s.roads)) {
    const e = geo.edges[eid];
    const a = geo.vertices[e.a], bb = geo.vertices[e.b];
    const attrs = { x1: a.x * S, y1: a.y * S, x2: bb.x * S, y2: bb.y * S };
    el('line', { ...attrs, class: 'road-edge' }, gRoad);
    el('line', { ...attrs, stroke: PLAYER_COLORS[s.players[p].color], class: 'road' }, gRoad);
  }

  // Buildings
  for (const [vid, bd] of Object.entries(s.buildings)) {
    const v = geo.vertices[vid];
    const col = PLAYER_COLORS[s.players[bd.p].color];
    const g = el('g', { transform: `translate(${v.x * S},${v.y * S})`, filter: 'url(#shadow)' }, gBuild);
    if (lastPlaced === +vid) g.classList.add('pop');
    if (bd.type === 'settlement') {
      el('path', { d: 'M-9,8 L-9,-3 L0,-11 L9,-3 L9,8 Z', fill: col, class: 'bld' }, g);
    } else {
      el('path', { d: 'M-13,9 L-13,-2 L-4,-2 L-4,-9 L2,-14 L8,-9 L8,-2 L13,-2 L13,9 Z', fill: col, class: 'bld' }, g);
    }
  }

  // Number tokens
  geo.hexes.forEach((hx, i) => {
    const n = s.board.hexes[i].number;
    if (!n) return;
    const g = el('g', { transform: `translate(${hx.x * S},${hx.y * S + 10})` }, gTok);
    el('circle', { r: 15, class: 'token' }, g);
    const hot = n === 6 || n === 8;
    const t = el('text', { y: 4, 'text-anchor': 'middle', class: 'token-num' + (hot ? ' hot' : '') }, g);
    t.textContent = n;
    const dots = PIPS[n];
    for (let d = 0; d < dots; d++) {
      el('circle', { cx: (d - (dots - 1) / 2) * 3.6, cy: 10.5, r: 1.2, class: 'pip' + (hot ? ' hot' : '') }, g);
    }
  });

  // Robber
  if (s.board.robber >= 0) {
    const hx = geo.hexes[s.board.robber];
    const g = el('g', { transform: `translate(${hx.x * S + 17},${hx.y * S + 12})`, class: 'robber' }, gRob);
    el('ellipse', { cx: 0, cy: 14, rx: 9, ry: 3, fill: 'rgba(0,0,0,.25)' }, g);
    el('path', { d: 'M-8,13 Q-8,-2 0,-4 Q8,-2 8,13 Z', fill: '#1b1b22' }, g);
    el('circle', { cx: 0, cy: -9, r: 6, fill: '#1b1b22' }, g);
  }

  // Pick targets
  if (pick && pick.ids.length) {
    const call = (id) => (ev) => { ev.stopPropagation(); pick.onPick(id); };
    if (pick.kind === 'vertex') {
      for (const id of pick.ids) {
        const v = geo.vertices[id];
        const c = el('circle', { cx: v.x * S, cy: v.y * S, r: 11, class: 'target' }, gPick);
        c.addEventListener('click', call(id));
      }
    } else if (pick.kind === 'edge') {
      for (const id of pick.ids) {
        const e = geo.edges[id];
        const a = geo.vertices[e.a], bb = geo.vertices[e.b];
        const l = el('line', { x1: a.x * S, y1: a.y * S, x2: bb.x * S, y2: bb.y * S, class: 'target-edge' }, gPick);
        l.addEventListener('click', call(id));
      }
    } else if (pick.kind === 'hex') {
      for (const id of pick.ids) {
        const hx = geo.hexes[id];
        const p = el('polygon', { points: pts(hx.vertices.map((v) => geo.vertices[v])), class: 'target-hex' }, gPick);
        p.addEventListener('click', call(id));
      }
    }
  }
}
