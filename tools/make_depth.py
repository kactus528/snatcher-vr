#!/usr/bin/env python3
"""Turns scene captures into depth maps the viewer can load.

  python3 tools/make_depth.py path/to/snatcher-captures [more folders or zips...]

For each capture it finds the illustration (the largest non-black area: Snatcher
draws its pictures in a box with black around them), runs Depth Anything V2 on
just that box, and writes:

  web/depth/<id>.png      8-bit depth, same size as the capture.
                          128 = the screen plane; higher = closer to you.
                          Text, borders and anything outside the picture stay at 128.
  web/depth/manifest.json fingerprints the game uses to recognise each scene.

Needs: numpy, Pillow, scipy, the ONNX Runtime C library and the model. The
runner and model paths are set with ONNX_RUNNER / DEPTH_MODEL (see README).
Only depth maps and fingerprints are written: the captures themselves (the
game's artwork) never go into the repository.
"""
import hashlib, json, os, subprocess, sys, tempfile, zipfile, pathlib
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'web' / 'depth'
RUNNER = os.environ.get('ONNX_RUNNER', '/root/depth/run_onnx')
MODEL = os.environ.get('DEPTH_MODEL', '/root/depth/depth_anything_v2_vits.onnx')
SIZE = 518                     # the model's fixed input size

FAR, NEAR = 72, 210            # depth range used inside the picture (128 = screen plane)


