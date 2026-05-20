// telegram-launcher: the Telegram dispatcher.
//
// This process is the SINGLE long-poll consumer of the bot token. It owns:
//   - bot.start / getUpdates / setMyCommands
//   - access gate (pairing, allowlist, group policy)
//   - all bot.command and bot.on(message:*|callback_query) handlers
//   - the session registry (thread_id → tmux session + MCP socket)
//   - per-session spawn via claude-channels-tmux
//
// Inbound messages get routed to the matching MCP over a Unix-socket IPC
// channel as JSON `{type: "inbound", method, params}`. The MCP turns them
// into MCP notifications for Claude. Outbound (reply, react, …) MCP still
// does directly via bot.api — REST and getUpdates coexist on one token.
//
// Lifecycle: this process runs forever. systemd `KillMode=process` keeps the
// spawned tmux/Claude sessions alive past our exit. We don't yield the lock.
//
// The "ChatId == thread_id ?? 0" convention: when an update has no
// message_thread_id (regular private chat, or general topic), we use 0.
// SessionRegistry is keyed by `${chatId}:${threadId}`.

import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { spawn, spawnSync } from 'child_process'
import {
  readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, readdirSync, rmSync, statSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type net from 'net'

import {
  createIpcServer, sendJson,
  type McpToDispatcher,
} from './ipc'
import {
  SessionRegistry, defaultSessionsFile, defaultIpcSocket,
  type SessionRecord,
} from './sessions'

// ── State dir / files ─────────────────────────────────────────────────────
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const PID_FILE = join(STATE_DIR, 'bot.pid')
const SESSIONS_FILE = defaultSessionsFile(STATE_DIR)
const IPC_SOCKET = defaultIpcSocket(STATE_DIR)
// Defaults to the bash script that lives next to this file. The install
// script also drops a symlink in ~/.local/bin so users can invoke it from
// anywhere; override CLAUDE_LAUNCHER_BIN if you keep the script elsewhere.
const LAUNCHER_BIN = process.env.CLAUDE_LAUNCHER_BIN
  ?? join(import.meta.dir, 'claude-channels-tmux')

// ── .env loader ───────────────────────────────────────────────────────────
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(`telegram-dispatcher: TELEGRAM_BOT_TOKEN required (set in ${ENV_FILE})\n`)
  process.exit(1)
}
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// ── Single-instance lock ──────────────────────────────────────────────────
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    try {
      process.kill(stale, 0)
      process.stderr.write(`telegram-dispatcher: SIGTERMing previous holder pid=${stale}\n`)
      process.kill(stale, 'SIGTERM')
    } catch {}
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram-dispatcher: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram-dispatcher: uncaught exception: ${err}\n`)
})

// ── Access types ──────────────────────────────────────────────────────────
type PendingEntry = { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }
type GroupPolicy = { requireMention: boolean; allowFrom: string[] }
export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}
function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write('telegram-dispatcher: access.json corrupt, moved aside.\n')
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC ? (() => {
  const a = readAccessFile()
  if (a.dmPolicy === 'pairing') {
    process.stderr.write('telegram-dispatcher: static mode — pairing downgraded to allowlist\n')
    a.dmPolicy = 'allowlist'
  }
  a.pending = {}
  return a
})() : null

export function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

let botUsername = ''

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return { action: 'drop' }
  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type
  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId, chatId: String(ctx.chat!.id),
      createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }
  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    if (policy.allowFrom?.length > 0 && !policy.allowFrom.includes(senderId)) return { action: 'drop' }
    if ((policy.requireMention ?? true) && !isMentioned(ctx, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver', access }
  }
  return { action: 'drop' }
}

function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
  if (ctx.chat?.type !== 'private') return null
  if (!ctx.from) return null
  const senderId = String(ctx.from.id)
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

// ── Approvals polling (skill drops file at approved/<senderId>) ───────────
const bot = new Bot(TOKEN)
function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  if (files.length === 0) return
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, 'Paired! Say hi to Claude.')
      .then(() => rmSync(file, { force: true }))
      .catch(err => {
        process.stderr.write(`telegram-dispatcher: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      })
  }
}
if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ── Session registry + IPC server ─────────────────────────────────────────
const registry = new SessionRegistry(SESSIONS_FILE)
registry.load()

