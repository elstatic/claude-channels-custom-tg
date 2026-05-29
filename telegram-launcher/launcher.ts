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
import { JobStore, nextFireFrom, type ScheduledJob } from './jobs'
import { TopicDb, defaultDbFile } from './db'

// ── State dir / files ─────────────────────────────────────────────────────
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const PID_FILE = join(STATE_DIR, 'bot.pid')
const SESSIONS_FILE = defaultSessionsFile(STATE_DIR)
const JOBS_FILE = join(STATE_DIR, 'jobs.json')
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

// ── Observability ─────────────────────────────────────────────────────────
// The operator is on a phone and will never read journald. Track liveness and
// DM the owner when something goes wrong, plus a /health command on demand.
const BOOT_AT = Date.now()
let lastUpdateAt = 0
bot.use(async (_ctx, next) => { lastUpdateAt = Date.now(); await next() })

function fmtAgo(ms: number): string {
  if (!ms) return 'never'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// DM the first allowlisted user. Fire-and-forget; never throws.
function notifyOwner(text: string): void {
  try {
    const owner = loadAccess().allowFrom[0]
    if (owner) void bot.api.sendMessage(owner, text).catch(() => {})
  } catch {}
}

// Best-effort token usage for a topic, summed from its newest CC transcript
// (~/.claude/projects/<encoded-cwd>/<session>.jsonl). No dollar figure — token
// pricing varies by model; we report raw token totals which are unambiguous.
function readSessionUsage(threadId: number): { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number } | null {
  try {
    const projRoot = join(homedir(), '.claude', 'projects')
    const dirs = readdirSync(projRoot).filter(d => d.endsWith(`-topic-${threadId}`))
    let best: { path: string; mtime: number } | null = null
    for (const d of dirs) {
      try {
        for (const f of readdirSync(join(projRoot, d))) {
          if (!f.endsWith('.jsonl')) continue
          const p = join(projRoot, d, f)
          const st = statSync(p)
          if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs }
        }
      } catch {}
    }
    if (!best) return null
    const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }
    for (const ln of readFileSync(best.path, 'utf8').split('\n')) {
      if (!ln.trim()) continue
      let o: any
      try { o = JSON.parse(ln) } catch { continue }
      const us = o?.message?.usage
      if (o?.type === 'assistant' && us) {
        u.input += us.input_tokens || 0
        u.output += us.output_tokens || 0
        u.cacheRead += us.cache_read_input_tokens || 0
        u.cacheWrite += us.cache_creation_input_tokens || 0
        u.turns++
      }
    }
    return u
  } catch { return null }
}

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

const db = new TopicDb(defaultDbFile(STATE_DIR))

const jobs = new JobStore(JOBS_FILE)
jobs.load()

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

// Threads we've intentionally stopped — the upcoming socket-disconnect
// shouldn't trigger a "Claude остановился" surprise notification (we
// already showed the user a confirmation).
const expectedDisconnects = new Set<number>()

// MCP socket sometimes briefly drops during claude operations like `/model`
// picker (claude reinitializes MCP connections when the model changes). The
// process is still alive; reconnection happens within 1-3 seconds. We delay
// the "Claude остановился" notification by GRACE_MS so transient drops don't
// surface as scary deaths. If the MCP doesn't reconnect within the grace
// window, the timer fires and the real notification goes out.
const SESSION_DEATH_GRACE_MS = 5000
const pendingDeathNotifications = new Map<number, NodeJS.Timeout>()

function readPpid(pid: number): number | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // pid (comm) state ppid ... — comm can contain spaces+parens, so split
    // from the LAST ')'.
    const tail = s.slice(s.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(tail[1])
    return ppid > 0 ? ppid : null
  } catch {
    return null
  }
}

function killSession(threadId: number, opts?: { silent?: boolean }): void {
  const rec = registry.get(threadId)
  if (!rec) return
  if (opts?.silent) expectedDisconnects.add(threadId)
  try {
    spawnSync('tmux', ['kill-session', '-t', rec.tmuxSession], { stdio: 'ignore' })
  } catch {}
  // Belt-and-braces: if the tmux server itself is dead the kill-session above
  // is a no-op, leaving claude + its MCP child running with their pty orphaned.
  // Walk up the process tree from the recorded MCP pid (MCP → bun wrapper →
  // claude) and SIGTERM claude directly so the whole subtree winds down.
  // If tmux was alive, claude has already exited by the time this fires and
  // every process.kill below no-ops.
  if (rec.pid) {
    const mcpPid = rec.pid
    setTimeout(() => {
      try { process.kill(mcpPid, 0) } catch { return } // already gone — good
      const wrapperPid = readPpid(mcpPid)
      const claudePid = wrapperPid ? readPpid(wrapperPid) : null
      const target = claudePid && claudePid > 1 ? claudePid : mcpPid
      try { process.kill(target, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(target, 'SIGKILL') } catch {} }, 3000)
    }, 1000)
  }
  registry.remove(threadId)
  stopStatusMessage(threadId)
  cleanupCoordFiles(threadId)
}

