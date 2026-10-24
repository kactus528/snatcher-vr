# Builds a Genesis test ROM with one thing on each layer, so the layer tags
# can be checked against known answers:
#   plane B: blue tile everywhere (low priority)
#   plane A: green band on rows 8-15 (pixel rows 64-127), high priority
#   sprite:  8x8 red square at x=100, y=60, low priority (straddles the band)
# Expected tags: 1 (B low) everywhere, 4 (A high) in the band,
#                7 (sprite low) in the square except where it overlaps the band (4).
import struct

code = bytearray()
def w(*words): [code.extend(struct.pack('>H', x & 0xFFFF)) for x in words]
def l(x): code.extend(struct.pack('>I', x))

def vram_cmd(addr): return 0x40000000 | ((addr & 0x3FFF) << 16) | (addr >> 14)

def ctrl_l(cmd): w(0x20BC); l(cmd)            # move.l #cmd,(a0)
def ctrl_w(v):   w(0x30BC, v)                 # move.w #v,(a0)
def fill(value, count):                       # move.w #n-1,d1 ; L: move.w #v,(a1) ; dbra d1,L
    w(0x323C, count - 1, 0x32BC, value, 0x51C9, 0xFFFA)

# TMSS
w(0x1039); l(0x00A10001); w(0x0200, 0x000F, 0x670A, 0x23FC); l(0x53454741); l(0x00A14000)
w(0x41F9); l(0x00C00004)                      # lea $C00004,a0  (control)
w(0x43F9); l(0x00C00000)                      # lea $C00000,a1  (data)
for r in (0x8004, 0x8104, 0x8230, 0x8407, 0x8578, 0x8700, 0x8B00, 0x8C00, 0x8D3F, 0x8F02, 0x9001):
    ctrl_w(r)
ctrl_l(0xC0000000)                            # CRAM 0
for c in (0x0000, 0x0E00, 0x00E0, 0x000E): w(0x32BC, c)
ctrl_l(vram_cmd(0x0020)); fill(0x1111, 16)    # tile 1: colour 1
ctrl_l(vram_cmd(0x0040)); fill(0x2222, 16)    # tile 2: colour 2
ctrl_l(vram_cmd(0x0060)); fill(0x3333, 16)    # tile 3: colour 3
ctrl_l(vram_cmd(0xE000)); fill(0x0001, 2048)  # plane B: tile 1 everywhere
ctrl_l(vram_cmd(0xC400)); fill(0x8002, 512)   # plane A rows 8-15: tile 2, high priority
ctrl_l(vram_cmd(0xF000))                      # sprite 0: y, size 1x1 + link 0, tile 3, x
for v in (0x80 + 60, 0x0000, 0x0003, 0x80 + 100): w(0x32BC, v)
ctrl_w(0x8144)                                # display on
w(0x60FE)                                     # bra.s *

rom = bytearray(0x20000)
struct.pack_into('>II', rom, 0, 0x00FFFE00, 0x200)
for i in range(2, 64): struct.pack_into('>I', rom, i * 4, 0x200)
rom[0x100:0x110] = b'SEGA MEGA DRIVE '
rom[0x1A0:0x1A8] = struct.pack('>II', 0, len(rom) - 1)
rom[0x1F0:0x1F3] = b'JUE'
rom[0x200:0x200 + len(code)] = code
open(__file__.replace('make_layers_rom.py', 'layers.bin'), 'wb').write(rom)
