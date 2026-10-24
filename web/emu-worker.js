// Runs the emulator off the main thread so the headset's frame rate never
// waits on emulation. Posts RGBA frames to the page and audio straight to
// the AudioWorklet through a transferred MessagePort.
import { Core } from './core.js';
import { VFS } from './wasi.js';

let core = null, audioPort = null, running = false;
let pad = 0, gun = null;
let opfsSaveDir = null;
const syncHandles = [];

const log = (msg) => postMessage({ type: 'log', msg });
const fail = (msg) => postMessage({ type: 'error', msg });

async function openDisc(source) {
  // source: { kind: 'opfs', names: [...] } or { kind: 'files', files: [File] }
  if (source.kind === 'opfs') {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('disc');
    for (const name of source.names) {
      const fh = await dir.getFileHandle(name);
      const h = await fh.createSyncAccessHandle();
      syncHandles.push(h);
      const size = h.getSize();
      core.vfs.addReader('/disc/' + name, size, (pos, len) => {
        const buf = new Uint8Array(len); const n = h.read(buf, { at: pos }); return buf.subarray(0, n);
      });
    }
  } else {
    for (const f of source.files) core.vfs.addReader('/disc/' + f.name, f.size, VFS.blobReader(f));
  }
}

async function loadSaves() {
  try {
    const root = await navigator.storage.getDirectory();
    opfsSaveDir = await root.getDirectoryHandle('save', { create: true });
    for await (const [name, handle] of opfsSaveDir.entries()) {
      if (handle.kind !== 'file') continue;
      const buf = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      core.vfs.addBytes('/save/' + name, buf);
    }
  } catch { opfsSaveDir = null; }
}

async function persistSaves() {
  if (!core) return;
  core.x.g_flush_saves();
  if (!opfsSaveDir) return;
  for (const [path, entry] of core.vfs.files) {
    if (!path.startsWith('/save/') || !entry.dirty) continue;
    entry.dirty = false;
    const fh = await opfsSaveDir.getFileHandle(path.slice(6), { create: true });
    const h = await fh.createSyncAccessHandle();
    h.truncate(0); h.write(entry.data.subarray(0, entry.size), { at: 0 }); h.flush(); h.close();
  }
}

function toRGBA(f) {
  const out = new Uint8ClampedArray(f.w * f.h * 4);
  const src = f.rgb565;
  // rows are written bottom-up so the texture needs no flip on the GPU
  for (let i = 0; i < src.length; i++) {
    const x = i % f.w, y = (i / f.w) | 0;
    const j = ((f.h - 1 - y) * f.w + x) * 4;
    const p = src[i];
    out[j] = ((p >> 11) & 31) * 255 / 31;
    out[j + 1] = ((p >> 5) & 63) * 255 / 63;
    out[j + 2] = (p & 31) * 255 / 31;
    out[j + 3] = 255;
  }
  return out;
}

let last = 0, debt = 0, lastFrameCount = 0, saveTimer = 0;
function tick() {
  if (!running) return;
  const now = performance.now();
  debt += (now - last) * core.fps / 1000; last = now;
  if (debt > 4) debt = 1;                         // fell behind (tab hidden etc.): don't spiral
  let ran = 0;
  while (debt >= 1 && ran < 3) {
    core.setPad(0, pad);
    if (gun) core.setGun(gun.x, gun.y, gun.buttons, gun.offscreen);
    core.run(); debt -= 1; ran++;
    const a = core.audio();
    if (audioPort && a.length) audioPort.postMessage(a, [a.buffer]);
  }
  const fc = core.x.g_frames();
  if (ran && fc !== lastFrameCount) {
    lastFrameCount = fc;
    const f = core.frame();
    const rgba = toRGBA(f);
    postMessage({ type: 'frame', w: f.w, h: f.h, rgba }, [rgba.buffer]);
  }
  if (now - saveTimer > 5000) { saveTimer = now; persistSaves().catch(() => {}); }
  setTimeout(tick, 2);
}

onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'start': {
        audioPort = m.audioPort || null;
        const wasm = await (await fetch(new URL('./core.wasm', import.meta.url))).arrayBuffer();
        core = await Core.create(wasm, { log });
        // one BIOS file stored under every region name; the core picks by disc region
        for (const n of ['bios_CD_U.bin', 'bios_CD_E.bin', 'bios_CD_J.bin']) core.vfs.addBytes('/sys/' + n, m.bios);
        await loadSaves();
        await openDisc(m.disc);
        core.load('/disc/' + m.entry);
        postMessage({ type: 'started', fps: core.fps, sampleRate: core.sampleRate });
        running = true; last = performance.now(); debt = 0; tick();
        break;
      }
      case 'pad': pad = m.mask; break;
      case 'gun': gun = m.gun; break;
      case 'reset': core && core.reset(); break;
      case 'pause': running = false; await persistSaves(); break;
      case 'resume': if (core && !running) { running = true; last = performance.now(); tick(); } break;
      case 'saveState': {
        const s = core.saveState();
        postMessage({ type: 'state', slot: m.slot, data: s }, [s.buffer]);
        break;
      }
      case 'loadState': postMessage({ type: 'stateLoaded', ok: core.loadState(new Uint8Array(m.data)) }); break;
      case 'flush': await persistSaves(); postMessage({ type: 'flushed' }); break;
    }
  } catch (err) { fail(err.message || String(err)); }
};
