import * as THREE from 'three';
import * as store from './storage.js';
import { SEGA } from './core.js';
import { Captures, fingerprint, distance, distanceIn, GW, GH } from './captures.js';
import { SIZE, topDown, pictureBox, modelInput, depthMap, mapToPNG } from './depthgen.js';

const $ = (id) => document.getElementById(id);
const status = (msg, kind = '') => { const s = $('status'); s.textContent = msg; s.dataset.kind = kind; vrStatus(msg, kind); };
let vrStatus = () => {};             // replaced once the 3D scene exists
let libReady = false, copying = false, vrSupported = false;
function updateButtons() {
  $('play').disabled = !libReady || started || copying;
  $('vr').disabled = !vrSupported || copying || (!libReady && !started);
}

/* ------------------------------------------------------------------ library */
async function refreshLibrary() {
  const lib = await store.library();
  $('biosState').textContent = lib.bios || 'Not added yet';
  $('biosState').dataset.ok = !!lib.bios;
  $('discState').textContent = lib.disc ? `${lib.disc.entry}${lib.disc.names.length > 1 ? ` + ${lib.disc.names.length - 1} track files` : ''}` : 'Not added yet';
  $('discState').dataset.ok = !!lib.disc;
  libReady = !!(lib.bios && lib.disc);
  updateButtons();
}

$('biosFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  copying = true; updateButtons();
  try { await store.saveBios(f); status('BIOS saved.', 'ok'); } catch (err) { status(err.message, 'error'); }
  copying = false; e.target.value = ''; refreshLibrary();
});
$('discFiles').addEventListener('change', async (e) => {
  const files = [...e.target.files]; if (!files.length) return;
  copying = true; updateButtons();
  try {
    await store.saveDisc(files, (p) => status(`Copying disc into the browser… ${Math.round(p * 100)}%`));
    status('Disc saved. You only have to do this once.', 'ok');
  } catch (err) { status(err.message, 'error'); }
  copying = false; e.target.value = ''; refreshLibrary();
});

/* ------------------------------------------------------------------ renderer */
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.xr.setFoveation(0.5);
view.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07060b);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);

// The game screen, drawn as a stack of cut-out layers. Each pixel carries a
// tag saying which VDP layer it came from (see core/patch_layers.py); every
// layer group gets its own sheet at its own depth. The rearmost sheet draws
// the whole picture, so moving your head never shows holes.
const SCREEN_W = 2.4, SCREEN_Z = -2.2, SCREEN_Y = 1.5;

// tag → group. Groups are drawn back to front.
const GROUPS = [
  { name: 'Plane B',          tags: [0, 1, 255], depth: 0.0,  tint: [0.30, 0.55, 1.00], full: true },
  { name: 'Plane B (front)',  tags: [2],         depth: 0.15, tint: [0.35, 0.85, 1.00] },
  { name: 'Plane A',          tags: [3],         depth: 0.35, tint: [0.40, 1.00, 0.50] },
  { name: 'Plane A (front)',  tags: [4],         depth: 0.5,  tint: [0.85, 1.00, 0.35] },
  { name: 'Sprites',          tags: [7],         depth: 0.62, tint: [1.00, 0.55, 0.30] },
  { name: 'Window / text',    tags: [5, 6],      depth: 0.75, tint: [1.00, 0.85, 0.30] },
  { name: 'Sprites (front)',  tags: [8],         depth: 0.88, tint: [1.00, 0.35, 0.55] },
];

const view3d = { mode: 'depth', strength: 0.3, cutouts: false, smoothing: 'clean' }; // mode: flat | depth | layers
try { Object.assign(view3d, JSON.parse(localStorage.getItem('snatcher-vr.view')) || {}); } catch {}
const saveView = () => { try { localStorage.setItem('snatcher-vr.view', JSON.stringify(view3d)); } catch {} };

