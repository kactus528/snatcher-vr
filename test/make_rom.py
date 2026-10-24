# Builds a tiny Genesis ROM that turns the screen red: enough to prove the
# core boots, runs 68000 code and the VDP outputs frames.
import struct
rom = bytearray(0x20000)
struct.pack_into('>II', rom, 0, 0x00FFFE00, 0x200)
for i in range(2, 64): struct.pack_into('>I', rom, i*4, 0x200)
hdr = b'SEGA MEGA DRIVE (C)TEST 2026.OCT'
rom[0x100:0x100+len(hdr)] = hdr
rom[0x150:0x150+16] = b'DEPTH TEST      '
rom[0x1A0:0x1A8] = struct.pack('>II', 0, len(rom)-1)
rom[0x1F0:0x1F3] = b'JUE'
code = bytes.fromhex(
 '103900A10001' '0200000F' '670A' '23FC5345474100A14000'
 '41F900C00004' '30BC8004' '30BC8144' '30BC8700'
 '20BCC0000000' '33FC000E00C00000' '60FE')
rom[0x200:0x200+len(code)] = code
open('red.bin','wb').write(rom)