// On startup, prune sessions whose tmux session is gone. Their MCPs would
// never reconnect, so the records are stale.
const pruned = registry.pruneDead()
if (pruned.length > 0) {
  process.stderr.write(`telegram-dispatcher: pruned ${pruned.length} dead sessions: ${pruned.join(',')}\n`)
}

// Key into registry by (chat_id, thread_id). For the simple non-topic case
// thread_id is 0, which collapses to chat-keyed.
function regKey(chatId: number, threadId: number): number {
  // We pack (chatId, threadId) into a single number key for the registry.
  // chatIds can be negative (groups), but for our DM-centric use we keep
  // them as Number and the registry maps by threadId only. Multi-chat is
  // not in scope yet — we'd extend SessionRecord with chatId routing.
  return threadId
}

function getSession(ctx: Context): SessionRecord | undefined {
  const chatId = ctx.chat?.id
  if (!chatId) return undefined
  const threadId = ctx.message?.message_thread_id
    ?? (ctx.callbackQuery?.message as any)?.message_thread_id
    ?? 0
  return registry.get(regKey(chatId, threadId))
}

function contextThreadId(ctx: Context): number {
  return ctx.message?.message_thread_id
    ?? (ctx.callbackQuery?.message as any)?.message_thread_id
    ?? 0
}

// ── Spawn / kill ──────────────────────────────────────────────────────────
function spawnSession(opts: {
  chatId: number
  threadId: number
  action: 'launch' | 'continue'
}): void {
  const tmuxName = `claude_t${opts.threadId}`
  const env = {
    ...process.env,
    CLAUDE_TMUX_SESSION: tmuxName,
    CLAUDE_CHANNEL_SPEC: 'server:telegram-ss',
    CLAUDE_THREAD_ID: String(opts.threadId),
    CLAUDE_CHAT_ID: String(opts.chatId),
    CLAUDE_DISPATCHER_SOCK: IPC_SOCKET,
  }
  process.stderr.write(`telegram-dispatcher: spawning ${LAUNCHER_BIN} ${opts.action} (thread ${opts.threadId})\n`)
  const sub = spawn(LAUNCHER_BIN, [opts.action === 'launch' ? 'start' : 'continue'], {
    stdio: 'inherit', env,
  })
  sub.on('error', err => {
    process.stderr.write(`telegram-dispatcher: spawn error: ${err}\n`)
  })
  sub.on('exit', (code, signal) => {
    process.stderr.write(`telegram-dispatcher: launcher child exit code=${code} signal=${signal}\n`)
  })
  // Pre-register the session so inbound that races spawn doesn't trigger another menu.
  registry.add({
    threadId: opts.threadId,
    chatId: opts.chatId,
    tmuxSession: tmuxName,
  })
}

function killSession(threadId: number): void {
  const rec = registry.get(threadId)
  if (!rec) return
  try {
    spawnSync('tmux', ['kill-session', '-t', rec.tmuxSession], { stdio: 'ignore' })
  } catch {}
  registry.remove(threadId)
}

// ── Topic-existence probe ─────────────────────────────────────────────────
// Telegram doesn't emit a forum_topic_deleted event for DM-mode topics, so we
// can't react to deletion directly. Instead we send a single-character message
// disable_notification=true to each registered topic and immediately delete it
// — Telegram clients usually don't render a message that's deleted within
// ~500ms. If the send fails with "message thread not found", the topic was
// deleted and we can clean up the corresponding tmux+Claude session.

async function probeTopicAlive(chatId: number, threadId: number): Promise<boolean> {
  if (!threadId) return true
  try {
    const sent = await bot.api.sendMessage(chatId, '.', {
      message_thread_id: threadId,
      disable_notification: true,
    })
    bot.api.deleteMessage(chatId, sent.message_id).catch(() => {})
    return true
  } catch (err) {
    if (err instanceof GrammyError && /thread not found/i.test(err.description ?? '')) {
      return false
    }
    return true
  }
}