function makeTex(data, w, h, format) {
  const t = new THREE.DataTexture(data, w, h, format);
  t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
let colorTex = makeTex(new Uint8Array([20, 18, 30, 255]), 1, 1, THREE.RGBAFormat);
colorTex.magFilter = colorTex.minFilter = THREE.LinearFilter;
// shared by every screen material: colour texture size and smoothing mode (0 sharp, 1 clean/smooth)
const smoothUniforms = { texSize: { value: new THREE.Vector2(1, 1) }, smoothMode: { value: 1 } };
let tagTex = makeTex(new Uint8Array([0]), 1, 1, THREE.RedFormat);

const screen = new THREE.Group();
screen.position.set(0, SCREEN_Y, SCREEN_Z);
scene.add(screen);
const sheets = GROUPS.map((g, i) => {
  const tagMask = new Float32Array(16); // which of tags 0..8 (and 255→slot 15) belong here
  g.tags.forEach(t => { tagMask[t === 255 ? 15 : t] = 1; });
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      colorTex: { value: colorTex }, tagTex: { value: tagTex },
      tagMask: { value: tagMask }, full: { value: g.full ? 1 : 0 },
      tint: { value: new THREE.Vector3(...g.tint) }, showTint: { value: 0 },
      texSize: smoothUniforms.texSize, smoothMode: smoothUniforms.smoothMode,
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D colorTex; uniform sampler2D tagTex;
      uniform float tagMask[16]; uniform float full; uniform vec3 tint; uniform float showTint;
      varying vec2 vUv;
      uniform vec2 texSize; uniform float smoothMode;
      // sharp: hard pixels. otherwise 'sharp bilinear': blend only across the
      // one screen pixel where two game pixels meet, so edges stop shimmering
      vec4 sampleColor(sampler2D tex, vec2 uv) {
        vec2 p = uv * texSize - 0.5, i = floor(p), f = p - i;
        if (smoothMode < 0.5) return texture2D(tex, (floor(uv * texSize) + 0.5) / texSize);
        vec2 fw = max(fwidth(p), vec2(1e-4));
        f = clamp((f - 0.5) / fw + 0.5, 0.0, 1.0);
        return texture2D(tex, (i + f + 0.5) / texSize);
      }
      float inGroup(float t){
        float m = 0.0;
        for (int i = 0; i < 16; i++) { float id = (i == 15) ? 255.0 : float(i); if (abs(t - id) < 0.5) m = tagMask[i]; }
        return m;
      }
      void main(){
        float t = floor(texture2D(tagTex, vUv).r * 255.0 + 0.5);
        if (full < 0.5 && inGroup(t) < 0.5) discard;
        vec4 c = sampleColor(colorTex, vUv);
        if (showTint > 0.5 && !(full > 0.5 && inGroup(t) < 0.5)) {
          vec3 tc = tint;
          if (t > 254.5) tc = vec3(0.55);              // unknown: video mode without layer info (grey)
          else if (t < 0.5) tc = vec3(0.45, 0.2, 0.6); // backdrop colour, no layer drawn here (purple)
          c.rgb = mix(c.rgb, tc, 0.55);
        }
        gl_FragColor = c;   // emulator colours pass straight through
      }`,
    depthWrite: false,   // sheets stack by draw order, back to front
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.scale.set(SCREEN_W, SCREEN_W * 0.75, 1);
  m.renderOrder = 1 + i;
  screen.add(m);
  return m;
});

/* ---- scene depth maps (made by tools/make_depth.py from captures) ---- */
// The picture is a grid of vertices pushed toward or away from you by the
// matched scene's depth map. 128 in the map = the screen plane.
/* ---- overlay panels ----
   Item boxes, portraits and menus are drawn by the game as rectangles of sprites
   on top of the illustration. Find them from the layer tags each frame so the
   3D picture can leave them out and show them on a flat card floating in front. */
let overlayTex = makeTex(new Uint8Array([0]), 1, 1, THREE.RedFormat);
const overlayUniform = { value: overlayTex };
let overlayCount = 0;

function findOverlays(tags, w, h) {
  const mask = new Uint8Array(w * h), seen = new Uint8Array(w * h), stack = [];
  let panels = 0;
  for (let s = 0; s < tags.length; s++) {
    const t = tags[s];
    if (seen[s] || !(t === 7 || t === 8 || t === 5 || t === 6)) continue;
    const isWindow = t === 5 || t === 6;
    let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= tags.length || seen[q]) continue;
        const u = tags[q];
        // same layer and same priority only, so a panel touching a character stays separate
        if (isWindow ? (u === 5 || u === 6) : u === t) { seen[q] = 1; stack.push(q); }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // a panel: a big, nearly solid rectangle (characters are irregular shapes)
    if (isWindow || (n >= 300 && bw >= 16 && bh >= 16 && n / (bw * bh) >= 0.8)) {
      panels++;
      for (let y = y0; y <= y1; y++) mask.fill(255, y * w + x0, y * w + x1 + 1);
    }
  }
  return { mask, panels };
}

let overlayCells = null;     // fingerprint cells covered by panels (top-down), ignored when matching scenes
function updateOverlays(tags, w, h) {
  const { mask, panels } = findOverlays(tags, w, h);
  overlayCount = panels;
  overlayCells = null;
  if (panels) {
    overlayCells = new Uint8Array(GW * GH);
    for (let y = 0; y < h; y++) {                  // mask rows are bottom-up
      const gy = Math.min(GH - 1, ((h - 1 - y) * GH / h) | 0);
      for (let x = 0; x < w; x++) if (mask[y * w + x]) overlayCells[gy * GW + Math.min(GW - 1, (x * GW / w) | 0)] = 1;
    }
  }
  if (overlayTex.image.width !== w || overlayTex.image.height !== h) {
    overlayTex.dispose(); overlayTex = makeTex(mask, w, h, THREE.RedFormat); overlayUniform.value = overlayTex;
  } else { overlayTex.image.data = mask; overlayTex.needsUpdate = true; }
}

const dioramaMat = new THREE.ShaderMaterial({
  uniforms: { colorTex: { value: colorTex }, depthTex: { value: null }, amount: { value: 0 },
    overlayTex: overlayUniform, texSize: smoothUniforms.texSize, smoothMode: smoothUniforms.smoothMode },
  vertexShader: `
    uniform sampler2D depthTex; uniform float amount; varying vec2 vUv;
    void main(){
      vUv = uv;
      float d = texture2D(depthTex, uv).r * 255.0 - 128.0;
      vec3 p = position; p.z += d / 128.0 * amount;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: `uniform sampler2D colorTex; varying vec2 vUv;
      uniform vec2 texSize; uniform float smoothMode;
      // sharp: hard pixels. otherwise 'sharp bilinear': blend only across the
      // one screen pixel where two game pixels meet, so edges stop shimmering
      vec4 sampleColor(sampler2D tex, vec2 uv) {
        vec2 p = uv * texSize - 0.5, i = floor(p), f = p - i;
        if (smoothMode < 0.5) return texture2D(tex, (floor(uv * texSize) + 0.5) / texSize);
        vec2 fw = max(fwidth(p), vec2(1e-4));
        f = clamp((f - 0.5) / fw + 0.5, 0.0, 1.0);
        return texture2D(tex, (i + f + 0.5) / texSize);
      }
    uniform sampler2D overlayTex;
    void main(){
      if (texture2D(overlayTex, vUv).r > 0.5) discard;   // panels are drawn on their own card
      gl_FragColor = sampleColor(colorTex, vUv);
    }`,
});
const diorama = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 192, 168), dioramaMat);
diorama.scale.set(SCREEN_W, SCREEN_W * 0.75, 1);
diorama.visible = false;
screen.add(diorama);