// ── Topic-existence probe ─────────────────────────────────────────────────
// There is no silent way to probe a DM-with-topics thread for liveness via
// Bot API. Everything we tried either side-effects the chat or doesn't
// actually validate the thread:
//   1. sendMessage + deleteMessage      — Desktop bumps unread badge
//   2. sendChatAction('typing', thread) — typing indicator in PARENT chat
//                                         AND returns ok:true for non-existent
//                                         threads (doesn't validate at all)
//   3. editForumTopic(chat, thread, {}) — no-op accepted, returns ok:true
//                                         even on deleted threads
//   4. unpinAllForumTopicMessages       — same: ok:true regardless
// Bot API only validates message_thread_id when an actual change is requested
// (editForumTopic with a real `name` returns TOPIC_ID_INVALID on dead, but
// renames + emits a service message on live — not acceptable).
// So: no periodic sweep. Cleanup is REACTIVE only — server.ts catches
// "message thread not found" on outbound and signals topic_deleted via IPC,
// triggering killSession (see McpToDispatcher handler below).

async function probeTopicAlive(chatId: number, threadId: number): Promise<boolean> {
  if (!threadId) return true
  // Real probes have side effects; we only call this from fireJob where the
  // cron is about to fire something visible anyway, so reuse the lighter
  // sendChatAction path (false positives are harmless there — the subsequent
  // sendMessage will surface the actual error).
  try {
    await bot.api.sendChatAction(chatId, 'typing', { message_thread_id: threadId } as any)
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
  // /tmp/claude-spawn-t*.log and the status/trace coordination files (cleaned
  // on session death too, but this is the backstop for orphans / crashes).
  try {
    const entries = readdirSync('/tmp')
    for (const name of entries) {
      if (!/^claude-spawn(-t\d+)?\.log$/.test(name) &&
          !/^claude-tg-(status|trace)-\d+\.(json|txt)$/.test(name)) continue
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

// Per-topic existence-probing has no silent path on Bot API — see
// probeTopicAlive. Instead of polling, sweep by IDLE TIME: sessions with no
// inbound activity for N hours get killed. User can resume any session by
// sending a new message into that topic (auto-launch flow handles the rest).
// N defaults to 3 hours, override via CLAUDE_TG_IDLE_HOURS env.
const IDLE_TIMEOUT_MS = (parseFloat(process.env.CLAUDE_TG_IDLE_HOURS ?? '3') || 3) * 3600_000
const IDLE_SWEEP_INTERVAL_MS = 30 * 60 * 1000  // check every 30 min

function sweepIdleSessions(): void {
  const now = Date.now()
  for (const rec of registry.all()) {
    if (!rec.threadId) continue  // never auto-kill the root chat session
    const since = rec.lastActivityAt ?? rec.startedAt
    if (now - since > IDLE_TIMEOUT_MS) {
      const hours = ((now - since) / 3600_000).toFixed(1)
      process.stderr.write(`telegram-dispatcher: thread ${rec.threadId} idle for ${hours}h, killing session\n`)
      killSession(rec.threadId, { silent: true })
    }
  }
}

setTimeout(sweepIdleSessions, 60_000)
setInterval(sweepIdleSessions, IDLE_SWEEP_INTERVAL_MS).unref()
void sweepDeletedTopics  // keep symbol — fireJob still uses probeTopicAlive

// ── Cron scheduler ───────────────────────────────────────────────────────
// Periodically (every 60s) walks `jobs` and fires any whose nextFireAt has
// passed. A "fire" = inject a synthetic channel notification into the
// session for that thread (auto-spawning a session if there isn't one,
// auto-recreating the topic via createForumTopic if the original was
// deleted). After fire we recompute nextFireAt with croner and persist.
async function fireJob(job: ScheduledJob): Promise<void> {
  let { chatId, threadId, topicName, prompt } = job
  // Recreate the topic if it was deleted between fires.
  if (threadId) {
    const alive = await probeTopicAlive(chatId, threadId)
    if (!alive) {
      try {
        const created = await bot.api.createForumTopic(chatId, topicName)
        threadId = created.message_thread_id
        process.stderr.write(`telegram-dispatcher: recreated topic for job ${job.id}: ${job.threadId} → ${threadId}\n`)
        jobs.update(job.id, { threadId })
        await bot.api.sendMessage(chatId, '↻ Топик пересоздан — продолжаю расписание.', {
          message_thread_id: threadId,
        }).catch(() => {})
      } catch (err) {
        process.stderr.write(`telegram-dispatcher: createForumTopic failed for job ${job.id}: ${err}\n`)
        return // try again next tick
      }
    }
  }
  // Build the synthetic inbound — meta.user="cron" so Claude can distinguish.
  const inboundMsg = {
    type: 'inbound' as const,
    method: 'notifications/claude/channel',
    params: {
      content: `[scheduled job ${job.id}] ${prompt}`,
      meta: {
        chat_id: String(chatId),
        user: 'cron',
        user_id: 'cron',
        ts: new Date().toISOString(),
      },
    },
  }
  const rec = registry.get(threadId)
  if (rec?.socket) {
    ipcSend(threadId, inboundMsg)
  } else {
    // No live session — queue and auto-launch (same as user-initiated
    // auto-launch path in handleInbound).
    queueInbound(threadId, { method: inboundMsg.method, params: inboundMsg.params })
    if (!spawningThreads.has(threadId)) {
      spawningThreads.add(threadId)
      process.stderr.write(`telegram-dispatcher: auto-launching session for scheduled job ${job.id} (thread ${threadId})\n`)
      spawnSession({ chatId, threadId, action: 'launch' })
      startSpawnTimeout(threadId, chatId)
    }
  }
}

async function tickScheduler(): Promise<void> {
  // Reload from disk so MCP-side mutations (schedule_job/cancel_job tool
  // calls writing jobs.json) are picked up.
  jobs.load()
  const now = Date.now()
  for (const job of jobs.all()) {
    if (job.nextFireAt > now) continue
    try {
      await fireJob(job)
      if (job.oneShot) {
        jobs.remove(job.id)
        process.stderr.write(`telegram-dispatcher: one-shot job ${job.id} fired and removed\n`)
      } else {
        // Recompute next run anchored on now (skip missed catch-ups).
        const next = nextFireFrom(job.cron, new Date(now))
        jobs.update(job.id, { lastFireAt: now, nextFireAt: next })
      }
    } catch (err) {
      process.stderr.write(`telegram-dispatcher: job ${job.id} fire failed: ${err}\n`)
      // Postpone by one tick so we don't spin on a broken job.
      jobs.update(job.id, { nextFireAt: now + 60_000 })
    }
  }
}

// On startup: any job whose stored nextFireAt is in the past (dispatcher
// was down) gets bumped forward — standard cron behavior, no catch-up
// thundering herd.
;(() => {
  const now = Date.now()
  for (const job of jobs.all()) {
    if (job.nextFireAt <= now) {
      try { jobs.update(job.id, { nextFireAt: nextFireFrom(job.cron, new Date(now)) }) }
      catch (err) { process.stderr.write(`telegram-dispatcher: failed to reset nextFireAt for ${job.id}: ${err}\n`) }
    }
  }
})()

const SCHEDULER_INTERVAL_MS = 60 * 1000
setTimeout(() => { void tickScheduler() }, 10_000)
setInterval(() => { void tickScheduler() }, SCHEDULER_INTERVAL_MS).unref()

// ── IPC server: route inbound to MCP, handle MCP→dispatcher messages ──────
// Outbound RPC messages we couldn't deliver because the MCP socket was
// momentarily down (e.g. claude /model picker triggers a short reconnect
// cycle). Flushed on register. Per-thread queue, capped to avoid runaway.
const pendingOutbound = new Map<number, object[]>()
const MAX_PENDING_OUTBOUND = 32

function ipcSend(threadId: number, msg: object): boolean {
  // Treat anything we send to the MCP as activity — covers user messages,
  // cron fires, slash commands, prompt answers. The idle sweep uses this.
  if ((msg as { type?: string }).type === 'inbound') registry.touch(threadId)
  const sock = registry.socketOf(threadId)
  if (sock && !sock.destroyed) {
    sendJson(sock, msg)
    return true
  }
  // Buffer for the upcoming reconnect — only useful for short drops.
  let q = pendingOutbound.get(threadId)
  if (!q) { q = []; pendingOutbound.set(threadId, q) }
  if (q.length < MAX_PENDING_OUTBOUND) q.push(msg)
  return false
}

function flushPendingOutbound(threadId: number): void {
  const q = pendingOutbound.get(threadId)
  if (!q || q.length === 0) return
  pendingOutbound.delete(threadId)
  const sock = registry.socketOf(threadId)
  if (!sock || sock.destroyed) return
  for (const msg of q) sendJson(sock, msg)
  process.stderr.write(`telegram-dispatcher: flushed ${q.length} buffered outbound for thread=${threadId}\n`)
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
      // Reconnect within the grace window — cancel the pending death notif.
      const pendingDeath = pendingDeathNotifications.get(thread_id)
      if (pendingDeath) {
        clearTimeout(pendingDeath)
        pendingDeathNotifications.delete(thread_id)
        process.stderr.write(`telegram-dispatcher: thread=${thread_id} reconnected in grace window, suppressing death notif\n`)
      }
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
      // Flush any tui_send/watch_dialog that arrived while the socket was
      // down (e.g. between a /model-triggered drop and reconnect).
      flushPendingOutbound(thread_id)
      return
    }
    if (msg.type === 'permission_reply' || msg.type === 'outbound_dialog') {
      // Server.ts side decided to surface a dialog or to relay a permission.
      // These currently aren't initiated dispatcher-side so we don't need to
      // handle them here — kept for protocol completeness.
      return
    }
    if (msg.type === 'topic_deleted') {
      // MCP hit "Bad Request: message thread not found" on outbound — the
      // user deleted the topic and Telegram never emitted an event we could
      // hear. Reverse-lookup which thread this socket belongs to and kill.
      const threadId = registry.threadOf(sock)
      if (threadId != null) {
        process.stderr.write(`telegram-dispatcher: thread ${threadId} reports topic deleted, killing session\n`)
        killSession(threadId, { silent: true })
      }
      return
    }
    if (msg.type === 'history_log') {
      const threadId = registry.threadOf(sock)
      if (threadId != null) {
        db.append({
          thread_id: threadId,
          role: 'assistant',
          text: msg.text,
          ts: Date.now(),
          message_id: msg.message_id ?? null,
        })
      }
      return
    }
    if (msg.type === 'status_consume') {
      // reply() claimed the status bubble — stop the animator synchronously
      // (same process, no race) so it can't overwrite the final answer.
      stopStatusMessage(msg.thread_id)
      return
    }
  },
  onDisconnect(sock) {
    const threadId = registry.detachSocket(sock)
    if (threadId == null) return
    process.stderr.write(`telegram-dispatcher: MCP for thread=${threadId} disconnected\n`)
    if (expectedDisconnects.has(threadId)) {
      // We initiated this (via /stop or similar) — user has already been
      // told what's happening.
      expectedDisconnects.delete(threadId)
      registry.remove(threadId)
      return
    }
    // Grace period: claude operations like /model picker can briefly drop
    // the MCP socket and reconnect ~1-3s later. Schedule the death notif
    // but cancel it if the MCP reconnects in time.
    const existing = pendingDeathNotifications.get(threadId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      pendingDeathNotifications.delete(threadId)
      const cur = registry.get(threadId)
      if (cur && !cur.socket) {
        notifySessionEnded(cur)
        registry.remove(threadId)
      }
    }, SESSION_DEATH_GRACE_MS)
    pendingDeathNotifications.set(threadId, timer)
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

// Threads where we've shown the "restore context?" prompt and are waiting for
// the user to pick (or for the 60s fallback to fire a clean launch).
const awaitingContextChoice = new Map<number, {
  chatId: number
  promptMessageId?: number
  timeout: NodeJS.Timeout
}>()
const CONTEXT_CHOICE_TIMEOUT_MS = 60_000

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

// ── In-topic status message ───────────────────────────────────────────────
// The native "печатает…" chat action shows at the whole-forum level, so the
// user can't tell WHICH topic is busy. Instead we post a real message INTO the
// topic ("💬 работаю…") and animate the dots. When the agent replies, server.ts
// edits this same message into the final answer (in place); the Stop hook does
// the same as a safety net if no reply ever lands. Coordination is via a tiny
// per-thread file /tmp/claude-tg-status-<thread>.json with a `consumed` flag —
// once consumed, the animator below self-stops so it never clobbers the answer.
const STATUS_DOTS = ['.', '..', '...', '....', '.....']
const STATUS_MAX_MS = 10 * 60_000
type StatusEntry = { messageId: number; chatId: number; timer: ReturnType<typeof setInterval>; dot: number; startedAt: number }
const statusMessages = new Map<number, StatusEntry>()

function statusFile(threadId: number): string {
  return `/tmp/claude-tg-status-${threadId}.json`
}

// Live tool-call trace, written by the PostToolUse hook (trace-tool.py). We
// render it as an expandable blockquote under the "работаю" line.
function traceFile(threadId: number): string {
  return `/tmp/claude-tg-trace-${threadId}.txt`
}

// Atomic write so the launcher / server.ts / hooks never read a torn file.
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  } catch {
    try { rmSync(tmp, { force: true }) } catch {}
  }
}

// Remove a topic's coordination files (status + trace) on session death so
// /tmp doesn't accumulate one pair per thread forever.
function cleanupCoordFiles(threadId: number): void {
  try { rmSync(statusFile(threadId), { force: true }) } catch {}
  try { rmSync(traceFile(threadId), { force: true }) } catch {}
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Build the status message body: "💬 работаю" + animated dots, plus — if the
// hook has recorded any tool calls this turn — an expandable grey blockquote
// of the last few. Returned as HTML (caller sends parse_mode: 'HTML').
// One-tap ⏹ on the working bubble — interrupts the current turn from the phone.
function statusKeyboard(threadId: number): InlineKeyboard {
  return new InlineKeyboard().text('⏹ Стоп', `stopturn:${threadId}`)
}

function renderStatus(threadId: number, dots: string): string {
  const head = '💬 ' + dots
  let trace = ''
  try { trace = readFileSync(traceFile(threadId), 'utf8').trim() } catch {}
  if (!trace) return head
  const lines = trace.split('\n').filter(Boolean).slice(-10).map(htmlEscape).join('\n')
  return head + '\n<blockquote expandable>' + lines + '</blockquote>'
}

// null = no file; true/false = consumed flag.
function statusConsumed(threadId: number): boolean | null {
  try {
    const o = JSON.parse(readFileSync(statusFile(threadId), 'utf8'))
    return !!o.consumed
  } catch { return null }
}

async function startStatusMessage(threadId: number, chatId: number): Promise<void> {
  if (!threadId) return
  // Reuse an existing, still-active status message (rapid-fire inbound) instead
  // of stacking a second "работаю…" bubble in the topic.
  if (statusMessages.has(threadId) && statusConsumed(threadId) === false) return
  stopStatusMessage(threadId)
  // Fresh working bubble → fresh trace (don't carry over the previous turn's).
  atomicWrite(traceFile(threadId), '')
  let messageId: number
  try {
    // Always ship at least one dot — a lone 💬 is a single-emoji message, which
    // Telegram renders as a jumbo emoji (looks broken). The animator takes over
    // ~3.5s later; until then this is what the user sees.
    const sent = await bot.api.sendMessage(chatId, '💬 .', {
      message_thread_id: threadId || undefined,
      reply_markup: statusKeyboard(threadId),
    } as any)
    messageId = sent.message_id
  } catch { return }
  atomicWrite(statusFile(threadId), JSON.stringify({
    chat_id: chatId, thread_id: threadId, message_id: messageId, consumed: false,
  }))
  const entry: StatusEntry = { messageId, chatId, dot: 0, startedAt: Date.now(), timer: undefined as any }
  entry.timer = setInterval(() => {
    // Self-stop once server.ts/the hook took over (consumed) or after the cap.
    if (statusConsumed(threadId) !== false || Date.now() - entry.startedAt > STATUS_MAX_MS) {
      const capped = Date.now() - entry.startedAt > STATUS_MAX_MS
      stopStatusMessage(threadId)
      // On the time cap, mark consumed so a late reply doesn't edit a dead bubble.
      if (capped) { try { atomicWrite(statusFile(threadId), JSON.stringify({ chat_id: chatId, thread_id: threadId, message_id: messageId, consumed: true })) } catch {} }
      return
    }
    entry.dot = (entry.dot + 1) % STATUS_DOTS.length
    void bot.api.editMessageText(chatId, messageId, renderStatus(threadId, STATUS_DOTS[entry.dot]), {
      parse_mode: 'HTML',
      reply_markup: statusKeyboard(threadId),
    } as any).catch(() => {})
  }, 3500)
  statusMessages.set(threadId, entry)
}

function stopStatusMessage(threadId: number): void {
  const e = statusMessages.get(threadId)
  if (e) { clearInterval(e.timer); statusMessages.delete(threadId) }
}

function startSpawnTimeout(threadId: number, chatId: number): void {
  setTimeout(() => {
    if (!spawningThreads.has(threadId)) return
    spawningThreads.delete(threadId)
    pendingInboundQueue.delete(threadId)
    stopSpawnTyping(threadId)
    stopStatusMessage(threadId)
    bot.api.sendMessage(chatId, '⚠ Не удалось запустить Claude (таймаут). Тапни кнопку чтобы попробовать ещё раз.', {
      message_thread_id: threadId || undefined, reply_markup: sessionMenu(),
    }).catch(() => {})
  }, SPAWN_TIMEOUT_MS)
}

function notifySessionEnded(rec: SessionRecord): void {
  stopStatusMessage(rec.threadId)
  bot.api.sendMessage(rec.chatId, 'Claude остановился. Что сделать?', {
    message_thread_id: rec.threadId || undefined,
    reply_markup: sessionMenu(),
  }).catch(() => {})
}

// ── Restart context-restore choice ────────────────────────────────────────
// When a topic with stored history gets a message but has no live session,
// offer the user the choice to restore prior context or start clean.
async function offerContextChoice(chatId: number, threadId: number, n: number) {
  const kbd = new InlineKeyboard()
    .text(`📋 Продолжить с контекстом (${n})`, 'ctxlaunch')
    .text('🆕 Новая сессия', 'freshlaunch')
  let promptMessageId: number | undefined
  try {
    const sent = await bot.api.sendMessage(
      chatId,
      'Сессия в этом топике была остановлена. Восстановить контекст прошлой переписки?',
      { message_thread_id: threadId || undefined, reply_markup: kbd },
    )
    promptMessageId = sent.message_id
  } catch {}
  const timeout = setTimeout(() => {
    // fallback: пользователь не выбрал → запускаем чистую сессию
    awaitingContextChoice.delete(threadId)
    startContextLaunch(chatId, threadId, false, promptMessageId)
  }, CONTEXT_CHOICE_TIMEOUT_MS)
  awaitingContextChoice.set(threadId, { chatId, promptMessageId, timeout })
}

function startContextLaunch(
  chatId: number, threadId: number, withContext: boolean, promptMessageId?: number,
) {
  if (withContext) prependContextToQueue(threadId)
  if (promptMessageId != null) {
    bot.api.editMessageText(
      chatId, promptMessageId,
      withContext ? '📋 Продолжаю с контекстом…' : '🆕 Новая сессия…',
    ).catch(() => {})
  }
  spawningThreads.add(threadId)
  spawnSession({ chatId, threadId, action: 'launch' })
  startSpawnTimeout(threadId, chatId)
  startSpawnTyping(threadId, chatId)
}

function prependContextToQueue(threadId: number) {
  const q = pendingInboundQueue.get(threadId)
  if (!q || q.length === 0) return
  const ctx = db.formatContext(threadId)
  if (!ctx) return
  const first = q[0]
  first.params = {
    ...first.params,
    content:
      '[Previous conversation in this topic:\n' + ctx +
      '\n---\nNew message:]\n\n' + (first.params as any).content,
  }
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

bot.command('health', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
  const live = registry.all().filter(r => r.socket)
  const pendingJobs = jobs.all().length
  const up = Math.floor((Date.now() - BOOT_AT) / 1000)
  const upStr = up < 3600 ? `${Math.floor(up / 60)}m` : `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`
  const lines = [
    `🩺 Диспетчер жив`,
    `• аптайм: ${upStr}`,
    `• последний апдейт из Telegram: ${fmtAgo(lastUpdateAt)}`,
    `• живых сессий: ${live.length}${live.length ? ' (' + live.map(r => r.threadId).join(', ') + ')' : ''}`,
    `• задач в расписании: ${pendingJobs}`,
    `• бот: @${botUsername ?? '?'}`,
  ]
  await ctx.reply(lines.join('\n'), { message_thread_id: contextThreadId(ctx) || undefined })
})

function relFuture(ms: number): string {
  const s = Math.floor((ms - Date.now()) / 1000)
  if (s < 0) return 'скоро'
  if (s < 3600) return `через ${Math.max(1, Math.floor(s / 60))}м`
  if (s < 86400) return `через ${Math.floor(s / 3600)}ч`
  return `через ${Math.floor(s / 86400)}д`
}

bot.command('jobs', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
  const all = jobs.all().slice().sort((a, b) => a.nextFireAt - b.nextFireAt)
  const tid = contextThreadId(ctx) || undefined
  if (all.length === 0) { await ctx.reply('🗓 Нет задач в расписании.', { message_thread_id: tid }); return }
  const lines = all.map(j => {
    const p = j.prompt.replace(/\s+/g, ' ').slice(0, 60)
    return `• ${j.id} — ${j.oneShot ? '1× ' : j.cron + ' '}(${relFuture(j.nextFireAt)})\n  ${p}${j.prompt.length > 60 ? '…' : ''}`
  })
  await ctx.reply(`🗓 Задачи (${all.length}):\n\n${lines.join('\n')}\n\nОтмена: /cancel <id>`, { message_thread_id: tid })
})

bot.command('cancel', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
  const id = String(ctx.match ?? '').trim()
  const tid = contextThreadId(ctx) || undefined
  if (!id) { await ctx.reply('Использование: /cancel <id> (список — /jobs)', { message_thread_id: tid }); return }
  const ok = jobs.remove(id)
  await ctx.reply(ok ? `✅ Задача ${id} отменена.` : `Задача ${id} не найдена.`, { message_thread_id: tid })
})

