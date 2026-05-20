#!/usr/bin/env bash
#
# claude-channels-custom-tg installer.
#
# Sets up the Telegram dispatcher + MCP plugin on a single-user Linux box.
# Idempotent — safe to re-run after pulling new commits.
#
# Prereqs you install yourself:
#   - bun (https://bun.sh)
#   - tmux
#   - claude (Claude Code CLI, usually in ~/.local/bin)
#   - a bot token from @BotFather (set "Allow Topics in Private Chats" on)
#   - lingering systemd user manager (loginctl enable-linger $USER, if not already)
#
# Override locations via env vars before running:
#   PROJECTS_DIR     default $HOME/projects     (cwd Claude runs in, holds .claude/settings.json)
#   BIN_DIR          default $HOME/.local/bin   (where the launcher symlink lands)
#   STATE_DIR        default $HOME/.claude/channels/telegram   (.env, bot.pid, sessions.json)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECTS_DIR="${PROJECTS_DIR:-$HOME/projects}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${STATE_DIR:-$HOME/.claude/channels/telegram}"
SYSTEMD_DIR="$HOME/.config/systemd/user"
UNIT_NAME="telegram-launcher.service"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

say "claude-channels-custom-tg installer"
echo "    repo:        $REPO_DIR"
echo "    projects:    $PROJECTS_DIR"
echo "    bin:         $BIN_DIR"
echo "    state:       $STATE_DIR"
echo "    systemd dir: $SYSTEMD_DIR"
echo

# ─── 1. Prerequisites ────────────────────────────────────────────────────
say "Checking prerequisites"
for cmd in bun tmux claude jq; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' not found in PATH. Install it and re-run."
done
ok "bun, tmux, claude, jq present"
BUN_BIN="$(command -v bun)"
CLAUDE_BIN="$(command -v claude)"

# ─── 2. Bun dependencies ─────────────────────────────────────────────────
say "Installing JS dependencies"
( cd "$REPO_DIR/telegram-launcher" && "$BUN_BIN" install --no-summary )
( cd "$REPO_DIR/telegram-ss"       && "$BUN_BIN" install --no-summary )
ok "deps installed"

# ─── 3. State directory + .env template ──────────────────────────────────
say "Preparing state directory"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
ENV_FILE="$STATE_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'EOF'
# Telegram bot token from @BotFather. Format: 123456789:AAH...
TELEGRAM_BOT_TOKEN=replace-me
EOF
  chmod 600 "$ENV_FILE"
  ok "wrote $ENV_FILE — edit before first start"
  ENV_NEEDS_EDIT=1
else
  ok ".env already present"
fi

# ─── 4. Symlink launcher script ──────────────────────────────────────────
say "Installing claude-channels-tmux launcher"
mkdir -p "$BIN_DIR"
ln -sf "$REPO_DIR/telegram-launcher/claude-channels-tmux" "$BIN_DIR/claude-channels-tmux"
ok "symlinked → $BIN_DIR/claude-channels-tmux"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not in your PATH; add it to ~/.bashrc or equivalent" ;;
esac

# ─── 5. MCP registration in project settings ─────────────────────────────
say "Registering MCP in $PROJECTS_DIR/.claude/settings.json"
mkdir -p "$PROJECTS_DIR/.claude"
SETTINGS="$PROJECTS_DIR/.claude/settings.json"
MCP_PATH="$REPO_DIR/telegram-ss"

# jq merge: read existing settings (or default {}), set mcpServers.telegram-ss.
if [[ -f "$SETTINGS" ]]; then
  cur=$(cat "$SETTINGS")
else
  cur='{}'
fi
new=$(echo "$cur" | jq --arg cwd "$MCP_PATH" --arg bun "$BUN_BIN" '
  .mcpServers = (.mcpServers // {}) |
  .mcpServers["telegram-ss"] = {
    command: $bun,
    args: ["run", "--cwd", $cwd, "--shell=bun", "--silent", "start"]
  }
')
tmp=$(mktemp)
echo "$new" > "$tmp"
mv "$tmp" "$SETTINGS"
ok "MCP registered"

# ─── 6. systemd user unit ────────────────────────────────────────────────
say "Installing systemd user unit"
mkdir -p "$SYSTEMD_DIR"
UNIT="$SYSTEMD_DIR/$UNIT_NAME"
sed \
  -e "s|@BUN@|$BUN_BIN|g" \
  -e "s|@LAUNCHER@|$REPO_DIR/telegram-launcher/launcher.ts|g" \
  -e "s|@WORKDIR@|$REPO_DIR/telegram-launcher|g" \
  "$REPO_DIR/telegram-launcher/telegram-launcher.service.in" > "$UNIT"
systemctl --user daemon-reload
ok "wrote $UNIT and reloaded systemd"

# ─── 7. Enable + start (if .env is filled in) ────────────────────────────
if [[ "${ENV_NEEDS_EDIT:-}" = "1" ]]; then
  warn "Skipping service start — $ENV_FILE still has 'replace-me' in it."
  warn "Put the real token there, then: systemctl --user enable --now $UNIT_NAME"
else
  if grep -q 'replace-me' "$ENV_FILE"; then
    warn "$ENV_FILE still contains 'replace-me'. Fix it, then enable the service."
  else
    say "Enabling and starting service"
    systemctl --user enable --now "$UNIT_NAME"
    sleep 1
    if systemctl --user is-active --quiet "$UNIT_NAME"; then
      ok "service is active"
    else
      warn "service is not active — run: systemctl --user status $UNIT_NAME"
    fi
  fi
fi

echo
say "Done. Next steps:"
cat <<EOF

  1. Put your BotFather token in $ENV_FILE
  2. In BotFather: /mybots → your bot → Bot Settings → Allow Topics in Private Chats
     (so you can have parallel sessions; without this you get one session in DM root)
  3. systemctl --user enable --now $UNIT_NAME   (if not already)
  4. Verify:   systemctl --user status $UNIT_NAME
               journalctl --user -u $UNIT_NAME -f
  5. DM your bot — it'll reply with a 6-char pairing code
  6. In any Claude Code session:   /telegram:access pair <code>
  7. After pairing: in DM root you get a launch menu;
     in each new topic the FIRST message auto-spawns a Claude session.

EOF
