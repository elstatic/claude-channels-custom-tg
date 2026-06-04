#!/usr/bin/env python3
"""Unit tests for the TG-bridge hooks. Run: python3 test_hooks.py
Covers trace-tool.py label/narration logic and ensure-delivery.py decision logic
(Telegram API calls are stubbed — nothing is sent)."""
import json, os, sys, io, importlib.util, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    """Load a hook module without running its `sys.exit(main())` tail."""
    src = open(os.path.join(HERE, f"{name}.py")).read().replace("sys.exit(main() or 0)", "")
    mod = type(sys)(name)
    exec(compile(src, name, "exec"), mod.__dict__)
    return mod


def asst(text=None, tool=None, inp=None):
    c = []
    if text:
        c.append({"type": "text", "text": text})
    if tool:
        c.append({"type": "tool_use", "name": tool, "input": inp or {}})
    return {"type": "assistant", "message": {"role": "assistant", "content": c}}


USER = {"type": "user", "message": {"role": "user", "content": "<channel>hi</channel>"}}
TOOLRES = {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "x"}]}}

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond:
        passed += 1; print("PASS", name)
    else:
        failed += 1; print("FAIL", name)


# ---- trace-tool.py ----
trace = load("trace-tool")
check("label Bash = command", trace.label("Bash", {"command": "grep -n x y.ts"}) == "grep -n x y.ts")
check("label Read = basename", trace.label("Read", {"file_path": "/a/b/server.ts"}) == "server.ts")
check("label Grep = pattern", trace.label("Grep", {"pattern": "editMessageText"}) == "editMessageText")
check("label telegram tool empty", trace.label("mcp__telegram-ss__reply", {}) == "")
check("label Skill name+args", trace.label("Skill", {"skill": "superpowers:brainstorming", "args": "x"}) == "brainstorming — x")
check("label Skill name only", trace.label("Skill", {"skill": "code-review"}) == "code-review")
check("disp strips mcp prefix", trace.disp("mcp__telegram-ss__reply") == "reply")
check("short collapses whitespace", trace.short("a   b\n c", 50) == "a b c")
check("short truncates", trace.short("x" * 100, 10).endswith("…") and len(trace.short("x" * 100, 10)) == 10)

# narration extraction — text + tool in the SAME assistant message
with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
    fh.write("\n".join(json.dumps(x) for x in [USER, asst("Смотрю код", "Grep", {"pattern": "x"})]))
    tp = fh.name
check("narration = same-message text", trace.last_assistant_narration(tp) == "Смотрю код")
os.unlink(tp)

# REGRESSION: CC splits each block into its own assistant message
# (thinking / text / tool_use on separate lines). Narration must walk back
# past the tool_use-only message to the nearest text block.
def msg(*blocks):
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}
sep = [USER,
       msg({"type": "thinking", "thinking": "private"}),
       msg({"type": "text", "text": "Сейчас проверю install.sh"}),
       msg({"type": "tool_use", "name": "Bash", "input": {}})]
with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
    fh.write("\n".join(json.dumps(x) for x in sep)); tp = fh.name
check("narration walks back across separate messages", trace.last_assistant_narration(tp) == "Сейчас проверю install.sh")
os.unlink(tp)

# thinking fallback when the turn has no visible text
thonly = [USER, msg({"type": "thinking", "thinking": "only thinking"}), msg({"type": "tool_use", "name": "Read", "input": {}})]
with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
    fh.write("\n".join(json.dumps(x) for x in thonly)); tp = fh.name
check("narration falls back to thinking", trace.last_assistant_narration(tp) == "only thinking")
os.unlink(tp)

# must NOT pull narration from a previous turn (stop at real user message)
prev = [msg({"type": "text", "text": "old turn narration"}), USER, msg({"type": "tool_use", "name": "Bash", "input": {}})]
with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
    fh.write("\n".join(json.dumps(x) for x in prev)); tp = fh.name
check("narration stops at user boundary", trace.last_assistant_narration(tp) == "")
os.unlink(tp)


