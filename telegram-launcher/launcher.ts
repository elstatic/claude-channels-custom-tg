// Telegram launcher watchdog: polls the bot while Claude is *not* running, and
// offers inline-button menus to start/continue Claude via `claude-channels-tmux`.
//
// Coordination with the in-session MCP (server.ts):
//   - bot.pid is the canonical poll-lock indicator.
//   - server.ts:60-69 SIGTERMs the previous holder when it starts.
//   - We never SIGTERM anyone; we only wait. (A SIGTERM-on-startup loop in the
//     watchdog would kill the freshly-started MCP after systemd restarts us.)
//
// Lifecycle under systemd:
//   - Service starts → waitUntilFree() blocks until bot.pid is free AND no
//     interactive Claude is running.
//   - We claim the lock, start grammy.
//   - User taps a button → spawn `claude-channels-tmux <start|continue>` and
//     return to the wait loop. The new MCP will overwrite bot.pid and the
//     `pgrep claude` check keeps us waiting until that session ends.
//   - SIGTERM from the new MCP (or systemd stop) → bot.stop() and exit.
import { Bot, InlineKeyboard } from 'grammy'
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const PID_FILE = join(STATE_DIR, 'bot.pid')
const MARKER_FILE = join(STATE_DIR, 'launcher.marker')
const LAUNCHER_BIN = process.env.CLAUDE_LAUNCHER_BIN ?? '/home/clawd/.openclaw/workspace/bin/claude-channels-tmux'

type LaunchMarker = { chatId: number; action: 'launch' | 'continue' }
function writeMarker(m: LaunchMarker) { try { writeFileSync(MARKER_FILE, JSON.stringify(m)) } catch {} }
function readMarker(): LaunchMarker | null { try { return JSON.parse(readFileSync(MARKER_FILE, 'utf8')) } catch { return null } }
function clearMarker() { try { unlinkSync(MARKER_FILE) } catch {} }

try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(`telegram-launcher: TELEGRAM_BOT_TOKEN required (set in ${ENV_FILE})\n`)
  process.exit(1)
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

function isAllowed(userId: number | string): boolean {
  try {
    const access = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
    return Array.isArray(access.allowFrom) && access.allowFrom.includes(String(userId))
  } catch {
    return false
  }
}

