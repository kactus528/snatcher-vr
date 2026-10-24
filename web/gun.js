// Light-gun aiming: where does a ray from the controller hit the game screen?
// The screen may be bent into 3D by a depth map, so the ray is marched against
// that surface, and a shot lands where you see the target, not where it would be
// on a flat screen.
//
// All maths happens in the screen group's local space: x across, y up, z toward
// the viewer; the picture spans width W and height H centred on the origin.

export function makeHeightField(image) {
  // image: HTMLImageElement / ImageBitmap of a depth map (128 = screen plane)
  const c = new OffscreenCanvas(image.width, image.height), ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const px = ctx.getImageData(0, 0, image.width, image.height).data;
  const d = new Uint8Array(image.width * image.height);
  for (let i = 0; i < d.length; i++) d[i] = px[i * 4];
  return { w: image.width, h: image.height, d };
}

// o, dir: ray in screen-local space ({x,y,z}); W,H: picture size;
// field: height field or null; amount: current depth scale (metres per 128 steps);
// card: { z, covered(u, vTop) } for the floating panel card, or null.
// Returns { u, v } with v measured from the top of the picture, or null on a miss.
export function aim(o, dir, W, H, field, amount, card) {
  const toUV = (p) => ({ u: p.x / W + 0.5, v: 0.5 - p.y / H });
  const inside = (t) => t.u >= 0 && t.u <= 1 && t.v >= 0 && t.v <= 1;
  const at = (t) => ({ x: o.x + dir.x * t, y: o.y + dir.y * t, z: o.z + dir.z * t });
  if (Math.abs(dir.z) < 1e-6) return null;

  // the floating card for panels sits in front of everything
  if (card) {
    const t = (card.z - o.z) / dir.z;
    if (t > 0) { const uv = toUV(at(t)); if (inside(uv) && card.covered(uv.u, uv.v)) return uv; }
  }

  const height = (p) => {
    if (!field || !amount) return 0;
    const { u, v } = toUV(p);
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const x = Math.min(field.w - 1, (u * field.w) | 0), y = Math.min(field.h - 1, (v * field.h) | 0);
    return (field.d[y * field.w + x] - 128) / 128 * amount;
  };
  if (!field || !amount) {                       // flat screen: a plane at z = 0
    const t = -o.z / dir.z; if (t <= 0) return null;
    const uv = toUV(at(t)); return inside(uv) ? uv : null;
  }
  // march from above the tallest possible point to below the deepest
  const top = amount * 0.7 + 0.01, bottom = -amount * 0.7 - 0.01;
  let t0 = (top - o.z) / dir.z, t1 = (bottom - o.z) / dir.z;
  if (t0 > t1) [t0, t1] = [t1, t0];
  t0 = Math.max(t0, 0); if (t1 <= 0) return null;
  const above = (t) => { const p = at(t); return p.z > height(p); };
  const N = 96; let prev = t0;
  for (let i = 1; i <= N; i++) {
    const t = t0 + (t1 - t0) * i / N;
    if (!above(t)) {
      let a = prev, b = t;                         // refine the crossing
      for (let k = 0; k < 8; k++) { const m = (a + b) / 2; if (above(m)) a = m; else b = m; }
      const uv = toUV(at(b)); return inside(uv) ? uv : null;
    }
    prev = t;
  }
  return null;
}
