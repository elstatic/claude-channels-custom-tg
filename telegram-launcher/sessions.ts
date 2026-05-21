// Persistent registry of Claude sessions, keyed by Telegram message_thread_id.
// One record per topic. Survives dispatcher restart via sessions.json.
// Sockets are runtime-only (not serialized).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { spawnSync } from 'child_process'
import { join, dirname } from 'path'
import type net from 'net'

export type SessionRecord = {
  threadId: number    // 0 = non-topic chat root (private chat without forum mode)
  chatId: number
  tmuxSession: string
  pid?: number        // last known MCP pid
  startedAt: number
  lastActivityAt?: number  // ms epoch — bumped on every inbound delivered to this session
  // runtime, never persisted:
  socket?: net.Socket
}

type Persisted = Omit<SessionRecord, 'socket'>

export class SessionRegistry {
  private byThread = new Map<number, SessionRecord>()
  constructor(private file: string) {}

  load(): void {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const arr = JSON.parse(raw) as Persisted[]
      this.byThread.clear()
      for (const r of arr) this.byThread.set(r.threadId, { ...r })
    } catch {
      this.byThread.clear()
    }
  }

  save(): void {
    try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }) } catch {}
    const arr: Persisted[] = Array.from(this.byThread.values()).map(({ socket: _s, ...rest }) => rest)
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tmp, JSON.stringify(arr, null, 2))
    renameSync(tmp, this.file)
  }

  get(threadId: number): SessionRecord | undefined {
    return this.byThread.get(threadId)
  }

  has(threadId: number): boolean {
    return this.byThread.has(threadId)
  }

  add(rec: Omit<SessionRecord, 'startedAt'> & { startedAt?: number }): SessionRecord {
    const full: SessionRecord = { startedAt: Date.now(), ...rec }
    this.byThread.set(full.threadId, full)
    this.save()
    return full
  }

  remove(threadId: number): void {
    this.byThread.delete(threadId)
    this.save()
  }

  attachSocket(threadId: number, sock: net.Socket, pid?: number): void {
    const rec = this.byThread.get(threadId)
    if (!rec) return
    rec.socket = sock
    if (pid != null) rec.pid = pid
    this.save()
  }

  detachSocket(sock: net.Socket): number | null {
    for (const rec of this.byThread.values()) {
      if (rec.socket === sock) {
        rec.socket = undefined
        return rec.threadId
      }
    }
    return null
  }

  socketOf(threadId: number): net.Socket | undefined {
    return this.byThread.get(threadId)?.socket
  }

  threadOf(sock: net.Socket): number | null {
    for (const rec of this.byThread.values()) {
      if (rec.socket === sock) return rec.threadId
    }
    return null
  }

  touch(threadId: number): void {
    const rec = this.byThread.get(threadId)
    if (!rec) return
    rec.lastActivityAt = Date.now()
    // Persist lazily — saving on every inbound is overkill; the in-memory
    // value is what the sweep checks. On graceful shutdown we save() anyway.
  }

  all(): SessionRecord[] {
    return Array.from(this.byThread.values())
  }

  // Returns thread ids that have NO live tmux session (caller should clean up).
  pruneDead(tmuxBin = 'tmux'): number[] {
    const dead: number[] = []
    for (const rec of this.byThread.values()) {
      const r = spawnSync(tmuxBin, ['has-session', '-t', rec.tmuxSession], { stdio: 'ignore' })
      if (r.status !== 0) dead.push(rec.threadId)
    }
    for (const t of dead) this.byThread.delete(t)
    if (dead.length > 0) this.save()
    return dead
  }
}

// Default location used by both dispatcher and MCP IPC client.
export function defaultSessionsFile(stateDir: string): string {
  return join(stateDir, 'sessions.json')
}

export function defaultIpcSocket(stateDir: string): string {
  return join(stateDir, 'dispatcher.sock')
}