function lockHeldByOther(): boolean {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    if (!(pid > 1) || pid === process.pid) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilFree(): Promise<{ waited: boolean }> {
  // bot.pid is the canonical indicator: server.ts writes its pid there, we
  // write ours there. As long as the file points to a live process that
  // isn't us, we yield. Caller wants to know if we *actually* waited so it
  // can distinguish "cold start, no Claude was ever running" from
  // "Claude session ended, we're taking the lock back".
  let waited = false
  while (lockHeldByOther()) {
    waited = true
    await new Promise(r => setTimeout(r, 5000))
  }
  return { waited }
}

const menu = new InlineKeyboard()
  .text('🚀 Запустить', 'launch')
  .text('↻ Продолжить', 'continue')

// When a user taps Запустить/Продолжить we edit the menu message to
// "Запускаю…", remember which message that was, then on SIGTERM-from-MCP
// (which only fires after the MCP successfully wrote its pid to bot.pid)
// edit it once more to "Claude запущен ✓". The SIGTERM is the only signal we
// trust as proof-of-life; if Claude failed to start, no SIGTERM, no edit, and
// "Запускаю…" stays — that matches the "только если реально запущено" rule.
let pendingLaunchAck: { chatId: number; messageId: number; ackLabel: string } | null = null

async function runOnce(): Promise<'launched' | 'sigterm'> {
  const { waited } = await waitUntilFree()
  writeFileSync(PID_FILE, String(process.pid))

  const bot = new Bot(TOKEN!)

  // If we just took over after another process held the lock and a marker
  // says we launched Claude, that's a Claude session that just ended (clean
  // exit, crash, manual `tmux kill-session`, …). Tell the user so they're not
  // left wondering why nothing's answering.
  if (waited) {
    const marker = readMarker()
    if (marker) {
      clearMarker()
      await bot.api.sendMessage(
        marker.chatId,
        'Claude остановился. Что сделать?',
        { reply_markup: menu },
      ).catch(() => {})
    }
  }

  return new Promise<'launched' | 'sigterm'>(resolve => {
    let settled = false
    const sigtermHandler = () => {
      // SIGTERM almost certainly came from the new MCP's startup pid-takeover.
      // Edit the launching message into a success ack before we exit.
      const ack = pendingLaunchAck
      if (ack) {
        pendingLaunchAck = null
        bot.api.editMessageText(ack.chatId, ack.messageId, ack.ackLabel).catch(() => {})
      }
      finish('sigterm')
    }

    function finish(reason: 'launched' | 'sigterm') {
      if (settled) return
      settled = true
      process.removeListener('SIGTERM', sigtermHandler)
      process.removeListener('SIGINT', sigtermHandler)
      bot.stop().finally(() => resolve(reason))
    }

    process.on('SIGTERM', sigtermHandler)
    process.on('SIGINT', sigtermHandler)

    bot.command('start', async ctx => {
      if (!ctx.from || !isAllowed(ctx.from.id)) return
      await ctx.reply('Claude не запущен. Что сделать?', { reply_markup: menu })
    })

    bot.on('message', async ctx => {
      if (!ctx.from || !isAllowed(ctx.from.id)) return
      if (ctx.message.text?.startsWith('/')) return
      await ctx.reply('Claude не запущен. Что сделать?', { reply_markup: menu })
    })

    bot.on('callback_query:data', async ctx => {
      if (!ctx.from || !isAllowed(ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: 'Not allowed', show_alert: true })
        return
      }
      const action = ctx.callbackQuery.data
      if (action !== 'launch' && action !== 'continue') {
        await ctx.answerCallbackQuery({ text: 'unknown action' })
        return
      }
      await ctx.answerCallbackQuery()
      const label = action === 'launch' ? 'Запускаю claude…' : 'Продолжаю последнюю сессию…'
      const ackLabel = action === 'launch' ? 'Claude запущен ✓' : 'Claude продолжен ✓'
      try {
        await ctx.editMessageText(label)
        if (ctx.callbackQuery.message) {
          pendingLaunchAck = {
            chatId: ctx.callbackQuery.message.chat.id,
            messageId: ctx.callbackQuery.message.message_id,
            ackLabel,
          }
          writeMarker({ chatId: ctx.callbackQuery.message.chat.id, action })
        }
      } catch {}

      process.stderr.write(`telegram-launcher: spawning ${LAUNCHER_BIN} ${action === 'launch' ? 'start' : 'continue'}\n`)
      // No detached:true — that puts the child in its own session/cgroup and
      // (empirically) confuses tmux daemonize, causing the spawned claude to
      // exit ~5s after startup with no error in its debug log. With plain
      // spawn the bash launcher script runs to completion in our cgroup, tmux
      // daemonizes cleanly, and claude lives.
      const sub = spawn(LAUNCHER_BIN, [action === 'launch' ? 'start' : 'continue'], {
        stdio: 'inherit',
      })
      sub.on('error', err => {
        process.stderr.write(`telegram-launcher: spawn error: ${err}\n`)
      })
      sub.on('exit', (code, signal) => {
        process.stderr.write(`telegram-launcher: child exit code=${code} signal=${signal}\n`)
      })

      finish('launched')
    })

    bot.start({ drop_pending_updates: false }).catch(err => {
      process.stderr.write(`telegram-launcher: bot.start failed: ${err}\n`)
      finish('sigterm')
    })
  })
}

;(async () => {
  // Cold-start hygiene: if a launcher marker is left over but no process is
  // currently holding bot.pid, the previous incarnation crashed without
  // delivering the "Claude остановился" message. Clearing keeps us from
  // notifying about a stale event the next time Claude exits.
  if (readMarker() && !lockHeldByOther()) clearMarker()
  while (true) {
    const reason = await runOnce()
    if (reason === 'sigterm') process.exit(0)
    // 'launched' → loop back, waitUntilFree() will park us until the new
    // Claude session exits.
  }
})()