bot.command('search', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
  const q = String(ctx.match ?? '').trim()
  const tid = contextThreadId(ctx) || undefined
  if (!q) { await ctx.reply('Использование: /search <текст>', { message_thread_id: tid }); return }
  const rows = db.search(q, 10)
  if (rows.length === 0) { await ctx.reply(`🔎 Ничего не найдено по «${q}».`, { message_thread_id: tid }); return }
  const lines = rows.map(r => {
    const who = r.role === 'user' ? '🧑' : '🤖'
    let t = r.text.replace(/\s+/g, ' ').trim()
    if (t.length > 110) t = t.slice(0, 110) + '…'
    return `${who} [t${r.thread_id}] ${fmtAgo(r.ts)}\n${t}`
  })
  await ctx.reply(`🔎 «${q}» — ${rows.length}:\n\n${lines.join('\n\n')}`, { message_thread_id: tid })
})

bot.command('cost', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
  const tid = contextThreadId(ctx) || undefined
  const t = contextThreadId(ctx)
  const usage = readSessionUsage(t)
  if (!usage) { await ctx.reply('Не нашёл транскрипт сессии для подсчёта.', { message_thread_id: tid }); return }
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  await ctx.reply(
    `💰 Токены этой сессии (из транскрипта):\n` +
    `• вход: ${k(usage.input)}\n` +
    `• выход: ${k(usage.output)}\n` +
    `• кэш (чтение/запись): ${k(usage.cacheRead)} / ${k(usage.cacheWrite)}\n` +
    `• сообщений ассистента: ${usage.turns}`,
    { message_thread_id: tid },
  )
})

