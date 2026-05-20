# claude-channels-custom-tg

Run multiple parallel **Claude Code sessions over one Telegram bot**, with each session living in its own forum topic. The first message in a new topic auto-spawns a Claude session; deleted topics are detected and cleaned up; the bot lives as a systemd user service.

This is a heavily customized fork of the official [`telegram@claude-plugins-official`](https://github.com/anthropics/claude-code/tree/main/plugins) channel plugin, plus a separate dispatcher daemon that handles all the cross-session plumbing.

## Quick start

```bash
git clone https://github.com/elstatic/claude-channels-custom-tg ~/claude-channels-custom-tg
cd ~/claude-channels-custom-tg
./install.sh
# put your BotFather token in ~/.claude/channels/telegram/.env
systemctl --user enable --now telegram-launcher.service
```

Then DM your bot to pair, run `/telegram:access pair <code>` in any Claude Code session, and you're good. See [`install.sh`](./install.sh) for the full sequence printed at the end.

## Prerequisites

Install these first; the installer just checks for them:

| Tool   | Used for                                                       |
| ------ | -------------------------------------------------------------- |
| bun    | runs the dispatcher and the MCP                                |
| tmux   | each Claude session lives in its own detached tmux pane        |
| claude | Claude Code CLI                                                |
| jq     | merging into existing `~/projects/.claude/settings.json`       |
| systemd user manager | the dispatcher runs as `telegram-launcher.service` |

Plus, in BotFather: **`/mybots` → your bot → Bot Settings → Allow Topics in Private Chats**. Without this you only get one session in the DM root; with it, each topic is a parallel session.

If your user services don't survive logout: `sudo loginctl enable-linger $USER`.

## Architecture

```
        ┌────────────────────────────────────┐
        │  telegram-launcher (systemd unit)  │  ← single owner of bot.pid + getUpdates
        │  - gate, pairing, /effort etc.     │
        │  - SessionRegistry by thread_id    │
        │  - spawnSession on first message   │
        │  - Unix socket: dispatcher.sock    │
        └───────────────┬────────────────────┘
                        │  inbound JSON over socket
        ┌───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
   tmux+claude     tmux+claude     tmux+claude    ...
   per topic       per topic       per topic
   (MCP child)     (MCP child)     (MCP child)
```

- **`telegram-launcher/launcher.ts`** — dispatcher daemon. One process, holds the bot token long-poll, routes inbound to per-topic MCPs over `dispatcher.sock`.
- **`telegram-ss/server.ts`** — in-session MCP. One instance per Claude session (per topic). Connects to dispatcher socket on startup. Outbound (`reply`, `react`, …) goes through `bot.api` directly with `message_thread_id` injected per session.
- **`telegram-launcher/claude-channels-tmux`** — bash wrapper that boots Claude inside a named tmux session with the right env (`CLAUDE_THREAD_ID`, `CLAUDE_CHAT_ID`, `CLAUDE_DISPATCHER_SOCK`).

State lives in `~/.claude/channels/telegram/`:
- `.env` — bot token (`TELEGRAM_BOT_TOKEN=...`, 0600 perms)
- `access.json` — pairing / allowlist, managed by the `/telegram:access` skill
- `bot.pid` — dispatcher's single-instance marker
- `dispatcher.sock` — Unix socket the MCPs connect to
- `sessions.json` — persistent registry of `(thread_id → tmux session)`

## What you get

Behaviors that aren't in the upstream plugin:

- **Multi-session by topic**: every forum topic in your DM with the bot is an independent Claude Code session, with its own conversation history and tmux pane.
- **Auto-launch on first message**: no Launch button — write in a fresh topic, Claude spawns automatically, the message is queued and delivered as soon as the session connects.
- **Continuous typing-indicator** during the spawn window, so you see *something* while Claude starts.
- **Auto-titled topics**: dispatcher renames to a truncated first line immediately, then Claude (via the `rename_topic` MCP tool) overwrites with a smarter ChatGPT-style title.
- **Deleted-topic detection**: the dispatcher periodically probes each topic via a stealth `sendMessage` + `deleteMessage` round-trip; topics that return *"message thread not found"* get their tmux sessions killed.
- **/effort, /model, /mode, /clear, /interrupt, /resume** routed to the in-topic Claude TUI via the dispatcher → MCP RPC.
- **Confirmation dialogs as buttons**: when Claude's TUI surfaces a `❯ 1. Yes 2. No` dialog, it's mirrored to Telegram as inline buttons.
- **Live streaming** of Claude's in-flight tool calls via `sendMessageDraft` so you see what it's doing without one-message-per-step spam.

## Repo layout

```
.
├── install.sh                       # one-shot installer (idempotent)
├── README.md                        # you're reading it
├── telegram-launcher/
│   ├── launcher.ts                  # the dispatcher
│   ├── ipc.ts                       # Unix socket protocol
│   ├── sessions.ts                  # SessionRegistry + persist
│   ├── claude-channels-tmux         # bash wrapper, spawns tmux+claude
│   ├── telegram-launcher.service.in # systemd unit template
│   └── package.json                 # grammy dep
└── telegram-ss/
    ├── server.ts                    # the MCP
    ├── package.json
    ├── README.md                    # upstream-flavored docs, kept for reference
    ├── ACCESS.md                    # access.json schema & /telegram:access flow
    └── skills/                      # /telegram:access, /telegram:configure
```

## License

Apache-2.0, same as the upstream plugin.