// ── Disk hygiene: TTL on debug logs and inbox attachments ────────────────
// Without this the server slowly fills with old per-thread claude-spawn
// logs and downloaded voice/photo attachments. Two configurable TTLs:
//   CLAUDE_LOG_TTL_DAYS      (default 7)  — /tmp/claude-spawn-t*.log
//   CLAUDE_INBOX_TTL_DAYS    (default 30) — ~/.claude/channels/telegram/inbox/*
const LOG_TTL_MS   = (parseInt(process.env.CLAUDE_LOG_TTL_DAYS ?? '7',  10) || 7)  * 86400_000
const INBOX_TTL_MS = (parseInt(process.env.CLAUDE_INBOX_TTL_DAYS ?? '30', 10) || 30) * 86400_000
const INBOX_DIR_HYGIENE = join(STATE_DIR, 'inbox')

async function sweepDiskHygiene(): Promise<void> {
  const now = Date.now()
  // /tmp/claude-spawn-t*.log
  try {
    const entries = readdirSync('/tmp')
    for (const name of entries) {
      if (!/^claude-spawn(-t\d+)?\.log$/.test(name)) continue
      const path = '/tmp/' + name
      try {
        const st = statSync(path)
        if (now - st.mtimeMs > LOG_TTL_MS) {
          rmSync(path, { force: true })
          process.stderr.write(`telegram-dispatcher: pruned old log ${path}\n`)
        }
      } catch {}
    }
  } catch {}
  // Inbox attachments
  try {
    const entries = readdirSync(INBOX_DIR_HYGIENE)
    for (const name of entries) {
      const path = join(INBOX_DIR_HYGIENE, name)
      try {
        const st = statSync(path)
        if (now - st.mtimeMs > INBOX_TTL_MS) {
          rmSync(path, { force: true })
          process.stderr.write(`telegram-dispatcher: pruned old inbox ${path}\n`)
        }
      } catch {}
    }
  } catch {}
}

const HYGIENE_INTERVAL_MS = 60 * 60 * 1000
setTimeout(() => { void sweepDiskHygiene() }, 30_000)
setInterval(() => { void sweepDiskHygiene() }, HYGIENE_INTERVAL_MS).unref()

async function sweepDeletedTopics(): Promise<void> {
  for (const rec of registry.all()) {
    if (!rec.threadId) continue
    const alive = await probeTopicAlive(rec.chatId, rec.threadId)
    if (!alive) {
      process.stderr.write(`telegram-dispatcher: topic ${rec.threadId} deleted, killing session\n`)
      killSession(rec.threadId)
    }
  }
}

const TOPIC_SWEEP_INTERVAL_MS = 60 * 1000
// Run an initial sweep shortly after startup (lets MCPs reconnect first), then
// periodically. Long-tail orphans created before this code existed get cleaned
// up automatically.
setTimeout(() => { void sweepDeletedTopics() }, 5000)
setInterval(() => { void sweepDeletedTopics() }, TOPIC_SWEEP_INTERVAL_MS).unref()

// ── IPC server: route inbound to MCP, handle MCP→dispatcher messages ──────
function ipcSend(threadId: number, msg: object): boolean {
  const sock = registry.socketOf(threadId)
  if (!sock || sock.destroyed) return false
  sendJson(sock, msg)
  return true
}

