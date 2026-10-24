// Ring buffer player. The emulator worker sends interleaved int16 stereo
// chunks through a MessagePort; this plays them, padding with silence on
// underrun and dropping the oldest audio if latency builds up.
class EmuAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 16384;                         // stereo frames
    this.l = new Float32Array(this.size); this.r = new Float32Array(this.size);
    this.read = 0; this.write = 0; this.count = 0;
    this.maxLatency = 4096;                    // ~93 ms at 44.1 kHz
    this.port.onmessage = (e) => {
      if (e.data instanceof MessagePort) { e.data.onmessage = (m) => this.push(m.data); return; }
    };
  }
  push(s) {
    const n = s.length >> 1;
    for (let i = 0; i < n; i++) {
      this.l[this.write] = s[i * 2] / 32768; this.r[this.write] = s[i * 2 + 1] / 32768;
      this.write = (this.write + 1) % this.size;
    }
    this.count += n;
    if (this.count > this.maxLatency) { const drop = this.count - this.maxLatency / 2; this.read = (this.read + drop) % this.size; this.count -= drop; }
  }
  process(_, outputs) {
    const [L, R] = outputs[0];
    for (let i = 0; i < L.length; i++) {
      if (this.count > 0) { L[i] = this.l[this.read]; R[i] = this.r[this.read]; this.read = (this.read + 1) % this.size; this.count--; }
      else { L[i] = R[i] = 0; }
    }
    return true;
  }
}
registerProcessor('emu-audio', EmuAudio);
