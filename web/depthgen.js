// Makes a depth map for a scene on this device: find the illustration,
// run Depth Anything V2 on it (in depth-worker.js), and turn the result into
// the same kind of map tools/make_depth.py produces:
//   8-bit, frame-sized, 128 = screen plane, brighter = closer, 128 outside the picture.

export const SIZE = 518;                       // model input size
const FAR = 72, NEAR = 210;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

// rgba rows arrive bottom-up from the emulator; work top-down here
export function topDown(rgba, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(rgba.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}

// Largest solid non-black region, found on a grid of 4x4 blocks.
// Snatcher draws its pictures in a box surrounded by black, with text below.
export function pictureBox(top, w, h) {
  const B = 4, gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  const solid = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let lit = 0, n = 0;
    for (let y = gy * B; y < Math.min(h, gy * B + B); y++) for (let x = gx * B; x < Math.min(w, gx * B + B); x++) {
      const i = (y * w + x) * 4; n++;
      if (top[i] * 0.3 + top[i + 1] * 0.59 + top[i + 2] * 0.11 > 18) lit++;
    }
    solid[gy * gw + gx] = lit / n > 0.4 ? 1 : 0;
  }
  // drop thin features (text lines): keep blocks whose 3x3 neighbourhood is mostly solid
  const keep = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let c = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      n++; c += solid[y * gw + x];
    }
    keep[gy * gw + gx] = solid[gy * gw + gx] && c >= n * 0.66 ? 1 : 0;
  }
  // largest 4-connected component
  const label = new Int32Array(gw * gh); let best = null, bestN = 0, next = 1;
  for (let s = 0; s < keep.length; s++) {
    if (!keep[s] || label[s]) continue;
    const stack = [s]; label[s] = next; let n = 0, x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    while (stack.length) {
      const p = stack.pop(), x = p % gw, y = (p / gw) | 0; n++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const q of [p - 1, p + 1, p - gw, p + gw]) {
        if (q < 0 || q >= keep.length || label[q] || !keep[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === gw - 1)) continue;
        label[q] = next; stack.push(q);
      }
    }
    if (n > bestN) { bestN = n; best = [x0, y0, x1, y1]; }
    next++;
  }
  if (!best || bestN < 0.08 * gw * gh) return null;     // no picture (menus, text screens)
  return [best[0] * B, best[1] * B, Math.min(w, (best[2] + 1) * B), Math.min(h, (best[3] + 1) * B)];
}

