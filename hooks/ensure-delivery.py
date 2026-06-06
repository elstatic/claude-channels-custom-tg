#!/usr/bin/env python3
"""Stop hook: guarantee the user sees the final answer.

The Telegram bridge only delivers to the user via the `reply` MCP tool — plain
transcript text never reaches the chat. If a turn ends with assistant text but
no delivery tool call, this hook delivers that text into the topic itself,
using the bot token + chat/thread ids from the session env. It prefers editing
the in-topic "💬 работаю…" status message (so it morphs into the answer like a
normal reply); otherwise it sends a fresh message. Loop-guarded via
stop_hook_active so it never fires twice for the same stop.
"""
import sys, os, json, time, socket, urllib.request, urllib.parse


def douse_draft(thread_id):
    """Turn is over → stop any live working draft so none lingers (e.g. one a
    trailing tool's PreToolUse armed). Sends status_consume over the dispatcher
    socket, which stops the animator and clears the draft immediately. We do NOT
    touch the status file here — the rescue logic below relies on its consumed
    flag to decide whether a real delivery already happened. Best-effort."""
    if not thread_id:
        return
    sock = os.path.join(
        os.path.expanduser("~"), ".claude", "channels", "telegram", "dispatcher.sock"
    )
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect(sock)
        s.sendall((json.dumps({"type": "status_consume", "thread_id": int(thread_id)}) + "\n").encode())
        s.close()
    except Exception:
        pass


DELIVERY_TOOLS = {
    "mcp__telegram-ss__reply",
    "mcp__telegram-ss__ask_user",
    "mcp__telegram-ss__confirm",
    "mcp__telegram-ss__confirm_plan",
}
TG_LIMIT = 4000


def tg_api(token, method, params):
    body = urllib.parse.urlencode(params).encode()
    url = f"https://api.telegram.org/bot{token}/{method}"
    try:
        urllib.request.urlopen(url, body, timeout=20)
        return True
    except Exception:
        return False


def main():
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        return 0
    if data.get("stop_hook_active"):
        return 0  # avoid loops — we already nudged once
    tpath = data.get("transcript_path")
    if not tpath or not os.path.exists(tpath):
        return 0

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("CLAUDE_CHAT_ID")
    thread_id = os.environ.get("CLAUDE_THREAD_ID")
    if not token or not chat_id:
        return 0

    # Turn is ending → make sure no live working draft is left hanging (covers
    # the case where the last action was a tool, not a reply/prompt). Reply and
    # prompts already douse their own draft; this is the backstop.
    douse_draft(thread_id)

    # If reply() already morphed the status bubble it set consumed:true
    # synchronously — a real delivery happened, don't double-send. Reliable even
    # when the transcript hasn't flushed the reply tool_use yet.
    sf = f"/tmp/claude-tg-status-{thread_id}.json" if thread_id else None
    if sf and os.path.exists(sf):
        try:
            if json.load(open(sf)).get("consumed") is True:
                return 0
        except Exception:
            pass

    # At Stop time CC often hasn't flushed the final assistant text block (or a
    # trailing reply tool_use) to the transcript yet. Give it a moment so we
    # read the real final answer, not stale intermediate narration.
    time.sleep(1.5)

    msgs = []
    try:
        for ln in open(tpath, encoding="utf-8").read().splitlines():
            try:
                o = json.loads(ln)
            except Exception:
                continue
            if o.get("type") in ("assistant", "user"):
                msgs.append(o)
    except Exception:
        return 0

    # Boundary: the last *real* user message (string content, or a content list
    # with no tool_result block). Tool results are role=user too — skip those.
    last_user = -1
    for i, o in enumerate(msgs):
        if o.get("type") != "user":
            continue
        c = o.get("message", {}).get("content")
        if isinstance(c, str):
            last_user = i
        elif isinstance(c, list):
            if not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                last_user = i
    after = msgs[last_user + 1:] if last_user >= 0 else msgs

    delivered = False
    text_parts = []
    for o in after:
        if o.get("type") != "assistant":
            continue
        for b in o.get("message", {}).get("content", []) or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and b.get("name") in DELIVERY_TOOLS:
                delivered = True
            elif b.get("type") == "text" and (b.get("text") or "").strip():
                text_parts.append(b["text"])

    if delivered:
        return 0  # the agent already reached the user — nothing to rescue
    # Deliver ONLY the final answer = the LAST text block. Earlier text blocks
    # are live narration ("Считаю строки…") shown in the trace, not the answer;
    # concatenating them sends the wrong thing.
    text = (text_parts[-1].strip() if text_parts else "")
    if not text:
        return 0  # silent tool-only turn — nothing to deliver

    # Mark the turn consumed so the launcher's live working-log loop stops (which
    # also drops its ⏹ button). We never morph the log — the answer is always a
    # fresh, separate message, leaving the log as a CLI-style transcript above it.
    sf = f"/tmp/claude-tg-status-{thread_id}.json" if thread_id else None
    if sf and os.path.exists(sf):
        try:
            o = json.load(open(sf))
            if o.get("consumed") is False:
                o["consumed"] = True
                tmp = f"{sf}.tmp.{os.getpid()}"
                with open(tmp, "w") as fh:
                    json.dump(o, fh)
                os.replace(tmp, sf)
        except Exception:
            pass

    chunks = [text[i:i + TG_LIMIT] for i in range(0, len(text), TG_LIMIT)] or [text]
    for ch in chunks:
        p = {"chat_id": chat_id, "text": ch}
        if thread_id:
            p["message_thread_id"] = thread_id
        tg_api(token, "sendMessage", p)

    # Deliver silently and let the turn end — no `block`, which would re-invoke
    # the model and risk a duplicate message. The user already has the answer;
    # cross-session learning lives in memory (always-use-reply-tool).
    sys.stderr.write("ensure-delivery: rescued an undelivered final answer to the topic\n")
    return 0


sys.exit(main() or 0)