createIpcServer({
  path: IPC_SOCKET,
  onConnect(sock) {
    process.stderr.write(`telegram-dispatcher: ipc client connected\n`)
  },
  onMessage(sock, msg: McpToDispatcher) {
    if (msg.type === 'register') {
      const { thread_id, chat_id, pid } = msg
      // Make sure a record exists. If MCP spawned outside our knowledge,
      // create one so subsequent inbound routes work.
      if (!registry.has(thread_id)) {
        registry.add({
          threadId: thread_id,
          chatId: chat_id,
          tmuxSession: `claude_t${thread_id}`,
        })
      }
      registry.attachSocket(thread_id, sock, pid)
      process.stderr.write(`telegram-dispatcher: registered MCP thread=${thread_id} pid=${pid}\n`)
      // If we had a launching message pending for this thread, ack now.
      const ack = pendingAcks.get(thread_id)
      if (ack) {
        pendingAcks.delete(thread_id)
        bot.api.editMessageText(ack.chatId, ack.messageId, ack.label).catch(() => {})
      }
      // Flush any auto-launch queued inbound — messages that arrived before
      // the MCP was ready get delivered now in order. A short delay gives
      // Claude time to finish wiring up its channel notification handler
      // (the MCP `register` event fires on socket connect, but Claude's
      // capability subscription completes ~50-200ms after mcp.connect).
      setTimeout(() => drainQueue(thread_id), 800)
      return
    }
    if (msg.type === 'permission_reply' || msg.type === 'outbound_dialog') {
      // Server.ts side decided to surface a dialog or to relay a permission.
      // These currently aren't initiated dispatcher-side so we don't need to
      // handle them here — kept for protocol completeness.
      return
    }
  },
  onDisconnect(sock) {
    const threadId = registry.detachSocket(sock)
    if (threadId != null) {
      process.stderr.write(`telegram-dispatcher: MCP for thread=${threadId} disconnected\n`)
      // Notify the user that the session died and offer a relaunch menu.
      const rec = registry.get(threadId)
      if (rec) {
        notifySessionEnded(rec)
        registry.remove(threadId)
      }
    }
  },
})
process.stderr.write(`telegram-dispatcher: IPC server listening at ${IPC_SOCKET}\n`)

// Launch-ack tracking: thread_id → message to edit when MCP registers.
const pendingAcks = new Map<number, { chatId: number; messageId: number; label: string }>()

// Auto-launch state: messages that arrived before a session was up. Drained
// to the socket on MCP register. Per-thread queue + per-thread "spawning"
// guard so a burst of messages doesn't fire multiple `claude-channels-tmux`.
const pendingInboundQueue = new Map<number, Array<{ method: string; params: any }>>()
const spawningThreads = new Set<number>()
const SPAWN_TIMEOUT_MS = 60_000

function queueInbound(threadId: number, msg: { method: string; params: any }): void {
  let arr = pendingInboundQueue.get(threadId)
  if (!arr) { arr = []; pendingInboundQueue.set(threadId, arr) }
  arr.push(msg)
}

function drainQueue(threadId: number): void {
  const queue = pendingInboundQueue.get(threadId)
  if (!queue) return
  pendingInboundQueue.delete(threadId)
  spawningThreads.delete(threadId)
  stopSpawnTyping(threadId)
  for (const msg of queue) ipcSend(threadId, { type: 'inbound', method: msg.method, params: msg.params })
}

// Derive a topic name from the first user message. Telegram caps at 128
// chars; we keep it much tighter so the topic list stays readable. First
// line, trimmed, with an ellipsis on overflow.
function topicNameFromText(text: string): string {
  const firstLine = text.split('\n')[0].trim() || 'Claude'
  return firstLine.length > 30 ? firstLine.slice(0, 27) + '…' : firstLine
}

async function renameTopic(chatId: number, threadId: number, name: string): Promise<void> {
  if (!threadId) return // general/root chat — not a topic, can't rename
  try {
    await bot.api.editForumTopic(chatId, threadId, { name })
  } catch (err) {
    // Common causes: bot lacks `can_manage_topics`, or the chat isn't a forum.
    // Either way the spawned session still works; the name just stays default.
    process.stderr.write(`telegram-dispatcher: editForumTopic(${chatId},${threadId}) failed: ${err}\n`)
  }
}

// Per-thread typing-indicator loop kept alive while a session is spawning.
// Telegram chat actions persist ~5s — we re-send every 4s so the "печатает…"
// indicator stays visible from the moment the user's message arrives until
// the MCP registers and drains the queue.
const spawnTypingLoops = new Map<number, NodeJS.Timeout>()