bot.command('stop', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return
  const threadId = contextThreadId(ctx)
  const rec = registry.get(threadId)
  if (!rec) {
    await ctx.reply('No session is running in this thread.', {
      message_thread_id: threadId || undefined,
    })
    return
  }
  killSession(threadId, { silent: true })
  await ctx.reply('Сессия остановлена. tmux/Claude убиты, файлы в cwd сохранены. На следующее сообщение в этом топике поднимется новая (или жми Continue ниже).', {
    message_thread_id: threadId || undefined,
    reply_markup: sessionMenu(),
  })
})

// ── Callback queries — dispatch by prefix ─────────────────────────────────
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  const access = loadAccess()
  const senderId = String(ctx.from.id)
  const threadId = contextThreadId(ctx)
  const chatId = ctx.chat?.id

  // ⏹ Stop button on the working bubble — interrupt the current turn.
  const stopTurn = /^stopturn:(\d+)$/.exec(data)
  if (stopTurn) {
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not allowed', show_alert: true })
      return
    }
    const t = Number(stopTurn[1])
    await ctx.answerCallbackQuery({ text: '⏹ Останавливаю…' })
    // Interrupt the live turn (Esc into the TUI) and stop the animator.
    ipcSend(t, { type: 'tui_send', mode: 'keys', payload: ['Escape'] })
    stopStatusMessage(t)
    // Mark the bubble consumed so a late reply doesn't re-edit it.
    try {
      const o = JSON.parse(readFileSync(statusFile(t), 'utf8'))
      atomicWrite(statusFile(t), JSON.stringify({ ...o, consumed: true }))
    } catch {}
    try {
      await ctx.editMessageText('⏹ Остановлено пользователем', { reply_markup: { inline_keyboard: [] } } as any)
    } catch {}
    return
  }

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

  // Restart context-restore choice: ctxlaunch / freshlaunch.
  if (data === 'ctxlaunch' || data === 'freshlaunch') {
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not allowed', show_alert: true })
      return
    }
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' })
      return
    }
    const pending = awaitingContextChoice.get(threadId)
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Истекло — отправь сообщение заново' })
      return
    }
    clearTimeout(pending.timeout)
    awaitingContextChoice.delete(threadId)
    await ctx.answerCallbackQuery()
    startContextLaunch(chatId, threadId, data === 'ctxlaunch', pending.promptMessageId)
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

  // Post the in-topic "💬 работаю…" status message right away — for the live
  // session, the spawn, and the restore-choice paths alike. server.ts turns it
  // into the answer on reply (covers every branch below in one call).
  if (threadId !== 0) void startStatusMessage(threadId, chatId)

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

  // Count prior history BEFORE logging this message — otherwise the just-inserted
  // message makes count >= 1 and a brand-new topic would wrongly offer restore.
  const priorHistCount = (threadId !== 0) ? db.count(threadId) : 0

  // Log the user's message to the history DB (clean text, all threads incl 0).
  db.append({
    thread_id: threadId,
    role: 'user',
    text,
    ts: Date.now(),
    message_id: msgId ?? null,
  })

  const rec = registry.get(threadId)
  if (rec?.socket) {
    ipcSend(threadId, { type: 'inbound', ...inboundMsg })
    return
  }

  // No live session in this thread.
  // (a) A spawn is already in flight, or we're waiting on the context-restore
  // choice — just append the raw message to the queue (no rename marker).
  if (spawningThreads.has(threadId) || awaitingContextChoice.has(threadId)) {
    queueInbound(threadId, inboundMsg)
    startSpawnTyping(threadId, chatId)
    return
  }

  // (b) Fresh decision point with stored history → offer the restore choice.
  // Queue the raw message (topic already named, no rename marker), then prompt.
  if (priorHistCount > 0) {
    queueInbound(threadId, inboundMsg)
    await offerContextChoice(chatId, threadId, priorHistCount)
    startSpawnTyping(threadId, chatId)
    return
  }

  // (c) No history → existing auto-launch behavior: queue this message so it's
  // the first thing Claude sees on startup. Subsequent messages within the
  // spawn window queue behind it; we drain on MCP register.
  // Attach the rename-topic task as a content prefix on the very first
  // queued message — claude consistently forgets the hint that's only in
  // the MCP system prompt, but treats inline task markers as load-bearing.
  // Only inject when there actually is a topic to rename (threadId != 0);
  // for a plain DM with topics disabled the marker would just trigger a
  // no-op rename_topic call.
  const isFirstQueued = !pendingInboundQueue.has(threadId)
  const taggedParams = (isFirstQueued && threadId !== 0) ? {
    ...inboundParams,
    content:
      '[TASK: rename_topic({name: "<2-5 word title summarizing this request, in user\'s language>"}) BEFORE any reply. Then handle the message below.]\n\n' +
      inboundParams.content,
  } : inboundParams
  const taggedMsg = { method: 'notifications/claude/channel', params: taggedParams }

  queueInbound(threadId, taggedMsg)
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
}

