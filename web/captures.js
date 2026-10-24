// Scene capture: saves each new scene's picture, a colour-coded layer map and
// a fingerprint to the browser's storage, and exports them all as one .zip.
// The captures are the raw material for depth maps; the fingerprints are how
// the game will recognise a scene later and load its map.

const GW = 32, GH = 24;              // fingerprint grid
const LAYER_RGB = {                  // same colours as the in-game layer view
  0: [115, 51, 153], 1: [77, 140, 255], 2: [90, 217, 255], 3: [102, 255, 128], 4: [217, 255, 90],
  5: [255, 217, 77], 6: [255, 217, 77], 7: [255, 140, 77], 8: [255, 90, 140], 255: [140, 140, 140],
};

// Average brightness per grid cell. Rows arrive bottom-up; cell rows are top-down.
export function fingerprint(rgba, w, h) {
  const sum = new Float32Array(GW * GH), n = new Float32Array(GW * GH);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(GH - 1, ((h - 1 - y) * GH / h) | 0);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, g = gy * GW + Math.min(GW - 1, (x * GW / w) | 0);
      sum[g] += rgba[i] * 0.3 + rgba[i + 1] * 0.59 + rgba[i + 2] * 0.11; n[g]++;
    }
  }
  const fp = new Uint8Array(GW * GH);
  for (let g = 0; g < fp.length; g++) fp[g] = n[g] ? Math.round(sum[g] / n[g]) : 0;
  return fp;
}

// Fraction of cells that differ noticeably. Tolerates blinking eyes and text
// changing in one part of the screen, but not a different picture.
export function distance(a, b) {
  let diff = 0;
  for (let g = 0; g < a.length; g++) if (Math.abs(a[g] - b[g]) > 16) diff++;
  return diff / a.length;
}
// Same, but only over the grid cells inside a picture box [x0,y0,x1,y1] (pixels,
// top-down), so a changing text box or portrait under the picture doesn't matter.
export function distanceIn(a, b, box, w, h) {
  let diff = 0, n = 0;
  for (let gy = 0; gy < GH; gy++) {
    const cy = (gy + 0.5) * h / GH; if (cy < box[1] || cy > box[3]) continue;
    for (let gx = 0; gx < GW; gx++) {
      const cx = (gx + 0.5) * w / GW; if (cx < box[0] || cx > box[2]) continue;
      n++; if (Math.abs(a[gy * GW + gx] - b[gy * GW + gx]) > 16) diff++;
    }
  }
  return n ? diff / n : 1;
}
const SAME_SCENE = 0.2, STEADY = 0.02;

const brightness = (fp) => fp.reduce((s, v) => s + v, 0) / fp.length;

async function dir() {
  const r = await navigator.storage.getDirectory();
  return r.getDirectoryHandle('captures', { create: true });
}

async function writeFile(d, name, data) {
  const w = await (await d.getFileHandle(name, { create: true })).createWritable();
  await w.write(data); await w.close();
}

function toPNG(w, h, paint) {
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  paint(img.data);
  ctx.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

export class Captures {
  constructor({ onChange } = {}) {
    this.scenes = [];                 // { id, fp }
    this.onChange = onChange || (() => {});
    this.auto = false;
    this.recent = [];                 // last few fingerprints, to wait for a still picture
    this.busy = false;
  }

  async load() {
    try {
      const d = await dir();
      for await (const [name, h] of d.entries()) {
        if (!name.endsWith('.json')) continue;
        const meta = JSON.parse(await (await h.getFile()).text());
        this.scenes.push({ id: meta.id, fp: Uint8Array.from(meta.fingerprint) });
      }
      this.scenes.sort((a, b) => a.id.localeCompare(b.id));
    } catch {}
    this.onChange(this.scenes.length);
  }

  match(fp) {
    let best = null, bestD = 1;
    for (const s of this.scenes) { const d = distance(fp, s.fp); if (d < bestD) { bestD = d; best = s; } }
    return bestD < SAME_SCENE ? best : null;
  }

  // Called with every frame (cheap: only does work every 10th frame).
  frame(w, h, rgba, tags) {
    this.last = { w, h, rgba, tags };
    if (!this.auto || this.busy || (this.count = (this.count || 0) + 1) % 10) return null;
    const fp = fingerprint(rgba, w, h);
    this.recent.push(fp); if (this.recent.length > 4) this.recent.shift();
    if (this.recent.length < 4) return null;
    // wait until the picture has held still for ~0.6 s (skips fades and scrolling)
    for (let i = 1; i < this.recent.length; i++) if (distance(this.recent[i - 1], this.recent[i]) > STEADY) return null;
    if (brightness(fp) < 12) return null;         // black or nearly black screen
    if (this.match(fp)) return null;              // already have it
    return this.save(fp);
  }

  async captureNow() {
    if (!this.last) return null;
    while (this.busy) await this.saving;          // finish an automatic capture first
    const { w, h, rgba } = this.last;
    return this.save(fingerprint(rgba, w, h), true);
  }

  save(fp, force = false) {
    if (this.busy) return Promise.resolve(null);
    const existing = this.match(fp);
    if (existing && !force) return Promise.resolve(null);
    this.busy = true;
    this.saving = this.write(fp, existing).finally(() => { this.busy = false; });
    return this.saving;
  }

  async write(fp, existing) {
    {
      const { w, h, rgba, tags } = this.last;
      const id = 'scene-' + String(this.scenes.length + 1).padStart(3, '0');
      // flip to top-down for the image files
      const flip = (dst, px) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(dst, (y * w + x) * 4, ((h - 1 - y) * w + x)); };
      const shot = await toPNG(w, h, (d) => flip(d, (d, o, i) => { d[o] = rgba[i * 4]; d[o + 1] = rgba[i * 4 + 1]; d[o + 2] = rgba[i * 4 + 2]; d[o + 3] = 255; }));
      const layers = await toPNG(w, h, (d) => flip(d, (d, o, i) => { const c = LAYER_RGB[tags[i]] || LAYER_RGB[255]; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }));
      const counts = {}; for (const t of tags) counts[t] = (counts[t] || 0) + 1;
      const meta = { id, width: w, height: h, captured: new Date().toISOString(), fingerprint: [...fp], fingerprintGrid: [GW, GH],
        layerPixels: counts, sameAs: existing ? existing.id : null };
      const d = await dir();
      await writeFile(d, id + '.png', shot);
      await writeFile(d, id + '-layers.png', layers);
      await writeFile(d, id + '.json', JSON.stringify(meta, null, 1));
      this.scenes.push({ id, fp });
      this.onChange(this.scenes.length);
      return id;
    }
  }

  async clear() {
    const r = await navigator.storage.getDirectory();
    try { await r.removeEntry('captures', { recursive: true }); } catch {}
    this.scenes = []; this.recent = [];
    this.onChange(0);
  }

  // All captures as one uncompressed .zip (PNGs are already compressed)
  async zip() {
    const d = await dir();
    const files = [];
    for await (const [name, h] of d.entries()) if (h.kind === 'file') files.push({ name, data: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
    files.sort((a, b) => a.name.localeCompare(b.name));
    return makeZip(files.map(f => ({ name: 'snatcher-captures/' + f.name, data: f.data })));
  }
}

/* ---- minimal stored-zip writer ---- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true);
    parts.push(lh, name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
