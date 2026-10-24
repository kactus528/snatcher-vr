import * as THREE from 'three';
import * as store from './storage.js';
import { SEGA } from './core.js';

const $ = (id) => document.getElementById(id);
const status = (msg, kind = '') => { const s = $('status'); s.textContent = msg; s.dataset.kind = kind; };

/* ------------------------------------------------------------------ library */
async function refreshLibrary() {
  const lib = await store.library();
  $('biosState').textContent = lib.bios || 'Not added yet';
  $('biosState').dataset.ok = !!lib.bios;
  $('discState').textContent = lib.disc ? `${lib.disc.entry}${lib.disc.names.length > 1 ? ` + ${lib.disc.names.length - 1} track files` : ''}` : 'Not added yet';
  $('discState').dataset.ok = !!lib.disc;
  $('play').disabled = !(lib.bios && lib.disc) || started;
}

$('biosFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await store.saveBios(f); status('BIOS saved.', 'ok'); } catch (err) { status(err.message, 'error'); }
  e.target.value = ''; refreshLibrary();
});
$('discFiles').addEventListener('change', async (e) => {
  const files = [...e.target.files]; if (!files.length) return;
  try {
    await store.saveDisc(files, (p) => status(`Copying disc into the browser… ${Math.round(p * 100)}%`));
    status('Disc saved. You only have to do this once.', 'ok');
  } catch (err) { status(err.message, 'error'); }
  e.target.value = ''; refreshLibrary();
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

const view3d = { mode: 'depth', strength: 0.3 }; // mode: flat | depth | layers
try { Object.assign(view3d, JSON.parse(localStorage.getItem('snatcher-vr.view')) || {}); } catch {}
const saveView = () => { try { localStorage.setItem('snatcher-vr.view', JSON.stringify(view3d)); } catch {} };

function makeTex(data, w, h, format) {
  const t = new THREE.DataTexture(data, w, h, format);
  t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
let colorTex = makeTex(new Uint8Array([20, 18, 30, 255]), 1, 1, THREE.RGBAFormat);
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
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D colorTex; uniform sampler2D tagTex;
      uniform float tagMask[16]; uniform float full; uniform vec3 tint; uniform float showTint;
      varying vec2 vUv;
      float inGroup(float t){
        float m = 0.0;
        for (int i = 0; i < 16; i++) { float id = (i == 15) ? 255.0 : float(i); if (abs(t - id) < 0.5) m = tagMask[i]; }
        return m;
      }
      void main(){
        float t = floor(texture2D(tagTex, vUv).r * 255.0 + 0.5);
        if (full < 0.5 && inGroup(t) < 0.5) discard;
        vec4 c = texture2D(colorTex, vUv);
        if (showTint > 0.5) c.rgb = mix(c.rgb, tint, (full > 0.5 && inGroup(t) < 0.5) ? 0.0 : 0.55);
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

function applyView() {
  sheets.forEach((m, i) => {
    const g = GROUPS[i];
    m.visible = view3d.mode !== 'flat' || g.full;
    m.position.z = view3d.mode === 'flat' ? 0 : g.depth * view3d.strength;
    m.material.uniforms.showTint.value = view3d.mode === 'layers' ? 1 : 0;
  });
  $('viewMode').value = view3d.mode;
  $('depthStrength').value = view3d.strength;
  $('depthVal').textContent = Math.round(view3d.strength * 100) + ' cm';
}

// faint floor grid so VR has a sense of space
const grid = new THREE.GridHelper(20, 40, 0x2a2238, 0x16121f);
scene.add(grid);

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

function showFrame(w, h, rgba, tags) {
  if (colorTex.image.width !== w || colorTex.image.height !== h) {
    colorTex.dispose(); tagTex.dispose();
    colorTex = makeTex(rgba, w, h, THREE.RGBAFormat);   // rows arrive bottom-up from the worker
    tagTex = makeTex(tags, w, h, THREE.RedFormat);
    for (const m of sheets) { m.material.uniforms.colorTex.value = colorTex; m.material.uniforms.tagTex.value = tagTex; }
  } else {
    colorTex.image.data = rgba; colorTex.needsUpdate = true;
    tagTex.image.data = tags; tagTex.needsUpdate = true;
  }
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

$('viewMode').addEventListener('change', (e) => { view3d.mode = e.target.value; saveView(); applyView(); });
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

let prevStickPress = false, depthDirty = false;
const MODES = ['flat', 'depth', 'layers'];
function cycleView() { view3d.mode = MODES[(MODES.indexOf(view3d.mode) + 1) % MODES.length]; saveView(); applyView(); }

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
        if (b(4)) held.add('C');        // X
        if (b(5)) held.add('START');    // Y
        if (b(0)) held.add('A');        // left trigger
        if (b(3) && !prevStickPress) cycleView();   // left stick click: flat → depth → layer colours
        prevStickPress = b(3);
      } else {
        const ry = gp.axes[3] || 0;               // right stick up/down: depth amount
        if (Math.abs(ry) > 0.3) { view3d.strength = Math.max(0, Math.min(1, view3d.strength - ry * 0.008)); applyView(); depthDirty = true; }
        if (b(0)) held.add('A');        // right trigger
        if (b(4)) held.add('B');        // A
        if (b(5)) held.add('C');        // B
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
  if (m.type === 'frame') showFrame(m.w, m.h, m.rgba, m.tags);
  else if (m.type === 'started') { status('Running. Keyboard: arrows, Z/X/C, Enter. In VR, see the button guide.', 'ok'); document.body.dataset.running = '1'; }
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

/* ------------------------------------------------------------------ VR */
const vrBtn = $('vr');
if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    vrBtn.disabled = !ok; vrBtn.textContent = ok ? 'Enter VR' : 'VR not available on this device';
  });
} else vrBtn.textContent = 'VR not available on this device';

vrBtn.addEventListener('click', async () => {
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
  if (depthDirty && !renderer.xr.isPresenting) { depthDirty = false; saveView(); }
  if (!renderer.xr.isPresenting) { screen.rotation.x += (tiltX - screen.rotation.x) * 0.15; screen.rotation.y += (tiltY - screen.rotation.y) * 0.15; }
  else screen.rotation.set(0, 0, 0);
  renderer.render(scene, camera);
});

fitCamera();
refreshLibrary();
if (!store.hasOPFS) status('This browser cannot keep files between visits, so you will need to pick them each time.', 'error');
