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
  if (!entry) throw new Error('Pick the disc image: a .zip of the disc folder, a .cue with all its .bin files, or a single .chd.');
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
  // A single .zip (handy on the Quest, whose file picker takes one file at a time)
  if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) return saveDiscZip(files[0], onProgress);
  const plan = await planDisc(files);
  if (hasOPFS) {
    try { await navigator.storage.persist(); } catch {}
    const dir = await freshDiscDir();
    let base = 0;
    for (const f of files) { await copyInto(dir, f, n => onProgress && onProgress((base + n) / plan.total)); base += f.size; }
    writeMeta({ ...readMeta(), disc: { entry: plan.entry, names: plan.names } });
  } else memory.disc = { entry: plan.entry, names: plan.names, files };
  return plan;
}

async function freshDiscDir() {
  const r = await root();
  try { await r.removeEntry('disc', { recursive: true }); } catch {}
  return r.getDirectoryHandle('disc', { create: true });
}

/* ---- .zip support: read the central directory, then stream each disc file
   (stored or deflated) straight into OPFS without holding it in memory ---- */
const DISC_EXT = /\.(cue|bin|chd|iso)$/i;

async function zipEntries(zip) {
  const tailLen = Math.min(zip.size, 65557);
  const tail = new DataView(await zip.slice(zip.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error(`${zip.name} isn't a zip file the page can read.`);
  let count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) {
    // Zip64: find the zip64 end record through its locator just before the EOCD
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error(`${zip.name} uses a zip format the page can't read.`);
    const z64 = Number(tail.getBigUint64(loc + 8, true));
    const rec = new DataView(await zip.slice(z64, z64 + 56).arrayBuffer());
    count = Number(rec.getBigUint64(32, true)); cdSize = Number(rec.getBigUint64(40, true)); cdOff = Number(rec.getBigUint64(48, true));
  }
  const cd = new DataView(await zip.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = [];
  for (let p = 0, n = 0; n < count; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error(`${zip.name} looks damaged.`);
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    let local = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    // zip64 extra field holds the real sizes/offset when the 32-bit ones are maxed out
    for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end;) {
      const id = cd.getUint16(e, true), len = cd.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) { local = Number(cd.getBigUint64(q, true)); }
      }
      e += 4 + len;
    }
    out.push({ name, method, csize, usize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function saveDiscZip(zip, onProgress) {
  if (!hasOPFS) throw new Error('This browser cannot store a zipped disc. Select the .cue and .bin files instead.');
  const all = await zipEntries(zip);
  const entries = all.filter(e => DISC_EXT.test(e.name) && !e.name.endsWith('/'));
  if (!entries.length) throw new Error(`${zip.name} has no .cue, .bin or .chd files in it.`);
  for (const e of entries) if (e.method !== 0 && e.method !== 8)
    throw new Error(`${e.name.split('/').pop()} in the zip uses a compression type the page can't unpack. Re-zip it with Windows "Send to → Compressed (zipped) folder".`);
  // check the .cue against the zip's contents before touching the stored disc
  const cueEntry = entries.find(e => /\.cue$/i.test(e.name));
  const fakeFiles = await Promise.all(entries.map(async e => {
    const name = e.name.split('/').pop();
    if (e !== cueEntry) return { name, size: e.usize, text: async () => '' };
    const text = await new Response(entryStream(zip, e, await dataStart(zip, e))).text();
    return { name, size: e.usize, text: async () => text };
  }));
  let plan;
  try { plan = await planDisc(fakeFiles); }
  catch (err) { throw new Error(err.message.replace("you didn't select", 'missing from the zip').replace(' Select the .cue and all of its .bin tracks together.', ' Zip the .cue together with all of its .bin tracks.')); }

  try { await navigator.storage.persist(); } catch {}
  writeMeta({ ...readMeta(), disc: null });            // nothing usable until the unpack finishes
  const dir = await freshDiscDir();
  const total = entries.reduce((s, e) => s + e.usize, 0);
  let base = 0;
  for (const e of entries) {
    const fh = await dir.getFileHandle(e.name.split('/').pop(), { create: true });
    const w = await fh.createWritable();
    let done = 0;
    await entryStream(zip, e, await dataStart(zip, e))
      .pipeThrough(new TransformStream({ transform(c, ctl) { done += c.byteLength; onProgress && onProgress((base + done) / total); ctl.enqueue(c); } }))
      .pipeTo(w);
    base += e.usize;
  }
  writeMeta({ ...readMeta(), disc: { entry: plan.entry, names: plan.names } });
  return plan;
}

async function dataStart(zip, e) {
  const head = new DataView(await zip.slice(e.local, e.local + 30).arrayBuffer());
  if (head.getUint32(0, true) !== 0x04034b50) throw new Error(`${zip.name} looks damaged.`);
  return e.local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
}
function entryStream(zip, e, start) {
  const raw = zip.slice(start, start + e.csize).stream();
  return e.method === 8 ? raw.pipeThrough(new DecompressionStream('deflate-raw')) : raw;
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
