// Turns a scene's depth map into a few flat layers, 3DS style: each pixel goes to
// the layer its depth is closest to, and each layer becomes a flat sheet.
// For every sheet we also work out, for each pixel covered by something nearer,
// which pixel of this layer (or one behind it) to show instead, so leaning
// around a character shows background rather than a hole.

export const MAX_LAYERS = 5;

// field: { w, h, d } depth map (128 = screen plane, top-down rows)
// box: [x0, y0, x1, y1] picture area or null; count: layers inside the picture
export function buildLayers(field, box, count = 3) {
  const { w, h, d } = field, n = w * h;
  const inPic = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    inPic[i] = box ? (x >= box[0] && x < box[2] && y >= box[1] && y < box[3]) : (d[i] !== 128);
  }
  // 1-D k-means on the picture's depths
  const vals = []; for (let i = 0; i < n; i++) if (inPic[i]) vals.push(d[i]);
  vals.sort((a, b) => a - b);
  let centres = [];
  if (vals.length) {
    for (let k = 0; k < count; k++) centres.push(vals[Math.floor((k + 0.5) / count * (vals.length - 1))]);
    for (let it = 0; it < 12; it++) {
      const sum = new Float64Array(count), num = new Float64Array(count);
      for (const v of vals) { let b = 0; for (let k = 1; k < count; k++) if (Math.abs(v - centres[k]) < Math.abs(v - centres[b])) b = k; sum[b] += v; num[b]++; }
      centres = centres.map((c, k) => (num[k] ? sum[k] / num[k] : c));
    }
    // merge layers that ended up nearly at the same depth
    centres.sort((a, b) => a - b);
    centres = centres.filter((c, k) => k === 0 || c - centres[k - 1] > 6);
  }
  // layer list, back to front; the area outside the picture (text, border) is its own layer at the screen plane
  const layers = centres.map((c) => ({ depth: c, picture: true }));
  layers.push({ depth: 128, picture: false });
  layers.sort((a, b) => a.depth - b.depth);
  const frameIdx = layers.findIndex((l) => !l.picture);

  const idx = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!inPic[i]) { idx[i] = frameIdx; continue; }
    let best = 0, bd = 1e9;
    for (let k = 0; k < layers.length; k++) if (layers[k].picture) { const e = Math.abs(d[i] - layers[k].depth); if (e < bd) { bd = e; best = k; } }
    idx[i] = best;
  }

  // tidy layer edges so objects stay in one piece: a few passes of a 7x7 majority vote
  for (let pass = 0; pass < 3; pass++) {
    const prev = idx.slice(), votes = new Uint16Array(layers.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!inPic[i]) continue;
      votes.fill(0);
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx; if (inPic[j]) votes[prev[j]]++;
      }
      let best = prev[i]; for (let k = 0; k < votes.length; k++) if (votes[k] > votes[best]) best = k;
      idx[i] = best;
    }
  }

  // per sheet: nearest pixel at or behind this layer, for filling holes (multi-source BFS)
  const donors = layers.map((_, k) => {
    const src = new Int32Array(n).fill(-1), queue = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) if (idx[i] <= k) { src[i] = i; queue[tail++] = i; }
    while (head < tail) {
      const p = queue[head++], x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) if (q >= 0 && q < n && src[q] < 0) { src[q] = src[p]; queue[tail++] = q; }
    }
    // pack donor x,y (16-bit each) into RGBA, rows bottom-up to match the colour texture
    const out = new Uint8Array(n * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = src[y * w + x] < 0 ? y * w + x : src[y * w + x];
      const sx = s % w, sy = h - 1 - ((s / w) | 0), o = ((h - 1 - y) * w + x) * 4;
      out[o] = sx & 255; out[o + 1] = sx >> 8; out[o + 2] = sy & 255; out[o + 3] = sy >> 8;
    }
    return out;
  });
  // layer index texture, bottom-up
  const idxUp = new Uint8Array(n);
  for (let y = 0; y < h; y++) idxUp.set(idx.subarray(y * w, y * w + w), (h - 1 - y) * w);
  return { w, h, layers, idx, idxUp, donors };
}

// Gun hit test against flat layers (front to back), in screen-local space.
// Returns { u, v, p } like gun.js aim(), or null.
export function aimLayers(o, dir, W, H, built, amount, card) {
  if (Math.abs(dir.z) < 1e-6) return null;
  const toUV = (p) => ({ u: p.x / W + 0.5, v: 0.5 - p.y / H });
  const at = (t) => ({ x: o.x + dir.x * t, y: o.y + dir.y * t, z: o.z + dir.z * t });
  const inside = (q) => q.u >= 0 && q.u <= 1 && q.v >= 0 && q.v <= 1;
  if (card) {
    const t = (card.z - o.z) / dir.z;
    if (t > 0) { const p = at(t), uv = toUV(p); if (inside(uv) && card.covered(uv.u, uv.v)) return { ...uv, p }; }
  }
  for (let k = built.layers.length - 1; k >= 0; k--) {
    const z = (built.layers[k].depth - 128) / 128 * amount;
    const t = (z - o.z) / dir.z; if (t <= 0) continue;
    const p = at(t), uv = toUV(p); if (!inside(uv)) continue;
    const x = Math.min(built.w - 1, (uv.u * built.w) | 0), y = Math.min(built.h - 1, (uv.v * built.h) | 0);
    if (built.idx[y * built.w + x] === k || k === 0) return { ...uv, p };
  }
  return null;
}
