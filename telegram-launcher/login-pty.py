#!/usr/bin/env python3
"""PTY driver for `claude auth login` so the dispatcher can run the OAuth
code-flow over Telegram.

Protocol (line-based, over our OWN stdin/stdout pipes — NOT the pty):
  we emit:   "URL <authorize-url>"   once the login prints it
             "DONE"                  when the claude process exits (or times out)
             "LOG <line>"            occasional debug (ignored by the dispatcher)
  we read:   one line = the OAuth code the user pasted in Telegram → fed to the
             login process's stdin.

We deliberately do NOT try to parse success/failure from the pty text (brittle).
The dispatcher decides by comparing credentials.json expiresAt before/after.
A wide pty window keeps the long authorize URL from wrapping.
"""
import os, sys, pty, time, struct, fcntl, termios, select, re, signal

CLAUDE = os.environ.get("CLAUDE_BIN") or "/home/clawd/.local/bin/claude"
ARGS = [CLAUDE, "auth", "login", "--claudeai"]
URL_RE = re.compile(r"https://\S*oauth\S*")
ANSI_RE = re.compile(r"\x1b\[[0-9;>?]*[a-zA-Z]|\x1b[()][AB0]")
TIMEOUT_S = 300


def emit(line: str) -> None:
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def clean(b: bytes) -> str:
    return ANSI_RE.sub("", b.decode("utf-8", "ignore")).replace("\r", "")


def main() -> int:
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "dumb"
        try:
            os.execv(ARGS[0], ARGS)
        except Exception:
            os._exit(127)
    # 1000-col window so the authorize URL never wraps in the capture.
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 1000, 0, 0))
    except Exception:
        pass

    stdin_fd = sys.stdin.fileno()
    acc = b""
    url_sent = False
    code_sent = False
    start = time.time()

    while True:
        if time.time() - start > TIMEOUT_S:
            emit("LOG timeout")
            break
        try:
            r, _, _ = select.select([fd, stdin_fd], [], [], 1.0)
        except OSError:
            break

        if stdin_fd in r and not code_sent:
            line = sys.stdin.readline()
            if line == "":  # dispatcher closed control pipe
                break
            code = line.strip()
            if code:
                try:
                    os.write(fd, code.encode() + b"\r")
                    code_sent = True
                    emit("LOG code-submitted")
                except OSError:
                    break

        if fd in r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                break
            acc += chunk
            if not url_sent:
                m = URL_RE.search(clean(acc))
                if m:
                    url = m.group(0).rstrip('.,)]}"\'')
                    emit("URL " + url)
                    url_sent = True

        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                break
        except ChildProcessError:
            break

    # Best-effort teardown of the login process.
    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.2)
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    emit("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
