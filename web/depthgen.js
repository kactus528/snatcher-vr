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
export function depthMap(output, w, h, box) {
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
  return blur(map, w, h);
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
