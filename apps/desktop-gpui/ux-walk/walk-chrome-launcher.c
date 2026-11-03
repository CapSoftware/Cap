#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

// macOS holds a process's launcher responsible for it, so Chrome started under the app would ask for
// App Management in the app's name. Exported by libSystem since macOS 10.14, with no public header.
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim)
    __attribute__((weak_import));

int main(int argc, char **argv) {
  (void)argc;
  const char *configured = getenv("UXW_CHROME_EXECUTABLE");
  if (!configured || !*configured) {
    fprintf(stderr, "walk-chrome-launcher: UXW_CHROME_EXECUTABLE is not set\n");
    return 127;
  }
  char *chrome = strdup(configured);
  if (!chrome) return 127;
  unsetenv("UXW_CHROME_EXECUTABLE");
  argv[0] = chrome;

  int error = ENOTSUP;
  if (responsibility_spawnattrs_setdisclaim) {
    posix_spawnattr_t attrs;
    error = posix_spawnattr_init(&attrs);
    if (!error) {
      // SETEXEC keeps this pid, so whoever started this launcher holds Chrome's pid.
      error = posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC);
      if (!error) error = responsibility_spawnattrs_setdisclaim(&attrs, 1);
      if (!error) error = posix_spawn(NULL, chrome, NULL, &attrs, argv, environ);
      posix_spawnattr_destroy(&attrs);
    }
  }
  fprintf(stderr, "walk-chrome-launcher: could not disclaim responsibility (%s); starting Chrome normally\n",
          strerror(error));
  execv(chrome, argv);
  fprintf(stderr, "walk-chrome-launcher: could not start Chrome (%s)\n", strerror(errno));
  return 126;
}
