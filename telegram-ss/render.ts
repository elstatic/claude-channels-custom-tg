// Render the agent's markdown answers into the small HTML subset Telegram
// supports (<b> <i> <s> <u> <code> <pre> <a> <blockquote> <span class=tg-spoiler>).
// Telegram has no headers/tables/lists, so headers become bold, GFM tables become
// a monospaced <pre>, bullets become •, and images become labelled links. The
// converter is conservative and always produces BALANCED tags; callers still keep
// a plain-text fallback in case Telegram rejects the HTML. Pure + dependency-free
// so it's unit-testable (see render.test.ts).

export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const NUL = '\u0000' // sentinel — never appears in real answer text

// A separator row of a GFM table: only spaces, colons, dashes and pipes, with at
// least one dash (e.g. "| --- | :--: |").
const TABLE_SEP = /^[\s:|-]+$/
function isTableStart(line: string | undefined, sep: string | undefined): boolean {
  return (
    line !== undefined && line.includes('|') &&
    sep !== undefined && sep.includes('-') && TABLE_SEP.test(sep)
  )
}

// Render a GFM table (header + body rows; the separator row is dropped) as a
// monospaced <pre> with padded columns — Telegram has no table primitive.
function renderTable(rows: string[]): string {
  const cells = rows.map(r =>
    r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()),
  )
  const ncol = Math.max(...cells.map(r => r.length))
  const w: number[] = []
  for (let c = 0; c < ncol; c++) w[c] = Math.max(...cells.map(r => (r[c] ?? '').length))
  const lines = cells.map(r =>
    r.map((c, ci) => (c ?? '').padEnd(w[ci])).join('  ').replace(/\s+$/, ''),
  )
  return `<pre>${htmlEscape(lines.join('\n'))}</pre>`
}

export function mdToHtml(md: string): string {
  let s = md.replace(/\r\n?/g, '\n')

  // 1. Pull fenced code blocks out first so their contents are never touched by
  //    the markdown/escaping passes below.
  const blocks: string[] = []
  s = s.replace(/```([\w+#.-]*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const cls = lang ? ` class="language-${lang}"` : ''
    blocks.push(`<pre><code${cls}>${htmlEscape(body.replace(/\n$/, ''))}</code></pre>`)
    return `${NUL}CB${blocks.length - 1}${NUL}`
  })

  // 1b. Pull GFM tables out (rendered to monospace <pre>, escaped) before any
  //     inline pass so cell text never sprouts tags inside the <pre>.
  {
    const lines = s.split('\n')
    const kept: string[] = []
    for (let i = 0; i < lines.length;) {
      if (isTableStart(lines[i], lines[i + 1])) {
        const rows = [lines[i]]
        i += 2 // skip header + separator
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(lines[i]); i++
        }
        blocks.push(renderTable(rows))
        kept.push(`${NUL}CB${blocks.length - 1}${NUL}`)
      } else {
        kept.push(lines[i]); i++
      }
    }
    s = kept.join('\n')
  }

  // 2. Escape everything else (our inserted tags below are the only real tags).
  s = htmlEscape(s)

  // 3. Inline code — protect from emphasis. Content is already escaped (step 2).
  const inline: string[] = []
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    inline.push(`<code>${c}</code>`)
    return `${NUL}IC${inline.length - 1}${NUL}`
  })

  // 3b. Images ![alt](url) → labelled link (Telegram can't inline images into a
  //     text message). Runs before the link pass so the leading ! is consumed.
  s = s.replace(/!\[([^\]\n]*)\]\((https?:[^)\s]+|tg:[^)\s]+)\)/g,
    (_m, alt: string, url: string) => `🖼 <a href="${url}">${alt || url}</a>`)

  // 4. Links [text](url) — brackets/parens survive escaping; url goes in href.
  s = s.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+|tg:[^)\s]+)\)/g,
    (_m, text: string, url: string) => `<a href="${url}">${text}</a>`)

  // 5. Emphasis — bold before italic so ** isn't eaten as two * .
  s = s.replace(/\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/g, '<b>$1</b>')
  s = s.replace(/(^|[^_])__(?!\s)([^\n]+?)(?<!\s)__(?!_)/g, '$1<b>$2</b>')
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/g, '$1<i>$2</i>')
  s = s.replace(/~~(?!\s)([^\n]+?)(?<!\s)~~/g, '<s>$1</s>')
  s = s.replace(/\|\|(?!\s)([^\n]+?)(?<!\s)\|\|/g, '<span class="tg-spoiler">$1</span>')

  // 6. Per-line block constructs: headers → bold, bullets → •, > → blockquote
  //    (consecutive quote lines merged into one block).
  const out: string[] = []
  let quote: string[] | null = null
  const flushQuote = () => {
    if (quote) { out.push(`<blockquote>${quote.join('\n')}</blockquote>`); quote = null }
  }
  for (const line of s.split('\n')) {
    const q = line.match(/^&gt;\s?(.*)$/)
    if (q) { (quote ??= []).push(q[1]); continue }
    flushQuote()
    let m: RegExpMatchArray | null
    if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) { out.push(`<b>${m[2]}</b>`); continue }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) { out.push(`${m[1]}• ${m[2]}`); continue }
    out.push(line)
  }
  flushQuote()
  s = out.join('\n')

  // 7. Restore protected spans.
  s = s.replace(new RegExp(`${NUL}IC(\\d+)${NUL}`, 'g'), (_m, i) => inline[+i])
  s = s.replace(new RegExp(`${NUL}CB(\\d+)${NUL}`, 'g'), (_m, i) => blocks[+i])
  return s
}

// Split a RAW markdown answer at line boundaries without ever cutting inside a
// fenced ``` block, so each chunk can be converted to HTML independently (tags
// never span messages). A single fence larger than `limit` is returned whole —
// the caller decides whether to send it as a file or hard-split.
export function chunkMarkdown(md: string, limit: number): string[] {
  if (md.length <= limit) return [md]
  // Tokenize into atomic units: each fenced block is ONE unit (kept whole), every
  // other line is its own unit. Then greedily pack units into chunks ≤ limit.
  const lines = md.split('\n')
  const units: string[] = []
  for (let i = 0; i < lines.length;) {
    if (/^\s*```/.test(lines[i])) {
      let blk = lines[i++]
      while (i < lines.length) {
        const isClose = /^\s*```/.test(lines[i])
        blk += '\n' + lines[i++]
        if (isClose) break
      }
      units.push(blk)
    } else if (isTableStart(lines[i], lines[i + 1])) {
      // Keep a whole table together so its separator never lands in another chunk.
      let blk = lines[i] + '\n' + lines[i + 1]
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        blk += '\n' + lines[i++]
      }
      units.push(blk)
    } else {
      units.push(lines[i++])
    }
  }
  const chunks: string[] = []
  let cur = ''
  for (const u of units) {
    const next = cur ? cur + '\n' + u : u
    if (cur && next.length > limit) { chunks.push(cur); cur = u }
    else cur = next
  }
  if (cur) chunks.push(cur)
  return chunks
}
