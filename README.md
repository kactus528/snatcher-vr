# Snatcher VR

Play the Sega CD version of *Snatcher* inside a Meta Quest headset, running entirely
in the Quest browser. The long-term goal is a 3DS-style "diorama" look: each part of
the picture pushed to its own depth.

**Status: step 2 of 6** — the emulator runs in the browser, and each pixel is tagged with
the video-chip layer it came from (plane B, plane A, window, sprites), so the picture is
shown as stacked cut-out layers at different depths. Scene depth maps come next.

## Playing

1. Open the GitHub Pages site in the Quest browser.
2. Under **Your files**, choose:
   - a US Sega CD BIOS (model 1 or 2), and
   - your own dump of the Snatcher disc: select the `.cue` and all its `.bin` tracks
     together, or a single `.chd`.
   They're copied into the browser's private storage once.
3. Press **Enter VR** (or **Start game** to play flat).

Game saves (Sega CD backup RAM) are written automatically. Save states are on the page.

| Quest | Sega |
|---|---|
| Left stick | D-pad |
| Either trigger | A |
| A | B |
| B or X | C |
| Y / right grip | Start |

Keyboard: arrows, Z/X/C, Enter.

No BIOS or game files are included in this repository.

## How it works

- `core/` — [Genesis Plus GX](https://github.com/libretro/Genesis-Plus-GX) compiled to
  WebAssembly with the WASI SDK, plus `glue.c`, a tiny libretro frontend that exposes
  `g_*` functions to JavaScript.
- `web/wasi.js` — a minimal WASI layer with a virtual filesystem. Disc images are read
  in place from the browser's file storage (OPFS) a sector at a time, never loaded
  whole into memory.
- `web/emu-worker.js` — runs the emulator in a worker, sends frames to the page and
  audio straight to an AudioWorklet.
- `web/app.js` — three.js scene, WebXR session, Quest controller mapping.

## Building the core

```sh
git clone https://github.com/libretro/Genesis-Plus-GX
# download wasi-sdk 25 from https://github.com/WebAssembly/wasi-sdk/releases
WASI_SDK=/path/to/wasi-sdk GPGX=/path/to/Genesis-Plus-GX ./core/build.sh
node test/run_test.mjs   # boots a tiny generated test ROM (python3 test/make_rom.py)
```

The build patches three things in the emulator source: 68000 address-error emulation is
turned off (it needs `setjmp`, which WASI lacks), `bram_save` is made public so the
page can persist game saves without unloading the game, and `core/patch_layers.py` adds
per-pixel layer tags to the Mode 5 renderer (`node test/layers_test.mjs` checks them
against the known layout built by `test/make_layers_rom.py`).

## Roadmap

1. ✅ Emulator in the browser, flat screen in VR
2. ✅ Per-pixel layer tags from the video chip, shown as stacked depth layers
3. Scene recognition by hashing plane B's tiles
4. Depth-map diorama renderer combining layer depth + scene depth maps
5. Capture mode and depth-map authoring pipeline
6. Light-gun aiming with the controller, sharp text layer, polish

Genesis Plus GX is licensed for non-commercial use; see its license. three.js (MIT) is
vendored in `web/lib`.
