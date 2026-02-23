/**
 * Helper for running LibreOffice (soffice) in environments where AF_UNIX
 * sockets may be blocked (e.g., sandboxed VMs).
 *
 * Ported from soffice.py
 *
 * Note: The LD_PRELOAD C shim functionality is Linux-only and requires gcc.
 * On macOS and other platforms, soffice runs without the shim.
 */
import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as net from "net";

const SHIM_SO_PATH = path.join(os.tmpdir(), "lo_socket_shim.so");

const SHIM_SOURCE = `
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int (*real_socket)(int, int, int);
static int (*real_socketpair)(int, int, int, int[2]);
static int (*real_listen)(int, int);
static int (*real_accept)(int, struct sockaddr *, socklen_t *);
static int (*real_close)(int);
static int (*real_read)(int, void *, size_t);

static int is_shimmed[1024];
static int peer_of[1024];
static int wake_r[1024];
static int wake_w[1024];
static int listener_fd = -1;

__attribute__((constructor))
static void init(void) {
    real_socket     = dlsym(RTLD_NEXT, "socket");
    real_socketpair = dlsym(RTLD_NEXT, "socketpair");
    real_listen     = dlsym(RTLD_NEXT, "listen");
    real_accept     = dlsym(RTLD_NEXT, "accept");
    real_close      = dlsym(RTLD_NEXT, "close");
    real_read       = dlsym(RTLD_NEXT, "read");
    for (int i = 0; i < 1024; i++) {
        peer_of[i] = -1;
        wake_r[i]  = -1;
        wake_w[i]  = -1;
    }
}

int socket(int domain, int type, int protocol) {
    if (domain == AF_UNIX) {
        int fd = real_socket(domain, type, protocol);
        if (fd >= 0) return fd;
        int sv[2];
        if (real_socketpair(domain, type, protocol, sv) == 0) {
            if (sv[0] >= 0 && sv[0] < 1024) {
                is_shimmed[sv[0]] = 1;
                peer_of[sv[0]]    = sv[1];
                int wp[2];
                if (pipe(wp) == 0) {
                    wake_r[sv[0]] = wp[0];
                    wake_w[sv[0]] = wp[1];
                }
            }
            return sv[0];
        }
        errno = EPERM;
        return -1;
    }
    return real_socket(domain, type, protocol);
}

int listen(int sockfd, int backlog) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        listener_fd = sockfd;
        return 0;
    }
    return real_listen(sockfd, backlog);
}

int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        if (wake_r[sockfd] >= 0) {
            char buf;
            real_read(wake_r[sockfd], &buf, 1);
        }
        errno = ECONNABORTED;
        return -1;
    }
    return real_accept(sockfd, addr, addrlen);
}

int close(int fd) {
    if (fd >= 0 && fd < 1024 && is_shimmed[fd]) {
        int was_listener = (fd == listener_fd);
        is_shimmed[fd] = 0;
        if (wake_w[fd] >= 0) {
            char c = 0;
            write(wake_w[fd], &c, 1);
            real_close(wake_w[fd]);
            wake_w[fd] = -1;
        }
        if (wake_r[fd] >= 0) { real_close(wake_r[fd]); wake_r[fd]  = -1; }
        if (peer_of[fd] >= 0) { real_close(peer_of[fd]); peer_of[fd] = -1; }
        if (was_listener)
            _exit(0);
    }
    return real_close(fd);
}
`;

/**
 * Check if AF_UNIX sockets are blocked (sandboxed environments).
 */
function needsShim(): boolean {
  // Only relevant on Linux
  if (os.platform() !== "linux") return false;

  try {
    const server = net.createServer();
    const socketPath = path.join(
      os.tmpdir(),
      `test-sock-${process.pid}.sock`
    );
    try {
      server.listen(socketPath);
      server.close();
      fs.unlinkSync(socketPath);
    } catch {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Compile the LD_PRELOAD shim if needed and not already compiled.
 */
function ensureShim(): string {
  if (fs.existsSync(SHIM_SO_PATH)) return SHIM_SO_PATH;

  const srcPath = path.join(os.tmpdir(), "lo_socket_shim.c");
  fs.writeFileSync(srcPath, SHIM_SOURCE);

  child_process.execSync(
    `gcc -shared -fPIC -o "${SHIM_SO_PATH}" "${srcPath}" -ldl`,
    { stdio: "pipe" }
  );

  fs.unlinkSync(srcPath);
  return SHIM_SO_PATH;
}

/**
 * Get environment variables for running soffice.
 */
export function getSofficeEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  env["SAL_USE_VCLPLUGIN"] = "svp";

  if (needsShim()) {
    const shimPath = ensureShim();
    env["LD_PRELOAD"] = shimPath;
  }

  return env;
}

/**
 * Run soffice with the given arguments.
 */
export function resolveSofficeBinary(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const explicit = env.SOFFICE_BIN;
  if (explicit) {
    const explicitPath = path.resolve(explicit);
    if (fs.existsSync(explicitPath)) return explicitPath;
  }

  const pathEnv = env.PATH ?? "";
  const pathEntries = pathEnv
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);

  const execNames = process.platform === "win32"
    ? ["soffice.com", "soffice.exe"]
    : ["soffice"];

  for (const dir of pathEntries) {
    for (const execName of execNames) {
      const candidate = path.join(dir, execName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function runSoffice(
  args: string[],
  options?: Omit<child_process.SpawnSyncOptions, "encoding">
): child_process.SpawnSyncReturns<string> {
  const sofficeBinary = resolveSofficeBinary(process.env);
  if (!sofficeBinary) {
    throw new Error(
      "soffice not found. Set SOFFICE_BIN or add soffice to PATH (win32: soffice.com, darwin/linux: soffice)."
    );
  }
  const env = getSofficeEnv();
  return child_process.spawnSync(sofficeBinary, args, {
    env,
    ...options,
    encoding: "utf-8",
  });
}
