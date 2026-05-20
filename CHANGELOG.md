# Changelog

All notable changes to this project. SemVer pre-1.0: minor (0.x.0) for new
features and breaking changes, patch (0.x.y) for bug fixes only.

## 0.1.0 — 2026-05-20

First taggable release. Forked from `telegram@claude-plugins-official` and
rebuilt around a separate dispatcher daemon to support multi-session usage
via forum topics.

### Architecture

- **Split**: the in-session MCP (`telegram-ss/server.ts`) no longer owns the
  Telegram long-poll. A new dispatcher daemon (`telegram-launcher/launcher.ts`)
  is the single `getUpdates` consumer and routes inbound to per-topic MCPs
  over a Unix socket (`dispatcher.sock`).
- **SessionRegistry** persists `(thread_id → tmux session)` in
  `sessions.json` so a dispatcher restart picks up where it left off.
- **One bot token, N parallel sessions**: each forum topic is its own Claude
  Code session in its own tmux pane. Outbound from the MCP uses bot.api
  directly; a grammy transformer auto-injects `message_thread_id` per session.
- **Claude-side surface unchanged**: same `experimental.claude/channel`
  capability, same `notifications/claude/channel` payload shape, same
  `reply` / `ask_user` / `react` / `edit_message` / `start_typing` tool
  signatures. Threads are hidden below Claude's awareness.

### Features

- **Auto-launch on first message** in a new topic — no Launch button. The
  message is queued and delivered to the new MCP after register + 800ms
  (gives Claude time to wire up its channel handler).
- **Continuous typing indicator** during the ~5s spawn so the user sees
  *something* between sending and Claude's first reply.
- **Auto-titled topics**: dispatcher renames the topic to the truncated
  first line immediately; Claude (via the new `rename_topic` MCP tool +
  instructions in the system prompt) overwrites with a ChatGPT-style 2-5
  word title once it understands the conversation.
- **Deleted-topic detection**: periodic stealth `sendMessage` +
  `deleteMessage` probe per session catches `message thread not found`,
  cleans up the orphaned tmux session.
- **MCP auto-starts typing+streaming on every inbound** so feedback shows
  up immediately on follow-up messages, not just first ones.
- **TUI commands routed over the socket**: `/effort`, `/model`, `/mode`,
  `/clear`, `/interrupt`, `/resume`. `/effort` shows the current level;
  `/model` opens Claude's picker (mirrored as inline buttons via
  `parseDialog`).
- **Confirmation dialogs surfaced as buttons**: when Claude's TUI renders
  a `❯ 1. Yes 2. No` confirm, the dispatcher mirrors it to Telegram and
  routes the user's tap back over the socket.
- **Live trace streaming** via `sendMessageDraft` so Claude's in-flight
  tool calls (`● Read /path`, `● Bash(...)`) appear as a single
  live-updating message instead of a chain of spammy interim replies.
- **Stop notification**: when a session disconnects (crash or explicit
  `tmux kill-session`), the dispatcher edits the launch message and posts
  a relaunch menu in the topic.

### Setup

- One-shot `install.sh` — checks prereqs, installs deps, writes `.env`
  template, symlinks `claude-channels-tmux` into `$BIN_DIR`, registers the
  MCP in `~/projects/.claude/settings.json`, drops a systemd user unit
  with paths expanded via `sed`. Idempotent.
- `telegram-launcher/telegram-launcher.service.in` template — committed
  with `@BUN@`/`@LAUNCHER@`/`@WORKDIR@` placeholders.

### Tripwires resolved during the rewrite

These are documented in `MEMORY.md` and inline comments — listing for
posterity since they ate a lot of debug time:

- `--dangerously-load-development-channels` argument needs the `server:`
  prefix (tagged form). Bare names rejected.
- Passing both `--channels server:X` and `--dangerously-load-development-channels server:X`
  creates two entries; the channel-loader's `Array.find()` returns the
  non-dev one and rejects inbound. Pass only the dev flag for `server:`
  channels.
- The dev-channels dialog has to be auto-Enter'd inside tmux from a
  non-TTY context.
- tmux strips most env vars when spawning a pane; `claude`'s absolute path
  and `CLAUDE_THREAD_ID` / `CLAUDE_CHAT_ID` / `CLAUDE_DISPATCHER_SOCK`
  must be re-injected via `tmux new-session -e ...`.
- systemd's default `KillMode=control-group` kills the spawned tmux+Claude
  when the dispatcher exits. Set `KillMode=process`.
- `detached: true` on the Node spawn confuses tmux daemonize — claude
  exits ~5s in with no error. Plain `spawn` works.
- Topic existence isn't queryable via a dedicated method —
  `editForumTopic({})` returns `ok:true` for any thread_id including
  bogus ones. `sendMessage` is the only thing that errors with
  `message thread not found`.
