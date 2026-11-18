// Tiny fork/exec/wait4 launcher: prints the child's peak RSS in KiB.
// ru_maxrss carries over exec, so measuring from a large parent (Python)
// would floor every child at the parent's own RSS.
#include <stdio.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
int main(int argc, char **argv) {
  pid_t pid = fork();
  if (pid == 0) {
    int fd = open("/dev/null", O_WRONLY);
    dup2(fd, 1); dup2(fd, 2);
    execvp(argv[1], argv + 1);
    _exit(127);
  }
  int status; struct rusage ru;
  wait4(pid, &status, 0, &ru);
  printf("%ld %d\n", ru.ru_maxrss, WIFEXITED(status) ? WEXITSTATUS(status) : -1);
  return 0;
}
