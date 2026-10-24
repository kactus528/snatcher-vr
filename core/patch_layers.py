#!/usr/bin/env python3
"""Adds per-pixel layer tags to Genesis Plus GX's Mode 5 renderer.

For every output pixel we record which layer won it:
  0 backdrop     1 plane B low   2 plane B high
  3 plane A low  4 plane A high  5 window low    6 window high
  7 sprite low   8 sprite high   255 unknown (non-Mode-5 video modes)

How: before the background merge we keep a copy of plane B's line buffer
(plane A / window stay intact in linebuf[1]), sprite drawing records the
front-most opaque sprite pixel per column, and after the line is complete we
re-run the VDP's priority order on those inputs. Colors are untouched.

Usage: patch_layers.py path/to/Genesis-Plus-GX   (safe to run repeatedly)
"""
import re, sys, pathlib

MARK = '/* SNATCHER-VR LAYER TAGS */'
src_path = pathlib.Path(sys.argv[1]) / 'core' / 'vdp_render.c'
s = src_path.read_text()
if MARK in s:
    print('layer tags: already patched'); sys.exit(0)

# 1. state + helpers, placed right after the line buffers are declared
decl = 'static uint8 linebuf[2][0x200];'
assert decl in s
helpers = decl + '\n\n' + MARK + r'''
uint8 layer_tags[720 * 576];             /* same geometry as bitmap.data (pitch 720) */
static uint8 layer_bgb[0x200];           /* plane B before merge */
static uint8 layer_bga[0x200];           /* plane A / window before merge */
static uint8 layer_spr[0x200];           /* front-most opaque sprite pixel (0 = none) */
static uint8 layer_line[0x200];          /* resolved tags for the current line */
static int layer_bg_valid, layer_win_l, layer_win_r;

uint8 *layer_bitmap_data(void) { return bitmap.data; }

#define LAYER_SPR(PTR, PX) \
  { int _i = (int)((PTR) - &linebuf[0][0]) & 0x1FF; if (!layer_spr[_i]) layer_spr[_i] = (uint8)(PX); }

#define LAYER_SAVE_BG(W, START, END) \
  { memcpy(&layer_bgb[0x20], &linebuf[0][0x20], bitmap.viewport.w); \
    memcpy(&layer_bga[0x20], &linebuf[1][0x20], bitmap.viewport.w); \
    if (W) { layer_win_l = 0x20 + ((START) << 4); layer_win_r = 0x20 + ((END) << 4); } \
    else { layer_win_l = layer_win_r = 0; } \
    layer_bg_valid = 1; }

static void layer_begin_line(void)
{
  memset(layer_spr, 0, sizeof(layer_spr));
  layer_bg_valid = 0;
}

static void layer_resolve(void)
{
  int x, end = 0x20 + bitmap.viewport.w;
  if (!layer_bg_valid) { memset(layer_line, 255, sizeof(layer_line)); return; }
  memset(layer_line, 0, sizeof(layer_line));
  for (x = 0x20; x < end; x++)
  {
    uint8 s = layer_spr[x], a = layer_bga[x], b = layer_bgb[x];
    int win = (x >= layer_win_l && x < layer_win_r);
    uint8 at = win ? 5 : 3;
    uint8 t = 0;
    if      ((s & 0x0F) && (s & 0x40)) t = 8;
    else if ((a & 0x0F) && (a & 0x40)) t = at + 1;
    else if ((b & 0x0F) && (b & 0x40)) t = 2;
    else if  (s & 0x0F)                t = 7;
    else if  (a & 0x0F)                t = at;
    else if  (b & 0x0F)                t = 1;
    layer_line[x] = t;
  }
}
'''
s = s.replace(decl, helpers, 1)

# 2. sprite macros: record the first (front-most) opaque sprite pixel per column
n = 0
def sprite_hook(m):
    global n; n += 1
    return m.group(0) + ' \\\n      LAYER_SPR(lb + i, (temp & 0x0F) | ((ATTR) & 0x40))'
s = re.sub(r'(#define DRAW_SPRITE_TILE(?:_ACCURATE)?(?:_2X)?\(WIDTH,ATTR,TABLE\)[\s\S]*?if \(temp & 0x0f\) \\\n\s*\{)', sprite_hook, s)
assert n >= 3, f'sprite macros patched: {n}'

# 3. save plane B (and window span) before every Mode 5 background merge
# only the background merges; shadow/highlight sprite merges use lut[4]
merge = 'merge(&linebuf[1][0x20], &linebuf[0][0x20], &linebuf[0][0x20], lut[(reg[12] & 0x08) >> 2]'
count = s.count(merge)
assert count >= 4, f'merge calls found: {count}'
s = s.replace(merge, 'LAYER_SAVE_BG(w, start, end)\n  ' + merge)

# 4. render_line: reset per line, resolve after sprites, blank lines -> backdrop
old = '    /* Render BG layer(s) */\n    render_bg(line);'
assert old in s
s = s.replace(old, '    layer_begin_line();\n' + old, 1)
old = '    /* Parse sprites for next line */'
assert old in s
s = s.replace(old, '    layer_resolve();\n\n' + old, 1)
old = '    /* Blanked line */\n    memset(&linebuf[0][0x20 - bitmap.viewport.x], 0x40, bitmap.viewport.w + 2*bitmap.viewport.x);'
assert old in s
s = s.replace(old, old + '\n    memset(layer_line, 0, sizeof(layer_line));', 1)
old = 'void blank_line(int line, int offset, int width)\n{\n  memset(&linebuf[0][0x20 + offset], 0x40, width);'
assert old in s
s = s.replace(old, old + '\n  memset(&layer_line[0x20 + offset], 0, width);', 1)

# 5. remap_line: copy the tag line into layer_tags alongside the pixels
old = '#if defined(USE_15BPP_RENDERING) || defined(USE_16BPP_RENDERING)\n  /* NTSC Filter'
assert old in s
s = s.replace(old, '  if (line < 576)\n    memcpy(&layer_tags[line * 720], &layer_line[0x20 - bitmap.viewport.x], width);\n\n' + old, 1)

src_path.write_text(s)
print(f'layer tags: patched ({n} sprite macros, {count} merges)')
