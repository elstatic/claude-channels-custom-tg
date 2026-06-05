// Extract the agent's live "thinking" from a tmux capture-pane dump of the
// Claude Code TUI. We do NOT scrape the whole UI — we lift just the most recent
// prose narration (what the model is currently writing) plus the spinner caption
// (CC shows the in-progress task's activeForm there). Everything below the
// spinner is chrome (input box + footer); tool calls, the todo list, and queued
// inbound messages above it are not thinking. Kept pure + dependency-free so
// it's unit-testable on real captured fixtures (see pane.test.ts / testdata).

export interface PaneThinking {
  /** The spinner caption, e.g. "Cogitating" or "Building pane thinking parser". */
  statusWord: string
  /** Up to maxLines of the most recent prose narration, oldest-first. */
  lines: string[]
}

const BORDER_RE = /^─{4,}/
// Spinner/status line, matched by SHAPE not a fixed glyph list — Claude Code
// rotates the leading glyph through many symbols (✻ ✽ ✶ ✢ ✳ ✺ * ✱ ∗ …) and a
// hard-coded list silently breaks anchoring when a new frame shows up. Shape:
// a leading non-word glyph, a Capitalized caption, and a "…"/duration/timer.
const TIMER_RE = /…|\bfor\s+\d|\(\s*\d+m?\s*\d*\.?\d*\s*[smk]\b/
function isSpinnerLine(t: string): boolean {
  return /^[^\w\s]\s+[A-Z][a-z]/.test(t) && TIMER_RE.test(t)
}

function captionOf(line: string): string {
  return line
    .replace(/^[^\w\s]\s+/, '')      // drop the leading spinner glyph
    .replace(/\s*\(.*$/, '')         // drop "(13m 32s · ↓ 23.4k tokens)"
    .replace(/…+.*$/, '')            // drop trailing ellipsis (+ anything after)
    .replace(/\s+for\s+\d.*$/, '')   // drop "for 1m 17s" (the idle caption tail)
    .trim()
}

// A pane line that is real narration prose — not a tool call, tool result, todo
// bullet, box border, spinner, or a queued/echoed inbound message.
function isProse(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  const indent = line.length - line.trimStart().length
  if (indent >= 4) return false          // wrapped tool-arg continuation
  if (BORDER_RE.test(t)) return false    // input-box border
  if (isSpinnerLine(t)) return false     // the spinner/status line itself
  if (/^[←→]/.test(t)) return false      // queued/sent message markers in the TUI
  if (/(^|\s)telegram-ss\s*·/.test(t)) return false // "… telegram-ss · user: …" echo
  if (/^⎿/.test(t)) return false         // tool result/status / "⎿ Tip:" line
  if (/^[◼◻▪▫●○⏺]/.test(t)) return false // todo bullets / tool markers
  if (/^[A-Z][A-Za-z]+\(/.test(t)) return false // tool header, e.g. "Bash("
  return true
}

// Fatal/user-facing errors Claude Code surfaces in the pane as a "●"-prefixed
// line (e.g. "● Please run /login · API Error: 401 Invalid authentication
// credentials"). When a turn dies on one of these, no reply() is ever sent and
// the user just sees the spinner forever — so the dispatcher relays it to chat.
// Conservative signature list: only unambiguous failures, never normal prose
// that happens to contain the word "error".
const ERROR_SIGNATURES = [
  /API Error/i,
  /Please run \/login/i,
  /Invalid authentication/i,
  /Failed to authenticate/i,
  /Credit balance is too low/i,
  /\boverloaded(_error)?\b/i,
  /rate[ _]?limit/i,
  /quota/i,
  /\b(401|403|429|500|503|529)\b.*\berror\b/i,
  /\berror\b.*\b(401|403|429|500|503|529)\b/i,
  /Internal server error/i,
]

/** Strip CC's leading marker glyph + collapse whitespace for a chat-friendly line. */
function cleanErrorLine(line: string): string {
  return line
    .replace(/^\s*[●○⏺✻✶✗✘⚠×]\s*/, '') // drop the leading status/error glyph
    .replace(/\s+/g, ' ')
    .trim()
}

// Return the most recent error line in the pane (searching bottom-up, but above
// the input box / spinner chrome), or null. Pure + testable.
export function parsePaneError(text: string): string | null {
  const raw = text.replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''))
  // Same region anchoring as parsePaneThinking: the conversation is above the
  // spinner (just over the input box); with no spinner this frame, above the
  // first box border. That keeps what the user is typing in the input box out.
  let spin = -1
  for (let i = raw.length - 1; i >= 0; i--) {
    if (isSpinnerLine(raw[i].trim())) { spin = i; break }
  }
  let end = spin
  if (end < 0) {
    end = raw.findIndex(l => BORDER_RE.test(l.trim()))
    if (end < 0) end = raw.length
  }
  for (let i = end - 1; i >= 0; i--) {
    const t = raw[i].trim()
    if (!t) continue
    if (/^[←→]/.test(t)) continue                 // queued/echoed inbound markers
    if (/(^|\s)telegram-ss\s*·/.test(t)) continue // our own channel echo
    if (ERROR_SIGNATURES.some(re => re.test(t))) {
      const msg = cleanErrorLine(t)
      if (msg.length > 400) return msg.slice(0, 399) + '…'
      return msg
    }
  }
  return null
}

export function parsePaneThinking(text: string, maxLines = 3): PaneThinking {
  const raw = text.replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''))

  // Anchor on the spinner line (search from the bottom — it's just above the
  // input box). Everything from it down is chrome we never want.
  let spin = -1
  let statusWord = ''
  for (let i = raw.length - 1; i >= 0; i--) {
    if (isSpinnerLine(raw[i].trim())) { spin = i; statusWord = captionOf(raw[i].trim()); break }
  }

  // Region holding the conversation/thinking: above the spinner, or — if no
  // spinner this frame — above the first input-box border.
  let end = spin
  if (end < 0) {
    end = raw.findIndex(l => BORDER_RE.test(l.trim()))
    if (end < 0) end = raw.length
  }

  const lines: string[] = []
  for (let i = end - 1; i >= 0 && lines.length < maxLines; i--) {
    if (isProse(raw[i])) lines.push(raw[i].trim())
  }
  lines.reverse()
  return { statusWord, lines }
}