const cardMat = new THREE.ShaderMaterial({
  uniforms: { colorTex: dioramaMat.uniforms.colorTex, overlayTex: overlayUniform,
    texSize: smoothUniforms.texSize, smoothMode: smoothUniforms.smoothMode },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: dioramaMat.fragmentShader.replace('> 0.5) discard;', '< 0.5) discard;'),
});
const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cardMat);
card.scale.copy(diorama.scale); card.visible = false; card.renderOrder = 50;
screen.add(card);

const depthLib = { scenes: [], textures: new Map(), current: null };
fetch(new URL('./depth/manifest.json', import.meta.url)).then(r => r.ok ? r.json() : { scenes: [] })
  .then(m => { depthLib.scenes.push(...m.scenes.map(s => ({ ...s, fp: Uint8Array.from(s.fingerprint) }))); })
  .catch(() => {});

function depthTexture(scene) {
  let t = depthLib.textures.get(scene.id);
  if (!t) {
    t = new THREE.TextureLoader().load(new URL('./depth/' + scene.map, import.meta.url).href);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    depthLib.textures.set(scene.id, t);
  }
  return t;
}

// small corner badge above the screen: whether the current scene is in 3D
const badgeCanvas = document.createElement('canvas'); badgeCanvas.width = 320; badgeCanvas.height = 48;
const badgeTex = new THREE.CanvasTexture(badgeCanvas); badgeTex.colorSpace = THREE.SRGBColorSpace;
const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.06), new THREE.MeshBasicMaterial({ map: badgeTex, transparent: true }));
badge.position.set(SCREEN_W / 2 - 0.2, SCREEN_W * 0.375 + 0.05, 0);
screen.add(badge);
function setBadge(state, text) {   // state: on | off | busy
  const c = badgeCanvas.getContext('2d'); c.clearRect(0, 0, 320, 48);
  c.fillStyle = state === 'on' ? 'rgba(111,211,160,0.92)' : state === 'busy' ? 'rgba(255,190,90,0.92)' : 'rgba(80,72,96,0.75)';
  c.fillRect(0, 0, 320, 48);
  c.fillStyle = state === 'off' ? '#e8e2ef' : '#16100a'; c.font = '600 24px "IBM Plex Mono", monospace'; c.textBaseline = 'middle';
  c.fillText(text, 16, 25); badgeTex.needsUpdate = true;
  $('mapState').textContent = { on: '3D map: on for this scene', busy: 'Making a 3D map for this scene…', off: '3D map: none for this scene' }[state];
  $('mapState').dataset.on = state === 'on';
}
setBadge('off', 'NO 3D MAP');