// Crop → 518x518 → normalised CHW float input
export function modelInput(top, w, h, box) {
  const [x0, y0, x1, y1] = box;
  const src = new OffscreenCanvas(w, h);
  src.getContext('2d').putImageData(new ImageData(top, w, h), 0, 0);
  const dst = new OffscreenCanvas(SIZE, SIZE), ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const input = new Float32Array(3 * SIZE * SIZE), plane = SIZE * SIZE;
  for (let i = 0; i < plane; i++)
    for (let c = 0; c < 3; c++) input[c * plane + i] = (px[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  return input;
}

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// Model output (SIZE x SIZE relative depth, bigger = closer) → frame-sized 8-bit map
export function depthMap(output, w, h, box, top) {
  const [x0, y0, x1, y1] = box, bw = x1 - x0, bh = y1 - y0;
  const lo = percentile(output, 0.02), hi = percentile(output, 0.98), span = hi - lo || 1;
  const map = new Uint8Array(w * h).fill(128);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    // bilinear sample of the model output at this picture pixel
    const fx = (x + 0.5) / bw * SIZE - 0.5, fy = (y + 0.5) / bh * SIZE - 0.5;
    const ix = Math.max(0, Math.min(SIZE - 2, Math.floor(fx))), iy = Math.max(0, Math.min(SIZE - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - ix)), ty = Math.min(1, Math.max(0, fy - iy));
    const o = (yy, xx) => output[yy * SIZE + xx];
    const v = (o(iy, ix) * (1 - tx) + o(iy, ix + 1) * tx) * (1 - ty) + (o(iy + 1, ix) * (1 - tx) + o(iy + 1, ix + 1) * tx) * ty;
    const d = Math.min(1, Math.max(0, (v - lo) / span));
    map[(y0 + y) * w + x0 + x] = Math.round(FAR + d * (NEAR - FAR));
  }
  if (top) flattenScreens(top, w, h, box, map);
  return blur(map, w, h);
}

/* Monitor and TV screens come out of the depth model as deep tubs (dark glass
   reads as 'far'). Find large dark areas whose outline is nearly a rectangle and
   make the whole rectangle flat, set slightly back from its frame.
   Same rule as tools/make_depth.py. */
function flattenScreens(top, w, h, box, map) {
  const [bx0, by0, bx1, by1] = box, cw = bx1 - bx0, ch = by1 - by0, n = cw * ch;
  const lum = new Float32Array(n);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = ((by0 + y) * w + bx0 + x) * 4;
    lum[y * cw + x] = top[i] * 0.3 + top[i + 1] * 0.59 + top[i + 2] * 0.11;
  }
  const morph = (src, keep) => {        // 3x3 erosion (keep=all) or dilation (keep=any)
    const out = new Uint8Array(n);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      let all = 1, any = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        const v = xx < 0 || yy < 0 || xx >= cw || yy >= ch ? 0 : src[yy * cw + xx];
        all &= v; any |= v;
      }
      out[y * cw + x] = keep === 'all' ? all : any;
    }
    return out;
  };
  const done = new Uint8Array(n);
  for (const thr of [40, 60, 80]) {
    let dark = new Uint8Array(n);
    for (let i = 0; i < n; i++) dark[i] = lum[i] < thr ? 1 : 0;
    dark = morph(morph(dark, 'all'), 'any');
    const label = new Int32Array(n); let next = 1;
    for (let s = 0; s < n; s++) {
      if (!dark[s] || label[s]) continue;
      const stack = [s], cells = []; label[s] = next;
      let x0 = cw, y0 = ch, x1 = 0, y1 = 0;
      while (stack.length) {
        const p = stack.pop(), x = p % cw, y = (p / cw) | 0; cells.push(p);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && dark[p - 1] && !label[p - 1]) { label[p - 1] = next; stack.push(p - 1); }
        if (x < cw - 1 && dark[p + 1] && !label[p + 1]) { label[p + 1] = next; stack.push(p + 1); }
        if (y > 0 && dark[p - cw] && !label[p - cw]) { label[p - cw] = next; stack.push(p - cw); }
        if (y < ch - 1 && dark[p + cw] && !label[p + cw]) { label[p + cw] = next; stack.push(p + cw); }
      }
      const id = next++;
      if (cells.length < 0.03 * n) continue;
      if (x0 === 0 || y0 === 0 || x1 === cw - 1 || y1 === ch - 1) continue;
      if (y1 - y0 < 12 || x1 - x0 < 12) continue;
      let taken = false;
      for (let y = y0; y <= y1 && !taken; y++) for (let x = x0; x <= x1; x++) if (done[y * cw + x]) { taken = true; break; }
      if (taken) continue;
      let edgeOn = 0, edgeAll = 0;
      const on = (x, y) => (label[y * cw + x] === id ? 1 : 0);
      for (let x = x0; x <= x1; x++) { edgeOn += on(x, y0) + on(x, y1); edgeAll += 2; }
      for (let y = y0; y <= y1; y++) { edgeOn += on(x0, y) + on(x1, y); edgeAll += 2; }
      if (edgeOn / edgeAll < 0.7) continue;
      // depth of the frame: median of a 3-pixel ring around the rectangle
      const ring = [];
      for (let y = Math.max(0, y0 - 3); y <= Math.min(ch - 1, y1 + 3); y++)
        for (let x = Math.max(0, x0 - 3); x <= Math.min(cw - 1, x1 + 3); x++)
          if (x < x0 || x > x1 || y < y0 || y > y1) ring.push(map[(by0 + y) * w + bx0 + x]);
      ring.sort((a, b) => a - b);
      const v = Math.max(0, (ring[ring.length >> 1] || 128) - 8);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { map[(by0 + y) * w + bx0 + x] = v; done[y * cw + x] = 1; }
    }
  }
}

// light 3x3 smoothing so the mesh doesn't tear at hard edges
function blur(m, w, h) {
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      s += m[yy * w + xx]; n++;
    }
    out[y * w + x] = Math.round(s / n);
  }
  return out;
}

// 8-bit map → PNG blob (for storage) and back
export async function mapToPNG(map, w, h) {
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
  for (let i = 0; i < map.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = map[i]; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}
