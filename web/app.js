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

// The game screen. Later steps swap this flat plane for the depth diorama.
const SCREEN_W = 2.4;
let tex = new THREE.DataTexture(new Uint8Array([20, 18, 30, 255]), 1, 1);
tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace;
const screenMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), screenMat);
screen.scale.set(SCREEN_W, SCREEN_W * 0.75, 1);
screen.position.set(0, 1.5, -2.2);
scene.add(screen);

// faint floor grid so VR has a sense of space
const grid = new THREE.GridHelper(20, 40, 0x2a2238, 0x16121f);
scene.add(grid);

function fitCamera() {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  const h = screen.scale.y, w = screen.scale.x;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = Math.max(h / (2 * Math.tan(fov / 2)), w / (2 * Math.tan(fov / 2) * camera.aspect)) * 1.06;
  camera.position.set(0, 1.5, -2.2 + dist);
  camera.lookAt(0, 1.5, -2.2);
  camera.updateProjectionMatrix();
}
new ResizeObserver(fitCamera).observe(view);

function showFrame(w, h, rgba) {
  if (tex.image.width !== w || tex.image.height !== h) {
    tex.dispose();
    tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;   // rows arrive bottom-up from the worker
    screenMat.map = tex; screenMat.needsUpdate = true;
    screen.scale.set(SCREEN_W, SCREEN_W * 0.75, 1); // shown at 4:3 whether the game runs 256 or 320 wide
    fitCamera();
  } else { tex.image.data = rgba; }
  tex.needsUpdate = true;
}

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
      } else {
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
  if (m.type === 'frame') showFrame(m.w, m.h, m.rgba);
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
  renderer.render(scene, camera);
});

fitCamera();
refreshLibrary();
if (!store.hasOPFS) status('This browser cannot keep files between visits, so you will need to pick them each time.', 'error');