/* ---- making maps on the headset for scenes that don't have one ---- */
const localGen = { enabled: true, worker: null, busy: null, working: false, ready: false, skip: [], loadingShown: false };
// off until switched on: it's heavy for a Quest 2 running the game at the same time
try { localGen.enabled = localStorage.getItem('snatcher-vr.localmaps.v2') === '1'; } catch { localGen.enabled = false; }
// If the browser died while a map was being made, don't try again automatically.
let crashedLastTime = false;
try {
  if (localStorage.getItem('snatcher-vr.mapping')) {
    crashedLastTime = true; localGen.enabled = false;
    localStorage.setItem('snatcher-vr.localmaps.v2', '0'); localStorage.removeItem('snatcher-vr.mapping');
  }
} catch {}
const markMapping = (on) => { try { on ? localStorage.setItem('snatcher-vr.mapping', String(Date.now())) : localStorage.removeItem('snatcher-vr.mapping'); } catch {} };

async function mapsDir() { return (await navigator.storage.getDirectory()).getDirectoryHandle('depthmaps', { create: true }); }

async function addLocalScene(meta, pngBlob) {
  const bmp = await createImageBitmap(pngBlob, { imageOrientation: 'flipY' });
  const t = new THREE.Texture(bmp); t.flipY = false;
  t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
  depthLib.textures.set(meta.id, t);
  depthLib.scenes.push({ ...meta, fp: Uint8Array.from(meta.fingerprint) });
}

// maps made on this headset in earlier sessions
(async () => {
  try {
    const dir = await mapsDir();
    const man = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
    for (const meta of man.scenes) {
      const png = await (await dir.getFileHandle(meta.map)).getFile();
      await addLocalScene(meta, png);
    }
  } catch {}
})();

function depthWorker() {
  if (localGen.worker) return localGen.worker;
  const w = new Worker(new URL('./depth-worker.js', import.meta.url));
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress' && m.fraction < 1) {
      status(`Downloading the 3D depth model (one time only)… ${Math.round(m.fraction * 100)}%`);
      localGen.loadingShown = true;
    } else if (m.type === 'ready') {
      localGen.ready = true;
      if (localGen.loadingShown) status(`3D depth model ready (${m.backend === 'webgpu' ? 'GPU' : 'CPU'}).`, 'ok');
    } else if (m.type === 'result' || m.type === 'error') {
      const job = localGen.busy; localGen.busy = null;
      if (job) job[m.type === 'result' ? 'resolve' : 'reject'](m);
    }
  };
  w.onerror = (e) => { const job = localGen.busy; localGen.busy = null; if (job) job.reject({ msg: e.message || 'worker failed' }); };
  localGen.worker = w;
  return w;
}

async function makeLocalMap(w, h, rgba, fp) {
  localGen.working = true;
  try { await makeLocalMapInner(w, h, rgba, fp); } finally { localGen.working = false; }
}
async function makeLocalMapInner(w, h, rgba, fp) {
  const top = topDown(rgba, w, h);
  const box = pictureBox(top, w, h);
  if (!box) { localGen.skip.push({ w, h, fp }); return; }       // text screen or menu: nothing to sculpt
  const input = modelInput(top, w, h, box);
  setBadge('busy', 'MAKING 3D…');
  const t0 = performance.now();
  let res;
  try {
    res = await new Promise((resolve, reject) => {
      // first run includes the one-time model download, so allow plenty of time
      const limit = setTimeout(() => { localGen.busy = null; reject({ msg: 'the depth model took too long' }); }, localGen.ready ? 120000 : 600000);
      localGen.busy = { resolve: (v) => { clearTimeout(limit); resolve(v); }, reject: (v) => { clearTimeout(limit); reject(v); } };
      markMapping(true);
      depthWorker().postMessage({ type: 'infer', id: Date.now(), input, size: SIZE }, [input.buffer]);
    }).finally(() => markMapping(false));
  } catch (err) {
    localGen.skip.push({ w, h, fp });
    status('Could not make a 3D map: ' + (err.msg || err.message), 'error');
    setBadge('off', 'NO 3D MAP');
    return;
  }
  const map = depthMap(res.output, w, h, box);
  const id = 'q' + Date.now().toString(36);
  const meta = { id, width: w, height: h, grid: [32, 24], fingerprint: [...fp], map: id + '.png', box, madeOn: 'headset' };
  const png = await mapToPNG(map, w, h);
  await addLocalScene(meta, png);
  try {
    const dir = await mapsDir();
    const wr = await (await dir.getFileHandle(meta.map, { create: true })).createWritable(); await wr.write(png); await wr.close();
    const all = depthLib.scenes.filter(s => s.madeOn === 'headset').map(({ fp, ...rest }) => rest);
    const mw = await (await dir.getFileHandle('manifest.json', { create: true })).createWritable();
    await mw.write(JSON.stringify({ version: 1, scenes: all })); await mw.close();
  } catch {}
  console.log(`depth map ${id} in ${Math.round(performance.now() - t0)} ms (${res.backend}, model ${res.ms} ms)`);
  depthLib.current = undefined;                 // force re-recognition on the next frame
}

