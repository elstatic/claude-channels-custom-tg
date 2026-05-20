// Unix-socket IPC between the dispatcher (one process polling Telegram) and
// per-session MCP instances. Protocol is newline-delimited JSON.
//
// MCP → dispatcher messages:
//   { type: "register", thread_id, chat_id, pid }
//   { type: "outbound_dialog", question, options[] }   // a TUI confirm popped up; surface as inline kbd
//   { type: "permission_reply", request_id, behavior } // Claude's answer to a permission prompt
//
// Dispatcher → MCP messages:
//   { type: "inbound", method, params }                // notifications/claude/channel{,/permission,/prompt_answer}
//   { type: "tui_send", mode: "slash"|"keys", payload } // execute tmux send-keys in the MCP's pane
//   { type: "watch_dialog" }                            // start the dialog-poll watcher
import net from 'net'
import { unlinkSync, chmodSync } from 'fs'

export type RegisterMsg = { type: 'register'; thread_id: number; chat_id: number; pid: number }
export type InboundMsg = { type: 'inbound'; method: string; params: Record<string, unknown> }
export type TuiSendMsg = { type: 'tui_send'; mode: 'slash' | 'keys'; payload: string | string[] }
export type WatchDialogMsg = { type: 'watch_dialog' }
export type OutboundDialogMsg = { type: 'outbound_dialog'; question: string; options: { idx: number; label: string }[] }
export type PermissionReplyMsg = { type: 'permission_reply'; request_id: string; behavior: 'allow' | 'deny' }
export type PromptAnswerMsg = { type: 'inbound'; method: 'notifications/claude/channel/prompt_answer'; params: { prompt_id: string; idx: number } }

export type DispatcherToMcp = InboundMsg | TuiSendMsg | WatchDialogMsg
export type McpToDispatcher = RegisterMsg | OutboundDialogMsg | PermissionReplyMsg

// Line-buffered JSON reader. Calls handler(json) for each complete message.
export function attachLineReader(sock: net.Socket, handler: (line: string) => void) {
  let buf = ''
  sock.on('data', chunk => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) handler(line)
    }
  })
}

export function sendJson(sock: net.Socket, msg: object): void {
  try {
    sock.write(JSON.stringify(msg) + '\n')
  } catch {
    // socket may be ended; caller handles
  }
}

// Dispatcher-side: bind and accept connections.
export function createIpcServer(opts: {
  path: string
  onConnect: (sock: net.Socket) => void
  onMessage: (sock: net.Socket, msg: McpToDispatcher) => void
  onDisconnect: (sock: net.Socket) => void
}): net.Server {
  try { unlinkSync(opts.path) } catch {}
  const server = net.createServer(sock => {
    opts.onConnect(sock)
    attachLineReader(sock, line => {
      let parsed: McpToDispatcher
      try { parsed = JSON.parse(line) } catch { return }
      opts.onMessage(sock, parsed)
    })
    sock.on('close', () => opts.onDisconnect(sock))
    sock.on('error', () => {/* socket gone, close will fire */})
  })
  server.listen(opts.path, () => {
    try { chmodSync(opts.path, 0o600) } catch {}
  })
  return server
}

// MCP-side: connect with auto-reconnect.
export function connectToIpc(opts: {
  path: string
  onConnect: (sock: net.Socket) => void
  onMessage: (msg: DispatcherToMcp) => void
  onDisconnect: () => void
  reconnectMs?: number
}): { send: (msg: McpToDispatcher) => void; close: () => void } {
  const reconnectMs = opts.reconnectMs ?? 2000
  let current: net.Socket | null = null
  let closed = false
  let reconnectTimer: NodeJS.Timeout | null = null

  function connect() {
    if (closed) return
    const sock = net.createConnection(opts.path)
    current = sock
    sock.on('connect', () => {
      opts.onConnect(sock)
    })
    attachLineReader(sock, line => {
      let parsed: DispatcherToMcp
      try { parsed = JSON.parse(line) } catch { return }
      opts.onMessage(parsed)
    })
    sock.on('close', () => {
      if (current === sock) current = null
      opts.onDisconnect()
      if (!closed) reconnectTimer = setTimeout(connect, reconnectMs)
    })
    sock.on('error', () => { /* close will fire */ })
  }

  connect()

  return {
    send(msg) {
      if (current && !current.destroyed) sendJson(current, msg)
    },
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (current) current.destroy()
    },
  }
}