# ---- trace-tool.py main(): Pre/PostToolUse active-command marker ----
def run_trace(tool, event, thread, tool_input=None):
    old = sys.stdin
    sys.stdin = io.StringIO(json.dumps({
        "tool_name": tool, "hook_event_name": event, "tool_input": tool_input or {},
    }))
    os.environ["CLAUDE_THREAD_ID"] = thread
    try:
        trace.main()
    finally:
        sys.stdin = old

TT = "555111"
tf, af = trace.trace_file(TT), trace.active_file(TT)
for p in (tf, af):
    if os.path.exists(p):
        os.remove(p)

# PreToolUse: marks the running tool, writes NOTHING to the trace yet.
run_trace("Bash", "PreToolUse", TT, {"command": "sleep 5 && echo hi"})
check("Pre sets active marker", os.path.exists(af) and open(af).read().strip() == "Bash: sleep 5 && echo hi")
check("Pre does not touch trace", not os.path.exists(tf))

# PostToolUse: appends the • line AND clears the active marker.
run_trace("Bash", "PostToolUse", TT, {"command": "sleep 5 && echo hi"})
check("Post appends bullet line", os.path.exists(tf) and open(tf).read().strip() == "• Bash: sleep 5 && echo hi")
check("Post clears active marker", not os.path.exists(af))

# Missing hook_event_name → back-compat PostToolUse behaviour.
run_trace("Read", None, TT, {"file_path": "/a/server.ts"})
check("no event defaults to Post (logs)", "• Read: server.ts" in open(tf).read())

# Our own telegram tools never enter the trace/active marker.
run_trace("mcp__telegram-ss__reply", "PreToolUse", TT, {})
check("telegram tool skipped on Pre", not os.path.exists(af))
for p in (tf, af):
    if os.path.exists(p):
        os.remove(p)


# ---- ensure-delivery.py ----
ed = load("ensure-delivery")
ed.time = type("T", (), {"sleep": staticmethod(lambda *a: None)})  # no settle delay in tests
calls = []
ed.tg_api = lambda token, method, params: (calls.append((method, params.get("text", "")[:40])) or True)

def run_hook(transcript, stop_active=False, thread="0"):
    calls.clear()
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        fh.write("\n".join(json.dumps(x) for x in transcript))
        p = fh.name
    os.environ.update(TELEGRAM_BOT_TOKEN="T", CLAUDE_CHAT_ID="9", CLAUDE_THREAD_ID=thread)
    old = sys.stdin
    sys.stdin = io.StringIO(json.dumps({"transcript_path": p, "stop_hook_active": stop_active}))
    try:
        ed.main()
    finally:
        sys.stdin = old
        os.unlink(p)
    return list(calls)

def methods(c):
    return [m for m, _ in c]

check("delivered (reply tool) → no send", methods(run_hook([USER, asst(None, "mcp__telegram-ss__reply")])) == [])
check("undelivered text → sends", methods(run_hook([USER, asst("the answer")])) == ["sendMessage"])
check("text after tool_result, no reply → sends", methods(run_hook([USER, asst(None, "Bash"), TOOLRES, asst("done")])) == ["sendMessage"])
check("loop guard (stop_hook_active) → no send", methods(run_hook([USER, asst("x")], stop_active=True)) == [])
check("silent tool-only turn → no send", methods(run_hook([USER, asst(None, "Bash"), TOOLRES])) == [])

# REGRESSION: deliver only the LAST text block (the answer), not intermediate narration
multi = run_hook([USER, asst("Считаю строки"), asst(None, "Bash"), TOOLRES, asst("Итог: 1896 строк")])
check("delivers only final text block", multi == [("sendMessage", "Итог: 1896 строк")])

# REGRESSION: a consumed status bubble means reply already delivered → no send
TH = "987654"
sfp = f"/tmp/claude-tg-status-{TH}.json"
json.dump({"chat_id": 9, "thread_id": int(TH), "message_id": 1, "consumed": True}, open(sfp, "w"))
check("consumed bubble → no double-send", methods(run_hook([USER, asst("answer")], thread=TH)) == [])
os.unlink(sfp)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