function startSpawnTyping(threadId: number, chatId: number): void {
  stopSpawnTyping(threadId)
  const tick = () => {
    void bot.api.sendChatAction(chatId, 'typing', {
      message_thread_id: threadId || undefined,
    } as any).catch(() => {})
  }
  tick()
  const h = setInterval(tick, 4000)
  spawnTypingLoops.set(threadId, h)
}

function stopSpawnTyping(threadId: number): void {
  const h = spawnTypingLoops.get(threadId)
  if (h) { clearInterval(h); spawnTypingLoops.delete(threadId) }
}

function startSpawnTimeout(threadId: number, chatId: number): void {
  setTimeout(() => {
    if (!spawningThreads.has(threadId)) return
    spawningThreads.delete(threadId)
    pendingInboundQueue.delete(threadId)
    stopSpawnTyping(threadId)
    bot.api.sendMessage(chatId, '⚠ Не удалось запустить Claude (таймаут). Тапни кнопку чтобы попробовать ещё раз.', {
      message_thread_id: threadId || undefined, reply_markup: sessionMenu(),
    }).catch(() => {})
  }, SPAWN_TIMEOUT_MS)
}

function notifySessionEnded(rec: SessionRecord): void {
  bot.api.sendMessage(rec.chatId, 'Claude остановился. Что сделать?', {
    message_thread_id: rec.threadId || undefined,
    reply_markup: sessionMenu(),
  }).catch(() => {})
}

// ── Menus ─────────────────────────────────────────────────────────────────
function sessionMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🚀 Запустить', 'launch')
    .text('↻ Продолжить', 'continue')
}

// ── Commands ──────────────────────────────────────────────────────────────
bot.command('start', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `This bot bridges Telegram to a Claude Code session.\n\n` +
    `To pair:\n` +
    `1. DM me anything — you'll get a 6-char code\n` +
    `2. In Claude Code: /telegram:access pair <code>\n\n` +
    `After that, DMs here reach that session.`,
  )
})

bot.command('help', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `Messages you send here route to a paired Claude Code session.\n\n` +
    `/start — pairing instructions\n` +
    `/status — pairing state\n` +
    `/effort, /model, /mode, /clear, /interrupt, /resume — drive the session`,
  )
})