let fpCounter = 0, recent = [];
function recogniseScene(w, h, rgba) {
  if ((fpCounter++ % 6)) return;
  const fp = fingerprint(rgba, w, h);
  let best = null, bestD = 0.15;
  for (const s of depthLib.scenes) {
    if (s.width !== w || s.height !== h) continue;
    const d = s.box ? distanceIn(fp, s.fp, s.box, w, h, overlayCells) : distance(fp, s.fp);
    if (d < bestD) { bestD = d; best = s; }
  }
  if (best !== depthLib.current) {
    depthLib.current = best;
    if (best) { dioramaMat.uniforms.depthTex.value = depthTexture(best); dioramaMat.uniforms.amount.value = 0; }
    applyView();
    if (!localGen.working) setBadge(best ? 'on' : 'off', best ? '3D MAP ON' : 'NO 3D MAP');
  }

  // no map: once the picture has held still ~0.6 s, make one on the headset
  recent.push(fp); if (recent.length > 6) recent.shift();
  if (best || !localGen.enabled || localGen.working || view3d.mode !== 'depth' || recent.length < 6) return;
  for (let i = 1; i < recent.length; i++) if (distance(recent[i - 1], recent[i]) > 0.02) return;
  if (fp.reduce((a, v) => a + v, 0) / fp.length < 12) return;                       // dark screen
  if (localGen.skip.some(k => k.w === w && k.h === h && distance(k.fp, fp) < 0.15)) return;
  makeLocalMap(w, h, rgba, fp).catch((err) => status('Could not make a 3D map: ' + err.message, 'error'));
}

$('localMaps').checked = localGen.enabled;
$('localMaps').addEventListener('change', (e) => {
  localGen.enabled = e.target.checked;
  try { localStorage.setItem('snatcher-vr.localmaps.v2', e.target.checked ? '1' : '0'); } catch {}
});

function applyView() {
  const useMap = view3d.mode === 'depth' && !!depthLib.current;
  diorama.visible = useMap;
  card.visible = useMap;
  card.position.z = view3d.strength * 0.55;     // floats a little in front of the picture
  sheets.forEach((m, i) => {
    const g = GROUPS[i];
    // no map: flat unless the layer cut-outs are switched on (or the colour view is showing)
    const cutouts = view3d.mode === 'layers' || (view3d.mode === 'depth' && view3d.cutouts);
    m.visible = !useMap && (cutouts || g.full);
    m.position.z = cutouts ? g.depth * view3d.strength : 0;
    m.material.uniforms.showTint.value = view3d.mode === 'layers' ? 1 : 0;
  });
  $('viewMode').value = view3d.mode;
  $('cutouts').checked = !!view3d.cutouts;
  $('smoothing').value = view3d.smoothing;
  smoothUniforms.smoothMode.value = view3d.smoothing === 'sharp' ? 0 : 1;
  try { if (worker) worker.postMessage({ type: 'smooth', scale: view3d.smoothing === 'smooth' ? 4 : 1 }); } catch {} // worker not declared yet on first call
  $('depthStrength').value = view3d.strength;
  $('depthVal').textContent = Math.round(view3d.strength * 100) + ' cm';
}

// faint floor grid so VR has a sense of space
const grid = new THREE.GridHelper(20, 40, 0x2a2238, 0x16121f);
scene.add(grid);

