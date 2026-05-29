// Single SQLite store for per-topic message history.
// Only the dispatcher writes; MCP sessions relay outbound replies via IPC.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'

export type MsgRole = 'user' | 'assistant'

export interface StoredMsg {
  thread_id: number
  role: MsgRole
  text: string
  ts: number          // ms epoch
  message_id: number | null
}

const PER_MSG_CHARS = 2000
const DEFAULT_MAX_CHARS = 32000
const DEFAULT_MAX_MSGS = 50

export class TopicDb {
  private db: Database

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new Database(file, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id  INTEGER NOT NULL,
        role       TEXT    NOT NULL,
        text       TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        message_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread_ts
        ON messages(thread_id, ts);
    `)
  }

  append(m: StoredMsg): void {
    this.db
      .query(
        'INSERT INTO messages (thread_id, role, text, ts, message_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(m.thread_id, m.role, m.text, m.ts, m.message_id)
  }

  // Latest `limit` messages of a topic, oldest → newest.
  recent(threadId: number, limit = DEFAULT_MAX_MSGS): StoredMsg[] {
    const rows = this.db
      .query(
        'SELECT thread_id, role, text, ts, message_id FROM messages WHERE thread_id = ? ORDER BY ts DESC, id DESC LIMIT ?',
      )
      .all(threadId, limit) as StoredMsg[]
    return rows.reverse()
  }

  // Full-text-ish search across all topics (newest first). LIKE with escaping
  // so %, _ and \ in the query are treated literally.
  search(query: string, limit = 10): StoredMsg[] {
    const escaped = query.replace(/[\\%_]/g, m => '\\' + m)
    return this.db
      .query(
        "SELECT thread_id, role, text, ts, message_id FROM messages WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC, id DESC LIMIT ?",
      )
      .all(`%${escaped}%`, limit) as StoredMsg[]
  }

  count(threadId: number): number {
    const row = this.db
      .query('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?')
      .get(threadId) as { n: number } | null
    return row?.n ?? 0
  }

  // Render recent messages as a context prefix for a fresh session's first message.
  formatContext(threadId: number, opts?: { maxMsgs?: number; maxChars?: number }): string {
    const maxMsgs = opts?.maxMsgs ?? DEFAULT_MAX_MSGS
    const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS
    const msgs = this.recent(threadId, maxMsgs)
    if (msgs.length === 0) return ''

    const lines = msgs.map((m) => {
      const who = m.role === 'user' ? 'Пользователь' : 'Claude'
      let text = m.text
      if (text.length > PER_MSG_CHARS) text = text.slice(0, PER_MSG_CHARS) + '…'
      return `${who}: ${text}`
    })

    // Enforce total budget by dropping the oldest lines first.
    let total = lines.reduce((sum, l) => sum + l.length + 1, 0)
    let start = 0
    while (start < lines.length && total > maxChars) {
      total -= lines[start].length + 1
      start++
    }
    return lines.slice(start).join('\n')
  }
}

export function defaultDbFile(stateDir: string): string {
  return join(stateDir, 'state.db')
}