bot.command('status', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const { access, senderId } = gated
  if (access.allowFrom.includes(senderId)) {
    const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
    await ctx.reply(`Paired as ${name}.`)
    return
  }
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(`Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
      return
    }
  }
  await ctx.reply('Not paired. Send me a message to get a pairing code.')
})

// ── TUI commands: route to the session in this thread ─────────────────────
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

async function requireSession(ctx: Context): Promise<SessionRecord | null> {
  const gated = dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return null
  const rec = getSession(ctx)
  if (!rec || !rec.socket) {
    await ctx.reply('Claude not running in this thread. Send a message to launch.')
    return null
  }
  return rec
}

bot.command('effort', async ctx => {
  if (!await requireSession(ctx)) return
  // Effort menu — current value: best-effort read from settings.json.
  let current: string | null = null
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    current = typeof s.effortLevel === 'string' ? s.effortLevel : null
  } catch {}
  const kbd = new InlineKeyboard()
  for (const level of EFFORT_LEVELS) {
    kbd.text(level === current ? `• ${level}` : level, `tui:effort:${level}`)
  }
  await ctx.reply(current ? `Effort (now: ${current}):` : 'Effort:', {
    reply_markup: kbd,
    message_thread_id: contextThreadId(ctx) || undefined,
  })
})

bot.command('mode', async ctx => {
  const rec = await requireSession(ctx)
  if (!rec) return
  ipcSend(rec.threadId, { type: 'tui_send', mode: 'keys', payload: ['BTab'] })
  ipcSend(rec.threadId, { type: 'watch_dialog' })
  await ctx.reply('Cycled permission mode (shift+tab).', {
    message_thread_id: contextThreadId(ctx) || undefined,
  })
})

bot.command('clear', async ctx => {
  const rec = await requireSession(ctx)
  if (!rec) return
  ipcSend(rec.threadId, { type: 'tui_send', mode: 'slash', payload: '/clear' })
  ipcSend(rec.threadId, { type: 'watch_dialog' })
  await ctx.reply('Sent /clear.', { message_thread_id: contextThreadId(ctx) || undefined })
})

bot.command('interrupt', async ctx => {
  const rec = await requireSession(ctx)
  if (!rec) return
  ipcSend(rec.threadId, { type: 'tui_send', mode: 'keys', payload: ['Escape'] })
  await ctx.reply('Sent Esc.', { message_thread_id: contextThreadId(ctx) || undefined })
})

bot.command('model', async ctx => {
  const rec = await requireSession(ctx)
  if (!rec) return
  ipcSend(rec.threadId, { type: 'tui_send', mode: 'slash', payload: '/model' })
  ipcSend(rec.threadId, { type: 'watch_dialog' })
  await ctx.reply('Sent /model.', { message_thread_id: contextThreadId(ctx) || undefined })
})

bot.command('resume', async ctx => {
  const rec = await requireSession(ctx)
  if (!rec) return
  ipcSend(rec.threadId, { type: 'tui_send', mode: 'slash', payload: '/resume' })
  ipcSend(rec.threadId, { type: 'watch_dialog' })
  await ctx.reply('Sent /resume.', { message_thread_id: contextThreadId(ctx) || undefined })
})

// ── Callback queries — dispatch by prefix ─────────────────────────────────
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  const access = loadAccess()
  const senderId = String(ctx.from.id)
  const threadId = contextThreadId(ctx)
  const chatId = ctx.chat?.id

  // Launch/continue session menu.
  if (data === 'launch' || data === 'continue') {
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not allowed', show_alert: true })
      return
    }
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' })
      return
    }
    if (registry.get(threadId)?.socket) {
      await ctx.answerCallbackQuery({ text: 'Already running' })
      return
    }
    await ctx.answerCallbackQuery()
    const label = data === 'launch' ? 'Запускаю claude…' : 'Продолжаю последнюю сессию…'
    const ackLabel = data === 'launch' ? 'Claude запущен ✓' : 'Claude продолжен ✓'
    let msgId: number | undefined
    try {
      const edited = await ctx.editMessageText(label)
      if (edited && typeof edited === 'object' && 'message_id' in edited) {
        msgId = (edited as any).message_id
      } else if (ctx.callbackQuery.message) {
        msgId = ctx.callbackQuery.message.message_id
      }
    } catch {}
    if (msgId != null) {
      pendingAcks.set(threadId, { chatId, messageId: msgId, label: ackLabel })
    }
    spawnSession({ chatId, threadId, action: data })
    return
  }

  // TUI effort sub-menu: tui:effort:<level>
  const tuiEffort = /^tui:effort:(low|medium|high|xhigh|max)$/.exec(data)
  if (tuiEffort) {
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized' })
      return
    }
    const level = tuiEffort[1]
    await ctx.answerCallbackQuery({ text: `effort: ${level}` })
    const ok = ipcSend(threadId, { type: 'tui_send', mode: 'slash', payload: `/effort ${level}` })
    ipcSend(threadId, { type: 'watch_dialog' })
    await ctx.editMessageText(ok ? `→ /effort ${level}` : 'Failed: no MCP for this thread').catch(() => {})
    return
  }

  // TUI dialog selection: tuidlg:<idx>
  const tuiDlg = /^tuidlg:(\d+)$/.exec(data)
  if (tuiDlg) {
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized' })
      return
    }
    const idx = tuiDlg[1]
    await ctx.answerCallbackQuery({ text: `→ ${idx}` })
    ipcSend(threadId, { type: 'tui_send', mode: 'keys', payload: [idx, 'Enter'] })
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && typeof msg.text === 'string') {
      await ctx.editMessageText(`${msg.text}\n\n→ ${idx}`).catch(() => {})
    } else {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    }
    return
  }

  // ask_user / confirm / confirm_plan answer: q:<prompt_id>:<idx>
  const qm = /^q:([a-km-z]{5}):(\d+)$/.exec(data)
  if (qm) {
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized' })
      return
    }
    const [, prompt_id, idxStr] = qm
    const idx = Number(idxStr)
    await ctx.answerCallbackQuery({ text: `→ ${idx}` })
    ipcSend(threadId, {
      type: 'inbound',
      method: 'notifications/claude/channel/prompt_answer',
      params: { prompt_id, idx },
    })
    // We don't know the label here; the MCP will edit the message.
    return
  }

  // Permission button: perm:<allow|deny|more>:<request_id>
  const pm = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
  if (pm) {
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized' })
      return
    }
    const [, behavior, request_id] = pm
    await ctx.answerCallbackQuery({ text: behavior === 'more' ? '…' : behavior === 'allow' ? '✅' : '❌' })
    ipcSend(threadId, {
      type: 'inbound',
      method: behavior === 'more'
        ? 'notifications/claude/channel/permission_more'
        : 'notifications/claude/channel/permission_choice',
      params: { request_id, behavior },
    })
    if (behavior !== 'more') {
      const msg = ctx.callbackQuery.message
      const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
      if (msg && 'text' in msg && typeof msg.text === 'string') {
        await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
      }
    }
    return
  }

  await ctx.answerCallbackQuery().catch(() => {})
})

// ── Inbound message routing ───────────────────────────────────────────────
type AttachmentMeta = { kind: string; file_id: string; size?: number; mime?: string; name?: string }
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const result = gate(ctx)
  if (result.action === 'drop') return
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }
  const access = result.access
  const from = ctx.from!
  const chatId = ctx.chat!.id
  const chat_id = String(chatId)
  const msgId = ctx.message?.message_id
  const threadId = ctx.message?.message_thread_id ?? 0

  // Permission text-reply intercept (legacy: typed "yes <code>" instead of buttons).
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    const rec = registry.get(threadId)
    if (rec) {
      ipcSend(threadId, {
        type: 'inbound',
        method: 'notifications/claude/channel/permission_choice',
        params: {
          request_id: permMatch[2]!.toLowerCase(),
          behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      })
      if (msgId != null) {
        const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
        void bot.api.setMessageReaction(chat_id, msgId, [
          { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
        ]).catch(() => {})
      }
    }
    return
  }

  // Ack reaction (configurable).
  if (access.ackReaction && msgId != null) {
    void bot.api.setMessageReaction(chat_id, msgId, [
      { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
    ]).catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  // Build the channel notification payload. Same shape as the old in-process
  // MCP used — Claude's view unchanged.
  const inboundParams = {
    content: text,
    meta: {
      chat_id,
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachment ? {
        attachment_kind: attachment.kind,
        attachment_file_id: attachment.file_id,
        ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
        ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
        ...(attachment.name ? { attachment_name: attachment.name } : {}),
      } : {}),
    },
  }
  const inboundMsg = { method: 'notifications/claude/channel', params: inboundParams }

  const rec = registry.get(threadId)
  if (rec?.socket) {
    ipcSend(threadId, { type: 'inbound', ...inboundMsg })
    return
  }

  // No live session in this thread → auto-launch and queue this message so
  // it's the first thing Claude sees on startup. Subsequent messages within
  // the spawn window queue behind it; we drain on MCP register.
  // Attach the rename-topic task as a content prefix on the very first
  // queued message — claude consistently forgets the hint that's only in
  // the MCP system prompt, but treats inline task markers as load-bearing.
  // The prefix is in the channel content only; the user's Telegram chat
  // still shows just their own message.
  const isFirstQueued = !pendingInboundQueue.has(threadId)
  const taggedParams = isFirstQueued ? {
    ...inboundParams,
    content:
      '[TASK: rename_topic({name: "<2-5 word title summarizing this request, in user\'s language>"}) BEFORE any reply. Then handle the message below.]\n\n' +
      inboundParams.content,
  } : inboundParams
  const taggedMsg = { method: 'notifications/claude/channel', params: taggedParams }

  queueInbound(threadId, taggedMsg)
  if (!spawningThreads.has(threadId)) {
    spawningThreads.add(threadId)
    process.stderr.write(`telegram-dispatcher: auto-launching session for thread ${threadId}\n`)
    spawnSession({ chatId, threadId, action: 'launch' })
    startSpawnTimeout(threadId, chatId)
    // Continuous "печатает…" indicator from now until MCP registers and
    // drains the queue. Without this the user sees no feedback during the
    // ~5s spawn window and assumes the bot is dead.
    startSpawnTyping(threadId, chatId)
    // Name the new topic after the first message immediately — gives a
    // recognizable title before Claude has a chance to do its own smarter
    // rename via the rename_topic tool.
    void renameTopic(chatId, threadId, topicNameFromText(text))
  } else {
    // Already spawning; just keep typing alive (in case the user sends
    // more messages, we still want indicator visible).
    startSpawnTyping(threadId, chatId)
  }
}

// ── message:* wiring ──────────────────────────────────────────────────────
const INBOX_DIR = join(STATE_DIR, 'inbox')

bot.on('message:text', async ctx => {
  if (ctx.message.text?.startsWith('/')) return // commands handled separately
  await handleInbound(ctx, ctx.message.text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      process.stderr.write(`telegram-dispatcher: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined, {
    kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
  })
})

