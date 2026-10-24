#!/usr/bin/env bash
# Builds web/core.wasm from Genesis Plus GX using the WASI SDK.
#   WASI_SDK=/path/to/wasi-sdk GPGX=/path/to/Genesis-Plus-GX ./core/build.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
WASI_SDK="${WASI_SDK:?set WASI_SDK}"
G="${GPGX:?set GPGX to a Genesis-Plus-GX checkout}"
CC="$WASI_SDK/bin/clang --sysroot=$WASI_SDK/share/wasi-sysroot"
# no setjmp on WASI: turn off 68000 address-error emulation (only odd homebrew needs it)
sed -i "s/#define M68K_EMULATE_ADDRESS_ERROR  OPT_ON/#define M68K_EMULATE_ADDRESS_ERROR  OPT_OFF/" "$G/core/m68k/m68kconf.h"
# no setjmp on WASI: turn off 68000 address-error emulation (only odd homebrew needs it)
sed -i "s/#define M68K_EMULATE_ADDRESS_ERROR  OPT_ON/#define M68K_EMULATE_ADDRESS_ERROR  OPT_OFF/" "$G/core/m68k/m68kconf.h"
# let the frontend flush Sega CD backup RAM (game saves) without unloading the game
sed -i "s/^static void bram_save(void)/void bram_save(void)/" "$G/libretro/libretro.c"
OUT="$ROOT/build-obj"; mkdir -p "$OUT"

DIRS="core core/z80 core/m68k core/ntsc core/sound core/input_hw core/cd_hw core/cart_hw core/cart_hw/svp"
SRC=""
for d in $DIRS; do SRC+=" $(ls $G/$d/*.c)"; done
LC=$G/libretro/libretro-common
SRC+=" $LC/streams/file_stream.c $LC/streams/file_stream_transforms.c $LC/compat/fopen_utf8.c
 $LC/compat/compat_snprintf.c $LC/compat/compat_strl.c $LC/compat/compat_strcasestr.c $LC/compat/compat_posix_string.c
 $LC/encodings/encoding_utf.c $LC/file/file_path.c $LC/file/retro_dirent.c $LC/lists/string_list.c $LC/lists/dir_list.c
 $LC/memmap/memalign.c $LC/string/stdstring.c $LC/vfs/vfs_implementation.c"
Z=$G/libretro/deps/zlib-1.2.11
SRC+=" $Z/adler32.c $Z/crc32.c $Z/inffast.c $Z/inflate.c $Z/inftrees.c $Z/zutil.c"
SRC+=" $(ls $G/core/sound/tremor/*.c)"
D=$G/libretro/deps
SRC+=" $D/lzma-19.00/src/Alloc.c $D/lzma-19.00/src/Bra86.c $D/lzma-19.00/src/BraIA64.c $D/lzma-19.00/src/CpuArch.c
 $D/lzma-19.00/src/Delta.c $D/lzma-19.00/src/LzFind.c $D/lzma-19.00/src/Lzma86Dec.c $D/lzma-19.00/src/LzmaDec.c
 $D/lzma-19.00/src/LzmaEnc.c $D/lzma-19.00/src/Sort.c
 $D/libchdr/src/libchdr_bitstream.c $D/libchdr/src/libchdr_cdrom.c $D/libchdr/src/libchdr_chd.c
 $D/libchdr/src/libchdr_flac.c $D/libchdr/src/libchdr_huffman.c
 $D/zstd/lib/common/entropy_common.c $D/zstd/lib/common/error_private.c $D/zstd/lib/common/fse_decompress.c
 $D/zstd/lib/common/zstd_common.c $D/zstd/lib/common/xxhash.c $D/zstd/lib/decompress/huf_decompress.c
 $D/zstd/lib/decompress/zstd_ddict.c $D/zstd/lib/decompress/zstd_decompress.c $D/zstd/lib/decompress/zstd_decompress_block.c"
SRC+=" $G/libretro/libretro.c $HERE/glue.c"

INC="-I$HERE/shim -I$G/core/sound/minimp3"
for d in $DIRS; do INC+=" -I$G/$d"; done
INC+=" -I$G/libretro -I$LC/include -I$D/libchdr/include -I$D/lzma-19.00/include -I$Z -I$D/zstd/lib"

FLAGS="-O3 -DNDEBUG -D__LIBRETRO__ -DUSE_LIBRETRO_VFS -DUSE_LIBTREMOR -DUSE_LIBCHDR -D_7ZIP_ST -DZSTD_DISABLE_ASM
 -DUSE_16BPP_RENDERING -DFRONTEND_SUPPORTS_RGB565 -DLSB_FIRST -DALIGN_LONG -DBYTE_ORDER=LITTLE_ENDIAN -DHAVE_ZLIB
 -DM68K_OVERCLOCK_SHIFT=20 -DZ80_OVERCLOCK_SHIFT=20 -DHAVE_YM3438_CORE -DHAVE_OPLL_CORE -DMAXROMSIZE=33554432
 -DINLINE=static\ inline -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN
 -Wno-everything"

objs=()
pids=()
for f in $SRC; do
  o="$OUT/$(echo "${f#$G/}" | tr '/' '_' ).o"
  objs+=("$o")
  if [ ! -f "$o" ] || [ "$f" -nt "$o" ]; then
    eval $CC -c $FLAGS $INC "$f" -o "$o" &
    pids+=($!)
    if [ ${#pids[@]} -ge 8 ]; then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
  fi
done
wait
$CC -O3 -mexec-model=reactor "${objs[@]}" -o "$ROOT/web/core.wasm" \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman \
  -Wl,--export=malloc -Wl,--initial-memory=134217728 -Wl,--max-memory=536870912 -Wl,-z,stack-size=1048576
ls -la "$ROOT/web/core.wasm"
