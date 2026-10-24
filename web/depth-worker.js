// Runs Depth Anything V2 (small) with ONNX Runtime Web, off the main thread.
// The model (~95 MB) is downloaded once and kept in the browser's storage.
/* global ort */
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
try { importScripts(ORT + 'ort.webgpu.min.js'); }        // GPU + CPU
catch { importScripts(ORT + 'ort.min.js'); }             // CPU only
ort.env.wasm.wasmPaths = ORT;
ort.env.wasm.numThreads = 1;          // GitHub Pages can't enable shared-memory threads

const MODEL_URL = new URL('./models/depth_anything_v2_vits.onnx', self.location.href).href;
const MODEL_FILE = 'depth_anything_v2_vits.onnx';
let session = null, backend = '';

// Download straight into storage (never holding the whole file twice in memory),
// then read it back once for the runtime.
async function modelBytes() {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('models', { create: true });
  const cached = async () => {
    try { const f = await (await dir.getFileHandle(MODEL_FILE)).getFile(); return f.size > 1e6 ? f : null; } catch { return null; }
  };
  let file = await cached();
  if (!file) {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`Couldn't download the depth model (HTTP ${res.status}).`);
    const total = +res.headers.get('content-length') || 0;
    const tmp = await dir.getFileHandle(MODEL_FILE + '.part', { create: true });
    const w = await tmp.createWritable();
    let got = 0, lastPost = 0;
    await res.body.pipeThrough(new TransformStream({ transform(chunk, ctl) {
      got += chunk.length;
      if (total && Date.now() - lastPost > 400) { lastPost = Date.now(); postMessage({ type: 'progress', fraction: got / total }); }
      ctl.enqueue(chunk);
    } })).pipeTo(w);
    // finished download: give it its real name
    const done = await dir.getFileHandle(MODEL_FILE, { create: true });
    const w2 = await done.createWritable();
    await (await tmp.getFile()).stream().pipeTo(w2);
    await dir.removeEntry(MODEL_FILE + '.part');
    file = await cached();
  }
  return new Uint8Array(await file.arrayBuffer());
}

let forceCPU = false, useGPU = false;
async function load() {
  if (session) return;
  let bytes = await modelBytes();
  postMessage({ type: 'progress', fraction: 1 });
  // CPU by default: on a Quest 2 the GPU shares the headset's memory with the game
  for (const ep of (forceCPU || !useGPU ? ['wasm'] : ['webgpu', 'wasm'])) {
    try {
      if (ep === 'webgpu' && !(self.navigator.gpu && await self.navigator.gpu.requestAdapter())) continue;
      session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      backend = ep; break;
    } catch (e) { session = null; }
  }
  bytes = null;                                   // the runtime has its own copy now
  if (!session) throw new Error('The depth model could not start on this device.');
  postMessage({ type: 'ready', backend });
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') { await load(); return; }
    if (m.type === 'infer') {
      useGPU = !!m.useGPU;
      await load();
      const t0 = performance.now();
      const input = new ort.Tensor('float32', m.input, [1, 3, m.size, m.size]);
      let out;
      try { out = await session.run({ [session.inputNames[0]]: input }); }
      catch (err) {
        if (backend !== 'webgpu') throw err;
        // the GPU path failed on this device: switch to the CPU for good and retry
        forceCPU = true; session = null; await load();
        out = await session.run({ [session.inputNames[0]]: input });
      }
      const data = out[session.outputNames[0]].data;
      const result = new Float32Array(data);              // copy out of the runtime's memory
      postMessage({ type: 'result', id: m.id, output: result, ms: Math.round(performance.now() - t0), backend }, [result.buffer]);
    }
  } catch (err) { postMessage({ type: 'error', id: m.id, msg: err.message || String(err) }); }
};