bot.on('message:voice', async ctx => {
  const v = ctx.message.voice
  await handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, {
    kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const a = ctx.message.audio
  const name = safeName(a.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(audio: ${safeName(a.title) ?? name ?? 'audio'})`, undefined, {
    kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name,
  })
})

bot.on('message:video', async ctx => {
  const v = ctx.message.video
  await handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, {
    kind: 'video', file_id: v.file_id, size: v.file_size, mime: v.mime_type, name: safeName(v.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, {
    kind: 'video_note', file_id: vn.file_id, size: vn.file_size,
  })
})

bot.on('message:sticker', async ctx => {
  const s = ctx.message.sticker
  const emoji = s.emoji ? ` ${s.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker', file_id: s.file_id, size: s.file_size,
  })
})

// ── Forum topic lifecycle ─────────────────────────────────────────────────
bot.on(':forum_topic_closed', async ctx => {
  const threadId = ctx.message?.message_thread_id
  if (threadId == null) return
  killSession(threadId)
})

bot.on(':forum_topic_reopened', async ctx => {
  const threadId = ctx.message?.message_thread_id
  if (threadId == null) return
  const chatId = ctx.chat?.id
  if (chatId == null) return
  await bot.api.sendMessage(chatId, 'Топик переоткрыт. Что сделать?', {
    message_thread_id: threadId, reply_markup: sessionMenu(),
  }).catch(() => {})
})

// ── Shutdown handling ─────────────────────────────────────────────────────
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try { await bot.stop() } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })

bot.catch(err => {
  process.stderr.write(`telegram-dispatcher: handler error: ${err.error}\n`)
})

// ── bot.start retry loop ──────────────────────────────────────────────────
void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-dispatcher: polling as @${info.username}\n`)
          void bot.api.setMyCommands([
            { command: 'start', description: 'Welcome and setup guide' },
            { command: 'help', description: 'What this bot can do' },
            { command: 'status', description: 'Check your pairing state' },
            { command: 'effort', description: 'Set thinking effort' },
            { command: 'model', description: 'Pick model' },
            { command: 'mode', description: 'Cycle permission mode' },
            { command: 'clear', description: 'Clear context' },
            { command: 'resume', description: 'Resume conversation' },
            { command: 'interrupt', description: 'Interrupt (Esc)' },
          ], { scope: { type: 'all_private_chats' } }).catch(() => {})
        },
      })
      return
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      const delay = Math.min(1000 * attempt, 15000)
      process.stderr.write(
        `telegram-dispatcher: ${is409 ? '409 Conflict' : 'polling error'}: ${err}, retrying in ${delay / 1000}s\n`,
      )
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()
