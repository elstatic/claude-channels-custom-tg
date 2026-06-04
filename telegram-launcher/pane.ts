// Extract the agent's live "thinking" from a tmux capture-pane dump of the
// Claude Code TUI. We do NOT scrape the whole UI — we lift just the most recent
// prose narration (what the model is currently writing) plus the spinner caption
// (CC shows the in-progress task's activeForm there). Everything below the
// spinner is chrome (input box + footer); tool calls and the todo list above it
// are not thinking. Kept pure + dependency-free so it's unit-testable on real
// captured fixtures (see pane.test.ts / testdata).

export interface PaneThinking {
  /** The spinner caption, e.g. "Cogitating" or "Building pane thinking parser". */
  statusWord: string
  /** Up to maxLines of the most recent prose narration, oldest-first. */
  lines: string[]
}

// Star-like glyphs Claude Code rotates through on its working spinner line.
const SPINNER = '✻✽✶✢✳✴✦✧✺✷✸✹'
const SPINNER_RE = new RegExp(`^\\s*[${SPINNER}]\\s+(\\S.*)$`, 'u')
const BORDER_RE = /^─{4,}/

function captionOf(spinnerBody: string): string {
  return spinnerBody
    .replace(/\s*\(.*$/, '') // drop "(13m 32s · ↓ 23.4k tokens)"
    .replace(/…+\s*$/, '')   // drop trailing ellipsis
    .trim()
}

// A pane line that is real narration prose — not a tool call, tool result,
// todo bullet, box border, or a deeply-indented wrapped tool argument.
function isProse(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  const indent = line.length - line.trimStart().length
  if (indent >= 4) return false        // wrapped tool-arg continuation
  if (BORDER_RE.test(t)) return false  // input-box border
  if (/^⎿/.test(t)) return false       // tool result/status ("⎿ Running…")
  if (/^[◼◻▪▫●○⏺]/.test(t)) return false // todo bullets / tool markers
  if (/^[A-Z][A-Za-z]+\(/.test(t)) return false // tool header, e.g. "Bash("
  return true
}

export function parsePaneThinking(text: string, maxLines = 3): PaneThinking {
  const raw = text.replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''))

  // Anchor on the spinner line (search from the bottom — it's just above the
  // input box). Everything from it down is chrome we never want.
  let spin = -1
  let statusWord = ''
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i].match(SPINNER_RE)
    if (m) { spin = i; statusWord = captionOf(m[1]); break }
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
