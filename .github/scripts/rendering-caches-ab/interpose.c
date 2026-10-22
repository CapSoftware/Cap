#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static unsigned long hits;

static void count(const char *path) {
    const char *needle = getenv("STAT_NEEDLE");
    if (path && needle && strstr(path, needle)) {
        __atomic_fetch_add(&hits, 1, __ATOMIC_RELAXED);
    }
}

static int my_stat(const char *p, struct stat *b) { count(p); return stat(p, b); }
static int my_lstat(const char *p, struct stat *b) { count(p); return lstat(p, b); }
static int my_fstatat(int fd, const char *p, struct stat *b, int f) { count(p); return fstatat(fd, p, b, f); }
static int my_access(const char *p, int m) { count(p); return access(p, m); }

__attribute__((destructor)) static void report(void) {
    fprintf(stderr, "STAT_HITS %lu\n", hits);
}

#define INTERPOSE(name) \
    __attribute__((used)) static struct { const void *replacement; const void *original; } \
    interpose_##name __attribute__((section("__DATA,__interpose"))) = { (const void *)my_##name, (const void *)name };

INTERPOSE(stat)
INTERPOSE(lstat)
INTERPOSE(fstatat)
INTERPOSE(access)