// ── message:* wiring ──────────────────────────────────────────────────────
const INBOX_DIR = join(STATE_DIR, 'inbox')

// Voice/audio → text, transcribed by the dispatcher BEFORE Claude sees it, so
// every session gets the transcript as plain content (no per-session skill
// dance). Groq Whisper; key from env or ~/.claude/settings.json. Through the
// same proxy the bot uses. Returns null on any failure (caller falls back).
let groqKeyCache: string | null | undefined
function groqApiKey(): string | null {
  if (groqKeyCache !== undefined) return groqKeyCache
  groqKeyCache = process.env.GROQ_API_KEY ?? null
  if (!groqKeyCache) {
    try {
      const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
      if (s?.env?.GROQ_API_KEY && typeof s.env.GROQ_API_KEY === 'string') groqKeyCache = s.env.GROQ_API_KEY
    } catch {}
  }
  return groqKeyCache
}

async function transcribeTgVoice(fileId: string): Promise<string | null> {
  const key = groqApiKey()
  if (!key) return null
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return null
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const bytes = await res.arrayBuffer()
    const fd = new FormData()
    fd.set('file', new Blob([bytes]), 'voice.ogg') // Groq rejects .oga; .ogg is fine
    fd.set('model', 'whisper-large-v3-turbo')
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(60_000),
    })
    const j = await r.json() as { text?: string }
    const t = (j.text ?? '').trim()
    return t || null
  } catch (err) {
    process.stderr.write(`telegram-dispatcher: voice transcription failed: ${err}\n`)
    return null
  }
}

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
  const transcript = await transcribeTgVoice(v.file_id)
  const cap = ctx.message.caption ? `\n\n${ctx.message.caption}` : ''
  const content = transcript
    ? `🎙 (голосовое, расшифровка):\n${transcript}${cap}`
    : (ctx.message.caption ?? '(voice message)')
  await handleInbound(ctx, content, undefined, {
    kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const a = ctx.message.audio
  const name = safeName(a.file_name)
  const transcript = await transcribeTgVoice(a.file_id)
  const cap = ctx.message.caption ? `\n\n${ctx.message.caption}` : ''
  const content = transcript
    ? `🎙 (аудио, расшифровка):\n${transcript}${cap}`
    : (ctx.message.caption ?? `(audio: ${safeName(a.title) ?? name ?? 'audio'})`)
  await handleInbound(ctx, content, undefined, {
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
          const wasDown = attempt > 1
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-dispatcher: polling as @${info.username}\n`)
          // Tell the owner the bridge is back (boot or recovery from an outage).
          notifyOwner(wasDown ? `✅ Бридж восстановился, поллинг возобновлён (@${info.username}).` : `✅ Диспетчер запущен, поллинг активен (@${info.username}).`)
          void bot.api.setMyCommands([
            { command: 'start', description: 'Welcome and setup guide' },
            { command: 'help', description: 'What this bot can do' },
            { command: 'status', description: 'Check your pairing state' },
            { command: 'health', description: 'Dispatcher health' },
            { command: 'effort', description: 'Set thinking effort' },
            { command: 'model', description: 'Pick model' },
            { command: 'mode', description: 'Cycle permission mode' },
            { command: 'clear', description: 'Clear context' },
            { command: 'resume', description: 'Resume conversation' },
            { command: 'interrupt', description: 'Interrupt (Esc)' },
            { command: 'jobs', description: 'List scheduled tasks' },
            { command: 'cancel', description: 'Cancel a scheduled task: /cancel <id>' },
            { command: 'search', description: 'Search history: /search <text>' },
            { command: 'cost', description: 'Token usage of this session' },
            { command: 'stop', description: 'Kill Claude session in this topic' },
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
      // After a few failed attempts, alert the owner — the bridge is wedged.
      if (attempt === 4) {
        notifyOwner(`⚠️ Поллинг падает (${is409 ? '409 Conflict — другой инстанс?' : 'сетевая ошибка/прокси'}). Повторяю каждые ~${delay / 1000}s.`)
      }
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()