// status line inside VR (errors and start-up progress; fades once the game runs)
const vrCanvas = document.createElement('canvas'); vrCanvas.width = 1024; vrCanvas.height = 160;
const vrTex = new THREE.CanvasTexture(vrCanvas); vrTex.colorSpace = THREE.SRGBColorSpace;
const vrPanel = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.25), new THREE.MeshBasicMaterial({ map: vrTex, transparent: true, depthTest: false }));
vrPanel.position.set(0, SCREEN_Y - SCREEN_W * 0.375 - 0.22, SCREEN_Z + 0.3);
vrPanel.renderOrder = 100; vrPanel.visible = false;
scene.add(vrPanel);
let vrHideTimer = 0;
vrStatus = (msg, kind) => {
  const c = vrCanvas.getContext('2d');
  c.clearRect(0, 0, 1024, 160);
  c.fillStyle = 'rgba(13,11,20,0.88)'; c.fillRect(0, 0, 1024, 160);
  c.fillStyle = kind === 'error' ? '#ff8a8a' : kind === 'ok' ? '#6fd3a0' : '#e8e2ef';
  c.font = '500 34px "IBM Plex Mono", monospace'; c.textBaseline = 'top';
  const words = msg.split(' '), lines = ['']; 
  for (const w of words) { const t = (lines[lines.length - 1] + ' ' + w).trim(); if (c.measureText(t).width > 980) lines.push(w); else lines[lines.length - 1] = t; }
  lines.slice(0, 3).forEach((l, i) => c.fillText(l, 22, 20 + i * 44));
  vrTex.needsUpdate = true;
  vrPanel.visible = !!msg;
  clearTimeout(vrHideTimer);
  if (kind === 'ok') vrHideTimer = setTimeout(() => { vrPanel.visible = false; }, 6000);
};

function fitCamera() {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  const h = SCREEN_W * 0.75, w = SCREEN_W;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = Math.max(h / (2 * Math.tan(fov / 2)), w / (2 * Math.tan(fov / 2) * camera.aspect)) * 1.1;
  camera.position.set(0, SCREEN_Y, SCREEN_Z + dist);
  camera.lookAt(0, SCREEN_Y, SCREEN_Z);
  camera.updateProjectionMatrix();
}
new ResizeObserver(fitCamera).observe(view);

function showFrame(w, h, rgba, tags, display = null, cw = w, ch = h) {
  const pix = display || rgba;
  if (colorTex.image.width !== cw || colorTex.image.height !== ch) {
    colorTex.dispose();
    colorTex = makeTex(pix, cw, ch, THREE.RGBAFormat);   // rows arrive bottom-up from the worker
    colorTex.magFilter = colorTex.minFilter = THREE.LinearFilter;
    for (const m of sheets) m.material.uniforms.colorTex.value = colorTex;
    dioramaMat.uniforms.colorTex.value = colorTex;
    smoothUniforms.texSize.value.set(cw, ch);
  } else { colorTex.image.data = pix; colorTex.needsUpdate = true; }
  if (tagTex.image.width !== w || tagTex.image.height !== h) {
    tagTex.dispose();
    tagTex = makeTex(tags, w, h, THREE.RedFormat);
    for (const m of sheets) m.material.uniforms.tagTex.value = tagTex;
  } else { tagTex.image.data = tags; tagTex.needsUpdate = true; }
  if (view3d.mode === 'depth') updateOverlays(tags, w, h);
  recogniseScene(w, h, rgba);                      // always on the original pixels
}


// drag to tilt the screen on a flat display, so the depth is visible without a headset
let drag = null, tiltX = 0, tiltY = 0;
const cv = renderer.domElement;
cv.style.touchAction = 'none';
cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, tx: tiltX, ty: tiltY }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => {
  if (!drag) return;
  tiltY = Math.max(-0.8, Math.min(0.8, drag.ty + (e.clientX - drag.x) * 0.005));
  tiltX = Math.max(-0.5, Math.min(0.5, drag.tx + (e.clientY - drag.y) * 0.005));
});
cv.addEventListener('pointerup', () => { drag = null; });
cv.addEventListener('dblclick', () => { tiltX = tiltY = 0; });

$('viewMode').addEventListener('change', (e) => { view3d.mode = e.target.value; saveView(); applyView(); status(MODE_NAMES[view3d.mode], 'ok'); });
$('smoothing').addEventListener('change', (e) => { view3d.smoothing = e.target.value; saveView(); applyView(); });
$('cutouts').addEventListener('change', (e) => { view3d.cutouts = e.target.checked; saveView(); applyView(); });
$('depthStrength').addEventListener('input', (e) => { view3d.strength = +e.target.value; saveView(); applyView(); });
applyView();

/* ------------------------------------------------------------------ input */
const keys = new Set();
const KEYMAP = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  KeyZ: 'A', KeyX: 'B', KeyC: 'C', Enter: 'START', KeyA: 'X', KeyS: 'Y', KeyD: 'Z', ShiftRight: 'MODE' };
addEventListener('keydown', (e) => { if (KEYMAP[e.code] && started) { keys.add(KEYMAP[e.code]); e.preventDefault(); } });
addEventListener('keyup', (e) => { keys.delete(KEYMAP[e.code]); });

