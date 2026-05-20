# Changelog

All notable changes to this project. SemVer pre-1.0: minor (0.x.0) for new
features and breaking changes, patch (0.x.y) for bug fixes only.

## 0.1.2 — 2026-05-20

Filesystem hygiene release.

### Features

- **Per-topic working directory**: each forum-topic session now runs in
  `~/claude-tg/topic-<id>/` (root DM in `~/claude-tg/root/`) instead of a
  shared `~/projects/`. Side benefits:
  - Files from different topics no longer intermix.
  - `claude --continue` correctly resumes *this topic's* history because
    Claude's per-cwd session storage now isolates topics naturally.
  - On topic delete, the entire subtree can be archived/dropped without
    affecting other sessions.
  Override via `CLAUDE_TOPIC_ROOT` env var; spawn-time symlinks each
  per-topic `.claude` to the shared `~/claude-tg/.claude` so MCP +
  skills config stays single-source-of-truth.
- **Disk hygiene sweep** in dispatcher: hourly cleanup of
  `/tmp/claude-spawn*.log` older than `CLAUDE_LOG_TTL_DAYS` (default 7) and
  `~/.claude/channels/telegram/inbox/*` older than `CLAUDE_INBOX_TTL_DAYS`
  (default 30). Initial run 30s after start so the dispatcher doesn't
  block on it.
- **Rename-topic enforcement on first message**: the dispatcher now
  prepends `[TASK: rename_topic(...) BEFORE any reply]` to the content of
  the first message in a fresh topic, and the MCP system prompt opens
  with a HARD RULE telling Claude to obey the marker. Claude was
  consistently forgetting the upstream-style "auto-title" hint when it
  was buried in the middle of a long instructions block.
- **Filesystem hygiene hint in MCP system prompt**: tells Claude to keep
  project artifacts in cwd, use `/tmp` for ephemerals, and stay out of
  `~/` root / `~/.claude/`. Defense in depth — Claude usually does the
  right thing already, but the hint catches the edge cases.

### Setup

- **install.sh updated**: writes MCP config to `$TOPIC_ROOT/.claude/`
  (default `~/claude-tg/.claude/`) instead of `$PROJECTS_DIR/.claude/`.
  Pre-creates `~/claude-tg/root/` and its `.claude` symlink. Existing
  installs from 0.1.x can re-run; the old `~/projects/.claude/settings.json`
  is left in place untouched (you can delete it manually if you don't
  use `~/projects` for anything else).

## 0.1.1 — 2026-05-20

Bug-fix patch on top of 0.1.0, all problems found while dogfooding.

### Fixes

- **File uploads through HTTP_PROXY**: `reply` with attachments hung 62s and
  failed with "Network request for 'sendDocument' failed!" because grammy's
  `InputFile` streams the multipart body through Node `https.Agent`, which
  bun + proxy choke on. We bypass grammy for the file path now and post a
  plain `FormData`+`fetch` to `/sendDocument` / `/sendPhoto` — completes in
  <1s through the same proxy.
- **Edit-based live trace** (was: `sendMessageDraft`): drafts have no
  `disable_notification`; some Telegram clients raised the unread badge on
  every ~1.5s tick, producing a "5 unread" effect for a single in-flight
  turn. Switched to `sendMessage` + `editMessageText` (openclaw-style) — one
  unread for the first content, edits silent thereafter. Trace message is
  deleted on `stopStreaming` so chat history stays clean.
- **MCP auto-starts streaming on inbound**: was opt-in via `start_typing`,
  meaning follow-up messages got typing but no trace. Re-enabled the
  auto-start now that drafts are gone.
- **Deferred tool loading dropping `reply`**: Claude Code 2.x defaults to
  tool-search ON, which marks all MCP tools as deferred and excludes
  unreferenced ones from the model context. After a few short turns the
  model would forget about the `reply` tool, render its response in the
  TUI only, and silently drop the message — until the user pinged again
  and re-discovered the tool. Pinned `ENABLE_TOOL_SEARCH=false` in
  `claude-channels-tmux` so every spawned session keeps reply available.
- **Per-thread `--debug-file`**: parallel sessions were sharing
  `/tmp/claude-spawn.log` and clobbering each other (claude truncates the
  file on each session start). Now `/tmp/claude-spawn-t<thread>.log`.
- **`HTTP_PROXY` survives tmux pane spawn**: tmux strips most env vars at
  pane creation; we now explicitly `-e` forward the proxy vars too.

### Setup

- **install.sh**: optional auto-install of missing prereqs.  Detects
  apt/dnf/pacman/zypper/brew, prints distro-appropriate commands, and (in
  interactive mode) prompts to run them. `bun` via the official user-level
  curl|bash, `tmux`/`jq` via the system package manager with `sudo`.
- **Russian README is now primary** at `README.md`; English moved to
  `README.en.md` with reciprocal links. Default GitHub view is Russian now.

### Internal

- launcher.ts `LAUNCHER_BIN` default switched from a `/home/clawd/...`
  hardcode to `import.meta.dir + '/claude-channels-tmux'`. The install
  script's symlink in `$BIN_DIR` remains the canonical way to invoke from
  outside, but the dispatcher now finds its sibling script reliably.

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
