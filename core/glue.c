/* Thin libretro frontend compiled into the wasm module.
 * JavaScript drives it through the g_* exports below. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include <stdbool.h>
#include "libretro.h"

#define WASM_EXPORT(name) __attribute__((export_name(#name)))

/* ---- video ---- */
static uint16_t fb[720 * 576];
static unsigned fb_w, fb_h;
static unsigned frames;

static void video_cb(const void *data, unsigned w, unsigned h, size_t pitch)
{
   if (!data) return; /* duped frame: keep previous */
   fb_w = w; fb_h = h;
   for (unsigned y = 0; y < h; y++)
      memcpy(fb + y * w, (const uint8_t *)data + y * pitch, w * 2);
   frames++;
}

/* ---- audio (interleaved stereo int16, drained by JS every frame) ---- */
#define AUDIO_MAX 8192
static int16_t audio[AUDIO_MAX * 2];
static unsigned audio_frames;

static size_t audio_batch_cb(const int16_t *data, size_t n)
{
   if (audio_frames + n > AUDIO_MAX) n = AUDIO_MAX - audio_frames;
   memcpy(audio + audio_frames * 2, data, n * 4);
   audio_frames += n;
   return n;
}
static void audio_cb(int16_t l, int16_t r) { int16_t s[2] = {l, r}; audio_batch_cb(s, 1); }

/* ---- input ---- */
static uint16_t pad_mask[2];
static int16_t gun_x, gun_y; /* libretro screen coords, -0x7fff..0x7fff */
static uint8_t gun_buttons, gun_offscreen;

static void poll_cb(void) {}
static int16_t input_cb(unsigned port, unsigned device, unsigned index, unsigned id)
{
   if (port > 1) return 0;
   switch (device)
   {
   case RETRO_DEVICE_JOYPAD:
      if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return pad_mask[port];
      return (pad_mask[port] >> id) & 1;
   case RETRO_DEVICE_LIGHTGUN:
      switch (id)
      {
      case RETRO_DEVICE_ID_LIGHTGUN_SCREEN_X: return gun_x;
      case RETRO_DEVICE_ID_LIGHTGUN_SCREEN_Y: return gun_y;
      case RETRO_DEVICE_ID_LIGHTGUN_IS_OFFSCREEN: return gun_offscreen;
      case RETRO_DEVICE_ID_LIGHTGUN_TRIGGER: return gun_buttons & 1;
      case RETRO_DEVICE_ID_LIGHTGUN_AUX_A: return (gun_buttons >> 1) & 1;
      case RETRO_DEVICE_ID_LIGHTGUN_AUX_B: return (gun_buttons >> 2) & 1;
      case RETRO_DEVICE_ID_LIGHTGUN_START: return (gun_buttons >> 3) & 1;
      }
   }
   return 0;
}

/* ---- environment ---- */
static void log_cb(enum retro_log_level level, const char *fmt, ...)
{
   va_list ap; va_start(ap, fmt);
   fprintf(stderr, "[core %d] ", level); vfprintf(stderr, fmt, ap);
   va_end(ap);
}

static bool env_cb(unsigned cmd, void *data)
{
   switch (cmd)
   {
   case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
      ((struct retro_log_callback *)data)->log = log_cb; return true;
   case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
      *(const char **)data = "/sys"; return true;
   case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
      *(const char **)data = "/save"; return true;
   case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      return *(enum retro_pixel_format *)data == RETRO_PIXEL_FORMAT_RGB565;
   case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      return true;
   case RETRO_ENVIRONMENT_GET_CAN_DUPE:
      *(bool *)data = true; return true;
   case RETRO_ENVIRONMENT_GET_VARIABLE:
      ((struct retro_variable *)data)->value = NULL; return false;
   default:
      return false;
   }
}

/* ---- exports ---- */
WASM_EXPORT(g_init) void g_init(void)
{
   retro_set_environment(env_cb);
   retro_set_video_refresh(video_cb);
   retro_set_audio_sample(audio_cb);
   retro_set_audio_sample_batch(audio_batch_cb);
   retro_set_input_poll(poll_cb);
   retro_set_input_state(input_cb);
   retro_init();
}

static char path_buf[512];
WASM_EXPORT(g_path_buf) char *g_path_buf(void) { return path_buf; }

WASM_EXPORT(g_load) int g_load(void)
{
   struct retro_game_info info = { path_buf, NULL, 0, NULL };
   if (!retro_load_game(&info)) return 0;
   return 1;
}

/* port device: 1 = joypad, lightgun ids defined in libretro.c */
WASM_EXPORT(g_set_device) void g_set_device(unsigned port, unsigned device) { retro_set_controller_port_device(port, device); }

WASM_EXPORT(g_run) void g_run(void) { audio_frames = 0; retro_run(); }
WASM_EXPORT(g_reset) void g_reset(void) { retro_reset(); }

WASM_EXPORT(g_fb) uint16_t *g_fb(void) { return fb; }
WASM_EXPORT(g_fb_w) unsigned g_fb_w(void) { return fb_w; }
WASM_EXPORT(g_fb_h) unsigned g_fb_h(void) { return fb_h; }
WASM_EXPORT(g_frames) unsigned g_frames(void) { return frames; }

WASM_EXPORT(g_audio) int16_t *g_audio(void) { return audio; }
WASM_EXPORT(g_audio_frames) unsigned g_audio_frames(void) { return audio_frames; }
WASM_EXPORT(g_sample_rate) double g_sample_rate(void)
{
   struct retro_system_av_info av; retro_get_system_av_info(&av);
   return av.timing.sample_rate;
}
WASM_EXPORT(g_fps) double g_fps(void)
{
   struct retro_system_av_info av; retro_get_system_av_info(&av);
   return av.timing.fps;
}

WASM_EXPORT(g_set_pad) void g_set_pad(unsigned port, unsigned mask) { if (port < 2) pad_mask[port] = mask; }
WASM_EXPORT(g_set_gun) void g_set_gun(int x, int y, unsigned buttons, unsigned offscreen)
{
   gun_x = x; gun_y = y; gun_buttons = buttons; gun_offscreen = offscreen;
}

/* save states */
WASM_EXPORT(g_state_size) size_t g_state_size(void) { return retro_serialize_size(); }
WASM_EXPORT(g_state_save) int g_state_save(void *buf, size_t n) { return retro_serialize(buf, n); }
WASM_EXPORT(g_state_load) int g_state_load(const void *buf, size_t n) { return retro_unserialize(buf, n); }

/* scratch memory for JS */
#include <stdlib.h>
WASM_EXPORT(g_malloc) void *g_malloc(size_t n) { return malloc(n); }
WASM_EXPORT(g_free) void g_free(void *p) { free(p); }
