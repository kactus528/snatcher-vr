// Keeps the BIOS and disc image in the browser's private file storage (OPFS)
// so they only have to be picked once. Falls back to in-memory File objects
// for this visit if OPFS isn't available.

const META_KEY = 'snatcher-vr.library';
const memory = { bios: null, disc: null };

function readMeta() { try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch { return {}; } }
function writeMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch {} }

export const hasOPFS = !!(navigator.storage && navigator.storage.getDirectory);

async function root() { return navigator.storage.getDirectory(); }

async function copyInto(dir, file, onProgress) {
  const fh = await dir.getFileHandle(file.name, { create: true });
  const w = await fh.createWritable();
  let done = 0;
  const counter = new TransformStream({ transform(chunk, ctl) { done += chunk.byteLength; onProgress && onProgress(done); ctl.enqueue(chunk); } });
  await file.stream().pipeThrough(counter).pipeTo(w);
}

export async function library() {
  const m = readMeta();
  return { bios: memory.bios ? memory.bios.name : m.bios || null, disc: memory.disc ? memory.disc : m.disc || null };
}

export async function saveBios(file) {
  if (file.size < 65536 || file.size > 1048576) throw new Error(`${file.name} doesn't look like a Sega CD BIOS (expected about 128 KB, got ${Math.round(file.size / 1024)} KB).`);
  if (hasOPFS) {
    const dir = await (await root()).getDirectoryHandle('bios', { create: true });
    for await (const name of dir.keys()) await dir.removeEntry(name);
    await copyInto(dir, file);
    writeMeta({ ...readMeta(), bios: file.name });
  } else memory.bios = file;
}

export async function loadBiosBytes() {
  if (memory.bios) return new Uint8Array(await memory.bios.arrayBuffer());
  const name = readMeta().bios; if (!name) throw new Error('Pick a Sega CD BIOS file first.');
  const dir = await (await root()).getDirectoryHandle('bios');
  return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
}

// Work out which file the core should open and check a .cue's tracks are all present.
export async function planDisc(files) {
  const by = (ext) => files.find(f => f.name.toLowerCase().endsWith(ext));
  const cue = by('.cue'), chd = by('.chd'), iso = by('.iso'), bin = by('.bin');
  const entry = cue || chd || iso || bin;
  if (!entry) throw new Error('Pick the disc image: a .cue with its .bin files, or a single .chd.');
  if (cue) {
    const text = await cue.text();
    const names = [...text.matchAll(/FILE\s+"?([^"\r\n]+?)"?\s+\w+\s*$/gim)].map(m => m[1].trim());
    const have = new Set(files.map(f => f.name.toLowerCase()));
    const missing = names.filter(n => !have.has(n.split(/[\\/]/).pop().toLowerCase()));
    if (missing.length) throw new Error(`The .cue lists files you didn't select: ${missing.join(', ')}. Select the .cue and all of its .bin tracks together.`);
  }
  return { entry: entry.name, names: files.map(f => f.name), total: files.reduce((s, f) => s + f.size, 0) };
}

export async function saveDisc(files, onProgress) {
  const plan = await planDisc(files);
  if (hasOPFS) {
    try { await navigator.storage.persist(); } catch {}
    const r = await root();
    try { await r.removeEntry('disc', { recursive: true }); } catch {}
    const dir = await r.getDirectoryHandle('disc', { create: true });
    let base = 0;
    for (const f of files) { await copyInto(dir, f, n => onProgress && onProgress((base + n) / plan.total)); base += f.size; }
    writeMeta({ ...readMeta(), disc: { entry: plan.entry, names: plan.names } });
  } else memory.disc = { entry: plan.entry, names: plan.names, files };
  return plan;
}

// What the worker needs to open the disc
export async function discSource() {
  if (memory.disc) return { entry: memory.disc.entry, source: { kind: 'files', files: memory.disc.files } };
  const d = readMeta().disc; if (!d) throw new Error('Pick the Snatcher disc image first.');
  return { entry: d.entry, source: { kind: 'opfs', names: d.names } };
}

// Save states: one file per slot in OPFS
export async function writeState(slot, bytes) {
  if (!hasOPFS) { memory['state' + slot] = bytes; return; }
  const dir = await (await root()).getDirectoryHandle('states', { create: true });
  const w = await (await dir.getFileHandle(`slot${slot}.state`, { create: true })).createWritable();
  await w.write(bytes); await w.close();
}
export async function readState(slot) {
  if (!hasOPFS) return memory['state' + slot] || null;
  try {
    const dir = await (await root()).getDirectoryHandle('states');
    return new Uint8Array(await (await (await dir.getFileHandle(`slot${slot}.state`)).getFile()).arrayBuffer());
  } catch { return null; }
}