const bit = (name) => 1 << SEGA[name];
function stickDirs(x, y, out) {
  const t = 0.5;
  if (y < -t) out.add('UP'); if (y > t) out.add('DOWN');
  if (x < -t) out.add('LEFT'); if (x > t) out.add('RIGHT');
}

let prevStickPress = false, prevRightPress = false, depthDirty = false;
const MODES = ['flat', 'depth', 'layers'];
const MODE_NAMES = { flat: 'View: flat screen', depth: 'View: 3D',
  layers: 'View: layer colours. Blue = plane B, green = plane A, yellow = window/text, orange/pink = sprites, purple = backdrop, grey = unknown' };
function cycleView() {
  view3d.mode = MODES[(MODES.indexOf(view3d.mode) + 1) % MODES.length]; saveView(); applyView();
  status(MODE_NAMES[view3d.mode], 'ok');
}

function readPad() {
  const held = new Set(keys);
  const session = renderer.xr.getSession();
  if (session) {
    // Quest controllers (xr-standard mapping): 0 trigger, 1 grip, 3 stick press, 4 A/X, 5 B/Y
    for (const src of session.inputSources) {
      const gp = src.gamepad; if (!gp) continue;
      const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      if (src.handedness === 'left') {
        stickDirs(gp.axes[2] || 0, gp.axes[3] || 0, held);
        // Snatcher: C = select / shoot, B = cancel, A = draw blaster
        if (b(4)) held.add('A');        // X: draw blaster
        if (b(5)) held.add('START');    // Y
        if (b(0)) held.add('C');        // left trigger: select / shoot
        if (b(3) && !prevStickPress) cycleView();   // left stick click: flat → depth → layer colours
        prevStickPress = b(3);
      } else {
        if (b(3) && !prevRightPress) captureNow();  // right stick click: capture this scene
        prevRightPress = b(3);
        const ry = gp.axes[3] || 0;               // right stick up/down: depth amount
        if (Math.abs(ry) > 0.3) { view3d.strength = Math.max(0, Math.min(1, view3d.strength - ry * 0.008)); applyView(); depthDirty = true; }
        if (b(0)) held.add('C');        // right trigger: select / shoot
        if (b(4)) held.add('C');        // A: select
        if (b(5)) held.add('B');        // B: cancel
        if (b(1)) held.add('START');    // right grip
      }
    }
  } else {
    for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
      if (!gp || gp.mapping !== 'standard') continue;
      const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      if (b(12)) held.add('UP'); if (b(13)) held.add('DOWN'); if (b(14)) held.add('LEFT'); if (b(15)) held.add('RIGHT');
      stickDirs(gp.axes[0], gp.axes[1], held);
      if (b(2)) held.add('A'); if (b(0)) held.add('B'); if (b(1)) held.add('C');
      if (b(3)) held.add('Y'); if (b(9)) held.add('START'); if (b(8)) held.add('MODE');
    }
  }
  let mask = 0; for (const n of held) mask |= bit(n);
  return mask;
}

/* ------------------------------------------------------------------ emulator */
let worker = null, started = false, audioCtx = null, lastMask = -1;

async function startAudio() {
  audioCtx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
  await audioCtx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
  const node = new AudioWorkletNode(audioCtx, 'emu-audio', { outputChannelCount: [2] });
  node.connect(audioCtx.destination);
  const ch = new MessageChannel();
  node.port.postMessage(ch.port1, [ch.port1]);
  return ch.port2;
}

