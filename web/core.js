// Wraps core.wasm (Genesis Plus GX) behind a small JS API.
import { VFS, createWasi } from './wasi.js';

// Sega pad buttons → libretro joypad bit positions
export const PAD = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };
// Genesis Plus GX maps libretro B→Sega A, A→Sega B, Y→Sega C... we expose Sega names:
export const SEGA = { A: PAD.Y, B: PAD.B, C: PAD.A, X: PAD.L, Y: PAD.X, Z: PAD.R, MODE: PAD.SELECT,
  START: PAD.START, UP: PAD.UP, DOWN: PAD.DOWN, LEFT: PAD.LEFT, RIGHT: PAD.RIGHT };

export class Core {
  static async create(wasmBytes, { log } = {}) {
    const c = new Core();
    c.vfs = new VFS();
    c.wasi = createWasi(c.vfs, { log: log || console.log });
    const { instance } = await WebAssembly.instantiate(wasmBytes, c.wasi.imports);
    c.x = instance.exports;
    c.wasi.setMemory(c.x.memory);
    c.x._initialize();
    c.x.g_init();
    return c;
  }
  get mem() { return this.x.memory.buffer; }

  load(path) {
    const enc = new TextEncoder().encode(path + '\0');
    new Uint8Array(this.mem, this.x.g_path_buf(), enc.length).set(enc);
    if (!this.x.g_load()) throw new Error('The core could not load ' + path);
    this.sampleRate = this.x.g_sample_rate();
    this.fps = this.x.g_fps();
  }
  run() { this.x.g_run(); }
  reset() { this.x.g_reset(); }

  // RGB565 frame (copied) + size
  frame() {
    const w = this.x.g_fb_w(), h = this.x.g_fb_h();
    return { w, h, rgb565: new Uint16Array(this.mem, this.x.g_fb(), w * h).slice() };
  }
  // interleaved stereo int16 produced by the last run()
  audio() {
    const n = this.x.g_audio_frames();
    return new Int16Array(this.mem, this.x.g_audio(), n * 2).slice();
  }
  setPad(port, mask) { this.x.g_set_pad(port, mask); }
  // x,y in 0..1 screen space; buttons bit0 trigger, bit1 A, bit2 B, bit3 start
  setGun(x, y, buttons, offscreen = false) {
    const s = v => Math.round(Math.max(-1, Math.min(1, v * 2 - 1)) * 0x7fff);
    this.x.g_set_gun(s(x), s(y), buttons, offscreen ? 1 : 0);
  }
  setDevice(port, id) { this.x.g_set_device(port, id); }

  saveState() {
    const n = this.x.g_state_size(), p = this.x.g_malloc(n);
    try { if (!this.x.g_state_save(p, n)) throw new Error('save failed'); return new Uint8Array(this.mem, p, n).slice(); }
    finally { this.x.g_free(p); }
  }
  loadState(buf) {
    const p = this.x.g_malloc(buf.length);
    try { new Uint8Array(this.mem, p, buf.length).set(buf); return !!this.x.g_state_load(p, buf.length); }
    finally { this.x.g_free(p); }
  }
}