def infer(img):
    x = np.asarray(img.convert('RGB').resize((SIZE, SIZE), Image.BICUBIC), dtype=np.float32) / 255.0
    x = ((x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1)[None].astype(np.float32)
    with tempfile.TemporaryDirectory() as t:
        x.tofile(f'{t}/in.f32')
        r = subprocess.run([RUNNER, MODEL, '1', '3', str(SIZE), str(SIZE), f'{t}/in.f32', f'{t}/out.f32'], capture_output=True, text=True)
        if r.returncode: raise SystemExit('depth model failed: ' + r.stderr)
        return np.fromfile(f'{t}/out.f32', dtype=np.float32).reshape(SIZE, SIZE)


def picture_box(rgb):
    """Bounding box of the largest solid non-black region (the illustration)."""
    lum = rgb.astype(np.float32) @ [0.3, 0.59, 0.11]
    mask = lum > 18
    # close small gaps (dark pixels inside the art), drop thin text lines
    mask = ndimage.binary_closing(mask, np.ones((5, 5)))
    mask = ndimage.binary_opening(mask, np.ones((9, 9)))
    lab, n = ndimage.label(mask)
    if not n: return None
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    k = int(np.argmax(sizes)) + 1
    if sizes[k - 1] < 0.08 * mask.size: return None          # nothing picture-like (menus, text screens)
    ys, xs = np.where(lab == k)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def flatten_screens(rgb, d):
    """Monitor and TV screens inside a picture come out of the depth model as
    deep tubs (dark glass reads as 'far'). Find them, a large dark area whose
    outline is close to a rectangle, and make the whole rectangle flat, picture
    on it included, set slightly back from its frame, like glass in a bezel."""
    lum = rgb.astype(np.float32) @ [0.3, 0.59, 0.11]
    h, w = d.shape
    d = d.copy()
    done = np.zeros((h, w), bool)
    for thr in (40, 60, 80):                         # screens vary from black to dim
        dark = ndimage.binary_opening(lum < thr, np.ones((3, 3)))
        lab, n = ndimage.label(dark)
        for k in range(1, n + 1):
            region = lab == k
            if region.sum() < 0.03 * region.size: continue
            ys, xs = np.where(region)
            y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
            if y0 == 0 or x0 == 0 or y1 == h - 1 or x1 == w - 1: continue   # open to the picture edge: not a screen
            if (y1 - y0) < 12 or (x1 - x0) < 12 or done[y0:y1 + 1, x0:x1 + 1].any(): continue
            # a screen fills the edges of its own bounding box; a coat or doorway doesn't
            edge = np.concatenate([region[y0, x0:x1 + 1], region[y1, x0:x1 + 1], region[y0:y1 + 1, x0], region[y0:y1 + 1, x1]])
            if edge.mean() < 0.7: continue
            rect = np.zeros((h, w), bool); rect[y0:y1 + 1, x0:x1 + 1] = True
            ring = ndimage.binary_dilation(rect, np.ones((7, 7))) & ~rect
            d[rect] = np.median(d[ring]) - 8
            done |= rect
    return d


def make_map(img):
    rgb = np.asarray(img.convert('RGB'))
    h, w = rgb.shape[:2]
    depth = np.full((h, w), 128, np.float32)
    box = picture_box(rgb)
    if box:
        x0, y0, x1, y1 = box
        crop = img.crop(box)
        d = infer(crop)
        d = np.asarray(Image.fromarray(d).resize((x1 - x0, y1 - y0), Image.BILINEAR))
        lo, hi = np.percentile(d, 2), np.percentile(d, 98)
        d = np.clip((d - lo) / (hi - lo + 1e-6), 0, 1)
        d = flatten_screens(np.asarray(crop.convert('RGB')), FAR + d * (NEAR - FAR))
        depth[y0:y1, x0:x1] = d
    out = Image.fromarray(np.clip(depth, 0, 255).astype(np.uint8))
    return out.filter(ImageFilter.GaussianBlur(0.8)), box


def captures(paths):
    for p in paths:
        p = pathlib.Path(p)
        if p.suffix == '.zip':
            z = zipfile.ZipFile(p)
            for n in sorted(z.namelist()):
                if n.endswith('.json'):
                    meta = json.loads(z.read(n)); png = n[:-5] + '.png'
                    yield meta, Image.open(z.open(png))
        else:
            for j in sorted(p.glob('scene-*.json')):
                meta = json.loads(j.read_text())
                yield meta, Image.open(j.with_suffix('.png'))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    man_path = OUT / 'manifest.json'
    manifest = json.loads(man_path.read_text()) if man_path.exists() else {'version': 1, 'scenes': []}
    force = '--force' in sys.argv          # regenerate scenes already in the set
    args = [a for a in sys.argv[1:] if a != '--force']
    known = {s['id']: s for s in manifest['scenes']}
    for meta, img in captures(args):
        if meta.get('sameAs'):
            continue                                   # duplicate of a scene already captured
        fp = np.array(meta['fingerprint'], np.int16)
        # same scene already mapped (maybe hand-edited)? keep that map
        sid_new = 's' + hashlib.sha1(bytes(meta['fingerprint'])).hexdigest()[:10]
        if not (force and sid_new in known) and any(np.mean(np.abs(fp - np.array(s['fingerprint'])) > 16) < 0.2 for s in known.values()):
            print(f"{meta['id']}: already in the depth set"); continue
        sid = 's' + hashlib.sha1(bytes(meta['fingerprint'])).hexdigest()[:10]
        dmap, box = make_map(img)
        if not box:
            print(f"{meta['id']}: no picture area, skipped"); continue
        dmap.save(OUT / f'{sid}.png', optimize=True)
        rev = hashlib.sha1((OUT / f'{sid}.png').read_bytes()).hexdigest()[:8]   # lets browsers notice a changed map
        known[sid] = {'id': sid, 'width': meta['width'], 'height': meta['height'],
                      'grid': meta.get('fingerprintGrid', [32, 24]), 'fingerprint': meta['fingerprint'],
                      'map': f'{sid}.png', 'rev': rev, 'box': [int(v) for v in box]}
        print(f"{meta['id']} -> {sid}: picture {box}")
    manifest['scenes'] = sorted(known.values(), key=lambda s: s['id'])
    man_path.write_text(json.dumps(manifest, separators=(',', ':')))
    print(f"{len(manifest['scenes'])} scenes in {man_path.relative_to(ROOT)}")


if __name__ == '__main__':
    main()