async function start() {
  if (started) return;
  started = true; refreshLibrary();
  status('Starting…');
  try {
    const audioPort = await startAudio();   // must happen inside the click
    const bios = await store.loadBiosBytes();
    const { entry, source } = await store.discSource();
    worker = new Worker(new URL('./emu-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorker;
    worker.onerror = (e) => status('The emulator stopped: ' + (e.message || 'unknown error'), 'error');
    worker.postMessage({ type: 'start', bios, disc: source, entry, audioPort }, [audioPort, bios.buffer]);
  } catch (err) { started = false; refreshLibrary(); status(err.message, 'error'); }
}

function onWorker(e) {
  const m = e.data;
  if (m.type === 'frame') {
    showFrame(m.w, m.h, m.rgba, m.tags, m.display || null, m.cw || m.w, m.ch || m.h);
    const saving = captures.frame(m.w, m.h, m.rgba, m.tags);
    if (saving) saving.then((id) => id && status(`Captured ${id}`, 'ok')).catch((err) => status('Capture failed: ' + err.message, 'error'));
  }
  else if (m.type === 'started') {
    worker.postMessage({ type: 'smooth', scale: view3d.smoothing === 'smooth' ? 4 : 1 }); status('Running. Keyboard: arrows, Z/X/C, Enter. In VR, see the button guide.', 'ok'); document.body.dataset.running = '1'; }
  else if (m.type === 'error') { status(m.msg, 'error'); }
  else if (m.type === 'log') { console.log(m.msg); }
  else if (m.type === 'state') store.writeState(m.slot, m.data).then(() => status('State saved.', 'ok'));
  else if (m.type === 'stateLoaded') status(m.ok ? 'State loaded.' : 'That save state could not be loaded.', m.ok ? 'ok' : 'error');
}

$('play').addEventListener('click', start);
$('saveState').addEventListener('click', () => worker && worker.postMessage({ type: 'saveState', slot: 1 }));
$('loadState').addEventListener('click', async () => {
  if (!worker) return;
  const s = await store.readState(1);
  if (!s) return status('No save state yet.', 'error');
  worker.postMessage({ type: 'loadState', data: s.buffer }, [s.buffer]);
});
$('reset').addEventListener('click', () => worker && worker.postMessage({ type: 'reset' }));
document.addEventListener('visibilitychange', () => {
  if (!worker) return;
  worker.postMessage({ type: document.hidden ? 'pause' : 'resume' });
  if (audioCtx) document.hidden ? audioCtx.suspend() : audioCtx.resume();
});

/* ------------------------------------------------------------------ captures */
const captures = new Captures({ onChange: (n) => {
  $('captureCount').textContent = n === 1 ? '1 scene saved' : `${n} scenes saved`;
  $('downloadCaptures').disabled = $('clearCaptures').disabled = n === 0;
} });
captures.load();
try { captures.auto = localStorage.getItem('snatcher-vr.autocapture') === '1'; } catch {}
$('autoCapture').checked = captures.auto;
$('autoCapture').addEventListener('change', (e) => {
  captures.auto = e.target.checked;
  try { localStorage.setItem('snatcher-vr.autocapture', captures.auto ? '1' : '0'); } catch {}
});
async function captureNow() {
  if (!worker) return status('Start the game first, then capture.', 'error');
  try { const id = await captures.captureNow(); if (id) status(`Captured ${id}`, 'ok'); }
  catch (err) { status('Capture failed: ' + err.message, 'error'); }
}
$('captureNow').addEventListener('click', captureNow);
$('downloadCaptures').addEventListener('click', async () => {
  status('Packing captures…');
  const blob = await captures.zip();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'snatcher-captures.zip';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  status(`Downloaded snatcher-captures.zip (${Math.round(blob.size / 1024)} KB).`, 'ok');
});
let clearArmed = 0;
$('clearCaptures').addEventListener('click', async () => {
  const btn = $('clearCaptures');
  if (Date.now() - clearArmed > 4000) { clearArmed = Date.now(); btn.textContent = 'Tap again to delete'; setTimeout(() => { btn.textContent = 'Delete all'; }, 4000); return; }
  clearArmed = 0; btn.textContent = 'Delete all';
  await captures.clear(); status('Captures deleted.', 'ok');
});

/* ------------------------------------------------------------------ VR */
const vrBtn = $('vr');
if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    vrSupported = ok; vrBtn.textContent = ok ? 'Enter VR' : 'VR not available on this device'; updateButtons();
  });
} else vrBtn.textContent = 'VR not available on this device';

vrBtn.addEventListener('click', async () => {
  if (renderer.xr.isPresenting) return;            // already in VR
  try {
    if (!started) await start();
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    if (audioCtx) audioCtx.resume();
  } catch (err) { status('Could not start VR: ' + err.message, 'error'); }
});

/* ------------------------------------------------------------------ loop */
renderer.setAnimationLoop(() => {
  if (worker) {
    const mask = readPad();
    if (mask !== lastMask) { lastMask = mask; worker.postMessage({ type: 'pad', mask }); }
  }
  const target = diorama.visible ? view3d.strength : 0;
  dioramaMat.uniforms.amount.value += (target - dioramaMat.uniforms.amount.value) * 0.12;
  if (depthDirty && !renderer.xr.isPresenting) { depthDirty = false; saveView(); }
  if (!renderer.xr.isPresenting) { screen.rotation.x += (tiltX - screen.rotation.x) * 0.15; screen.rotation.y += (tiltY - screen.rotation.y) * 0.15; }
  else screen.rotation.set(0, 0, 0);
  renderer.render(scene, camera);
});

fitCamera();
refreshLibrary();
window.__snatcherVR = { showFrame, depthLib, view3d, applyView, localGen, overlayCells: () => overlayCells };
if (crashedLastTime) status('The browser closed while making a 3D map last time, so making maps on the headset has been switched off. Scenes that already have maps still work.', 'error');
if (!store.hasOPFS) status('This browser cannot keep files between visits, so you will need to pick them each time.', 'error');
