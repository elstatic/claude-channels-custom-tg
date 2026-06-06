#!/usr/bin/env python3
"""PostToolUse hook: record a short trace of the agent's tool calls.

Writes one line per tool call ("• Bash: grep …") to
/tmp/claude-tg-trace-<thread>.txt (last N lines kept). The launcher's status
animator reads this file and renders it as an expandable blockquote under the
"💬 работаю" bubble — a live, Claude-Code-style activity trace WITHOUT scraping
the TUI (we read the structured tool_input the hook is handed). Must stay cheap:
it runs after every single tool call.
"""
import sys, os, json, socket

KEEP = 10
SKIP_PREFIX = "mcp__telegram-ss__"  # our own reply/typing/etc — pure noise here


def dispatcher_sock():
    return os.path.join(
        os.path.expanduser("~"), ".claude", "channels", "telegram", "dispatcher.sock"
    )


def arm_draft(thread, chat):
    """Tell the dispatcher to (re)post the live working draft. Fires on every
    real tool step; the dispatcher de-dupes, so it only actually arms a fresh
    draft when none is live (i.e. right after a reply/prompt doused the previous
    one). This is what makes the draft reappear ONLY when work continues — never
    lingering after a turn-ending message. Best-effort; never blocks the tool."""
    if not chat:
        return
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect(dispatcher_sock())
        msg = json.dumps(
            {"type": "status_start", "thread_id": int(thread), "chat_id": int(chat)}
        )
        s.sendall((msg + "\n").encode())
        s.close()
    except Exception:
        pass


def _is_real_user(o):
    if o.get("type") != "user":
        return False
    c = o.get("message", {}).get("content")
    if isinstance(c, str):
        return True
    if isinstance(c, list):
        return not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)
    return False


def last_assistant_narration(transcript_path):
    """The agent's reasoning alongside the current tool call. In CC transcripts
    each block is its OWN assistant message (thinking / text / tool_use on
    separate lines), so we walk backwards to the nearest `text` block (the
    visible narration), falling back to the nearest `thinking` block — but never
    crossing into the previous turn (stop at the last real user message). Reads
    only the transcript tail for speed."""
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as fh:
            if size > 131072:
                fh.seek(size - 131072)
            tail = fh.read().decode("utf-8", "ignore")
    except Exception:
        return ""
    objs = []
    for ln in tail.splitlines():
        try:
            objs.append(json.loads(ln))
        except Exception:
            pass  # truncated first tail line
    text_hit = thinking_hit = None
    for o in reversed(objs):
        if _is_real_user(o):
            break  # don't pull narration from a previous turn
        if o.get("type") != "assistant":
            continue
        for b in o.get("message", {}).get("content", []) or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and (b.get("text") or "").strip() and text_hit is None:
                text_hit = b["text"]
            elif b.get("type") == "thinking" and (b.get("thinking") or "").strip() and thinking_hit is None:
                thinking_hit = b["thinking"]
        if text_hit:
            break  # nearest visible narration wins
    chosen = text_hit or thinking_hit
    if not chosen:
        return ""
    chosen = " ".join(chosen.split())
    return (chosen[:99] + "…") if len(chosen) > 100 else chosen


def short(s, n):
    s = " ".join((s or "").split())  # collapse newlines/runs of spaces
    return s if len(s) <= n else s[: n - 1] + "…"


def label(tool, inp):
    if not isinstance(inp, dict):
        inp = {}
    if tool == "Bash":
        return short(inp.get("command"), 70)
    if tool in ("Read", "Edit", "Write", "NotebookEdit"):
        return os.path.basename(inp.get("file_path") or inp.get("notebook_path") or "")
    if tool in ("Grep", "Glob"):
        return short(inp.get("pattern"), 50)
    if tool == "Agent":
        return short(inp.get("description") or inp.get("subagent_type"), 50)
    if tool == "WebFetch":
        return short(inp.get("url"), 60)
    if tool == "WebSearch":
        return short(inp.get("query"), 50)
    if tool.startswith("Task"):
        return short(inp.get("subject"), 50)
    if tool == "Skill":
        name = (inp.get("skill") or "").split(":")[-1]  # drop plugin: prefix
        a = short(inp.get("args"), 40)
        return f"{name} — {a}" if (name and a) else (name or a)
    if tool.startswith("mcp__"):
        return ""
    return ""


def disp(tool):
    return tool.split("__")[-1] if tool.startswith("mcp__") else tool


def trace_file(thread):
    return f"/tmp/claude-tg-trace-{thread}.txt"


def active_file(thread):
    return f"/tmp/claude-tg-active-{thread}.txt"


def _atomic_write(path, text):
    """temp + os.replace so the launcher never reads a torn file."""
    try:
        tmp = f"{path}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except Exception:
        pass


def append_trace(thread, line):
    f = trace_file(thread)
    try:
        old = open(f, encoding="utf-8").read().splitlines() if os.path.exists(f) else []
    except Exception:
        old = []
    old.append(line)
    old = old[-KEEP:]
    _atomic_write(f, "\n".join(old) + "\n")


def set_active(thread, body):
    _atomic_write(active_file(thread), body + "\n")


def clear_active(thread):
    try:
        os.remove(active_file(thread))
    except OSError:
        pass


def main():
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        return 0
    thread = os.environ.get("CLAUDE_THREAD_ID")
    if not thread or thread == "0":
        return 0
    tool = data.get("tool_name") or ""
    if not tool or tool.startswith(SKIP_PREFIX):
        return 0
    # Older CC builds send no hook_event_name; default to the Post behaviour so
    # the trace still fills even without a registered PreToolUse hook.
    event = data.get("hook_event_name") or "PostToolUse"
    lab = label(tool, data.get("tool_input") or {})
    body = f"{disp(tool)}" + (f": {lab}" if lab else "")

    if event == "PreToolUse":
        # The currently-RUNNING tool — the launcher renders it with a blinking
        # marker so long Bash/Agent calls visibly "work". The 💭 reasoning line
        # is added by the dispatcher at render time (it scrapes the live pane).
        set_active(thread, body)
        # Re-arm the live draft the moment work continues (after a reply/prompt
        # doused it). telegram-ss tools already returned above, so emit tools
        # never trigger this — the action message stays the last thing.
        arm_draft(thread, os.environ.get("CLAUDE_CHAT_ID"))
    else:  # PostToolUse (or unknown): tool finished → log it, drop the active one.
        append_trace(thread, f"• {body}")
        clear_active(thread)
    return 0


sys.exit(main() or 0)
