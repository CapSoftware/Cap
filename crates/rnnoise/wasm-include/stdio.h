#pragma once
#include <stddef.h>
typedef struct cap_wasm_file FILE;
FILE *fopen(const char *path, const char *mode);
size_t fread(void *ptr, size_t size, size_t count, FILE *file);
int fclose(FILE *file);
int fseek(FILE *file, long offset, int whence);
long ftell(FILE *file);
int printf(const char *format, ...);
int fprintf(FILE *file, const char *format, ...);
extern FILE *stderr;
#define SEEK_SET 0
#define SEEK_END 2
