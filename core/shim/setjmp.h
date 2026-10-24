/* WASI has no setjmp. The 68000 address-error trap that uses it is disabled
 * in the build (M68K_EMULATE_ADDRESS_ERROR off), so only the type is needed. */
#ifndef SHIM_SETJMP_H
#define SHIM_SETJMP_H
typedef int jmp_buf[1];
#endif
