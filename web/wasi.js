// Minimal WASI implementation for the emulator core.
// Files live in a virtual filesystem: each entry is either a Uint8Array
// (small files: BIOS, saves) or a reader object for big disc images that
// reads byte ranges synchronously (OPFS sync access handle or FileReaderSync).

const ERRNO = { SUCCESS: 0, BADF: 8, INVAL: 28, NOENT: 44, NOSYS: 52 };

export class VFS {
  constructor() { this.files = new Map(); }       // path -> entry
  norm(p) { return '/' + p.replace(/^\/+/, '').toLowerCase(); }
  addBytes(path, bytes) { this.files.set(this.norm(path), { kind: 'mem', data: bytes, size: bytes.length }); }
  addReader(path, size, readAt) { this.files.set(this.norm(path), { kind: 'reader', size, readAt }); }
  get(path) { return this.files.get(this.norm(path)); }
  // Blob-backed reader for workers (FileReaderSync) — no copy into memory.
  static blobReader(blob) {
    const frs = new FileReaderSync();
    return (pos, len) => new Uint8Array(frs.readAsArrayBuffer(blob.slice(pos, pos + len)));
  }
}

export function createWasi(vfs, { log = console.log } = {}) {
  let mem = null;
  const fds = new Map(); // fd -> { entry, pos, path }
  let nextFd = 4;        // 3 = preopened "/"
  const view = () => new DataView(mem.buffer);
  const bytes = () => new Uint8Array(mem.buffer);
  const dec = new TextDecoder();
  let stdoutBuf = '';

  function readStr(ptr, len) { return dec.decode(bytes().subarray(ptr, ptr + len)); }

  // read up to `len` bytes from an entry at `pos`
  function readEntry(entry, pos, len) {
    len = Math.max(0, Math.min(len, entry.size - pos));
    if (!len) return new Uint8Array(0);
    if (entry.kind === 'mem') return entry.data.subarray(pos, pos + len);
    return entry.readAt(pos, len);
  }
  function writeEntry(entry, pos, src) {
    if (entry.kind !== 'mem') return 0;
    const end = pos + src.length;
    if (end > entry.data.length) {
      const grown = new Uint8Array(Math.max(end, entry.data.length * 2, 4096));
      grown.set(entry.data.subarray(0, entry.size)); entry.data = grown;
    }
    entry.data.set(src, pos); entry.size = Math.max(entry.size, end); entry.dirty = true;
    return src.length;
  }

  const wasi = {
    fd_prestat_get(fd, buf) {
      if (fd !== 3) return ERRNO.BADF;
      view().setUint8(buf, 0); view().setUint32(buf + 4, 1, true); return 0;
    },
    fd_prestat_dir_name(fd, path, len) {
      if (fd !== 3) return ERRNO.BADF;
      bytes()[path] = 47; return 0; // "/"
    },
    fd_fdstat_get(fd, buf) {
      const v = view();
      v.setUint8(buf, fd <= 2 ? 2 : fd === 3 ? 3 : 4); // char dev / dir / regular file
      v.setUint16(buf + 2, 0, true);
      v.setBigUint64(buf + 8, 0xffffffffn, true); v.setBigUint64(buf + 16, 0xffffffffn, true);
      return 0;
    },
    fd_fdstat_set_flags() { return 0; },
    path_open(dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInh, fdflags, fdOut) {
      const path = readStr(pathPtr, pathLen);
      let entry = vfs.get(path);
      const create = oflags & 1, trunc = oflags & 8;
      if (!entry) {
        if (!create) return ERRNO.NOENT;
        entry = { kind: 'mem', data: new Uint8Array(0), size: 0 };
        vfs.files.set(vfs.norm(path), entry);
      } else if (trunc && entry.kind === 'mem') { entry.size = 0; }
      const fd = nextFd++;
      fds.set(fd, { entry, pos: 0, path, append: !!(fdflags & 1) });
      view().setUint32(fdOut, fd, true);
      return 0;
    },
    fd_close(fd) { fds.delete(fd); return 0; },
    fd_read(fd, iovs, iovsLen, nread) {
      const f = fds.get(fd); if (!f) return ERRNO.BADF;
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const v = view(); const ptr = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
        const chunk = readEntry(f.entry, f.pos, len);
        bytes().set(chunk, ptr); f.pos += chunk.length; total += chunk.length;
        if (chunk.length < len) break;
      }
      view().setUint32(nread, total, true); return 0;
    },
    fd_write(fd, iovs, iovsLen, nwritten) {
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const v = view(); const ptr = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
        const src = bytes().slice(ptr, ptr + len);
        if (fd === 1 || fd === 2) {
          stdoutBuf += dec.decode(src);
          let nl; while ((nl = stdoutBuf.indexOf('\n')) >= 0) { log(stdoutBuf.slice(0, nl)); stdoutBuf = stdoutBuf.slice(nl + 1); }
        } else {
          const f = fds.get(fd); if (!f) return ERRNO.BADF;
          if (f.append) f.pos = f.entry.size;
          f.pos += writeEntry(f.entry, f.pos, src);
        }
        total += len;
      }
      view().setUint32(nwritten, total, true); return 0;
    },
    fd_seek(fd, offset, whence, newOff) {
      const f = fds.get(fd); if (!f) return ERRNO.BADF;
      const off = Number(offset);
      const base = whence === 0 ? 0 : whence === 1 ? f.pos : f.entry.size;
      f.pos = Math.max(0, base + off);
      view().setBigUint64(newOff, BigInt(f.pos), true); return 0;
    },
    fd_tell(fd, out) {
      const f = fds.get(fd); if (!f) return ERRNO.BADF;
      view().setBigUint64(out, BigInt(f.pos), true); return 0;
    },
    proc_exit(code) { throw new Error('core exited with code ' + code); },
  };

  return {
    imports: { wasi_snapshot_preview1: wasi },
    setMemory(m) { mem = m; },
  };
}
