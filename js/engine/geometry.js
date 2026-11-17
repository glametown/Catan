// Hex-grid geometry. Hexes are pointy-top, addressed with axial (q, r)
// coordinates. Vertices and edges are derived by merging shared corners, so
// any set of hex coordinates (any map shape) produces a valid board graph.

const SQ3 = Math.sqrt(3);
export const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

export function hexCenter(q, r) {
  return { x: SQ3 * (q + r / 2), y: 1.5 * r };
}

const k = (v) => Math.round(v * 1000);
const cache = new Map();

export function getGeometry(coords) {
  const key = coords.map((c) => c.join(',')).join(';');
  let g = cache.get(key);
  if (!g) {
    g = build(coords);
    if (cache.size > 24) cache.clear();
    cache.set(key, g);
  }
  return g;
}

function build(coords) {
  const vertices = [];
  const vmap = new Map();
  const edges = [];
  const emap = new Map();
  const hexes = [];
  const hmap = new Map();

  coords.forEach(([q, r], id) => {
    const c = hexCenter(q, r);
    hexes.push({ id, q, r, x: c.x, y: c.y, vertices: [], adjHexes: [] });
    hmap.set(q + ',' + r, id);
  });

  for (const h of hexes) {
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30);
      const x = h.x + Math.cos(ang);
      const y = h.y + Math.sin(ang);
      const key = k(x) + ',' + k(y);
      let vid = vmap.get(key);
      if (vid === undefined) {
        vid = vertices.length;
        vmap.set(key, vid);
        vertices.push({ id: vid, x, y, hexes: [], adj: [], edges: [] });
      }
      h.vertices.push(vid);
      vertices[vid].hexes.push(h.id);
    }
    for (let i = 0; i < 6; i++) {
      const a = h.vertices[i];
      const b = h.vertices[(i + 1) % 6];
      const ek = a < b ? a + '-' + b : b + '-' + a;
      let eid = emap.get(ek);
      if (eid === undefined) {
        eid = edges.length;
        emap.set(ek, eid);
        edges.push({ id: eid, a, b, hexes: [h.id] });
      } else {
        edges[eid].hexes.push(h.id);
      }
    }
  }

  for (const e of edges) {
    vertices[e.a].adj.push(e.b);
    vertices[e.b].adj.push(e.a);
    vertices[e.a].edges.push(e.id);
    vertices[e.b].edges.push(e.id);
  }
  for (const h of hexes) {
    for (const [dq, dr] of HEX_DIRS) {
      const n = hmap.get(h.q + dq + ',' + (h.r + dr));
      if (n !== undefined) h.adjHexes.push(n);
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of vertices) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  return { hexes, vertices, edges, bounds: { minX, minY, maxX, maxY } };
}

export function edgeMid(g, e) {
  const a = g.vertices[e.a];
  const b = g.vertices[e.b];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
