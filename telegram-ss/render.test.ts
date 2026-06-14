import { test, expect } from 'bun:test'
import { mdToHtml, chunkMarkdown, htmlEscape } from './render'

test('escapes HTML metacharacters in plain text', () => {
  expect(mdToHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d')
})

test('bold, italic, strikethrough', () => {
  expect(mdToHtml('**bold**')).toBe('<b>bold</b>')
  expect(mdToHtml('a *italic* b')).toBe('a <i>italic</i> b')
  expect(mdToHtml('a _italic_ b')).toBe('a <i>italic</i> b')
  expect(mdToHtml('~~gone~~')).toBe('<s>gone</s>')
})

test('does NOT italicize arithmetic like 5 * 3 = 15', () => {
  expect(mdToHtml('5 * 3 = 15')).toBe('5 * 3 = 15')
  expect(mdToHtml('a_b_c snake_case')).toBe('a_b_c snake_case')
})

test('inline code is escaped and not emphasis-processed', () => {
  expect(mdToHtml('use `a < b` and `**not bold**`')).toBe(
    'use <code>a &lt; b</code> and <code>**not bold**</code>')
})

test('fenced code block with language → pre/code', () => {
  const out = mdToHtml('```python\nprint(1 < 2)\n```')
  expect(out).toBe('<pre><code class="language-python">print(1 &lt; 2)</code></pre>')
})

test('fenced code block protects its markdown-looking content', () => {
  const out = mdToHtml('```\n**stars** and _under_\n```')
  expect(out).toBe('<pre><code>**stars** and _under_</code></pre>')
})

test('links', () => {
  expect(mdToHtml('see [docs](https://x.io/a?b=1&c=2)')).toBe(
    'see <a href="https://x.io/a?b=1&amp;c=2">docs</a>')
})

test('headers become bold, bullets become •', () => {
  expect(mdToHtml('# Title')).toBe('<b>Title</b>')
  expect(mdToHtml('- one\n- two')).toBe('• one\n• two')
  expect(mdToHtml('* a\n* b')).toBe('• a\n• b')
})

test('consecutive blockquote lines merge into one block', () => {
  expect(mdToHtml('> line one\n> line two')).toBe(
    '<blockquote>line one\nline two</blockquote>')
})

test('mixed real-world snippet stays balanced', () => {
  const md = 'Готово. Запустил `bun test` — **14 зелёных**.\n\n```ts\nconst x = a < b\n```\nСсылка: [тут](https://t.me/x)'
  const out = mdToHtml(md)
  // balanced tag check: every opener has a closer
  for (const tag of ['b', 'i', 'code', 'pre', 'a']) {
    const open = (out.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length
    const close = (out.match(new RegExp(`</${tag}>`, 'g')) || []).length
    expect(open).toBe(close)
  }
  expect(out).toContain('<code>bun test</code>')
  expect(out).toContain('<b>14 зелёных</b>')
  expect(out).toContain('<pre><code class="language-ts">const x = a &lt; b</code></pre>')
})

test('bold wins over italic for ** (no nested-star mangling)', () => {
  expect(mdToHtml('**both**')).toBe('<b>both</b>')
})

test('htmlEscape standalone', () => {
  expect(htmlEscape('<a> & <b>')).toBe('&lt;a&gt; &amp; &lt;b&gt;')
})

// ── chunkMarkdown ──────────────────────────────────────────────────────────
test('short text → single chunk', () => {
  expect(chunkMarkdown('hello', 100)).toEqual(['hello'])
})

test('splits at line boundaries under the limit', () => {
  const md = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n') // 4 lines of 4 + newlines
  const chunks = chunkMarkdown(md, 10)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every(c => c.length <= 10)).toBe(true)
  expect(chunks.join('\n')).toBe(md)
})

test('never splits inside a fenced code block', () => {
  const md = 'intro line here\n```\nline1\nline2\nline3\nline4\n```\noutro'
  const chunks = chunkMarkdown(md, 20)
  // the whole fence must live in exactly one chunk
  const fenceChunks = chunks.filter(c => c.includes('```'))
  expect(fenceChunks.length).toBe(1)
  expect(fenceChunks[0]).toContain('line1')
  expect(fenceChunks[0]).toContain('line4')
})

// ── tables / images / spoilers (added when re-introducing markup, opt-in) ────
test('GFM table → aligned monospace pre, cells escaped', () => {
  const md = '| Name | Qty |\n| --- | --- |\n| Apple | 2 |\n| Pear | 10 |'
  expect(mdToHtml(md)).toBe('<pre>Name   Qty\nApple  2\nPear   10</pre>')
})

test('table cells with HTML metachars are escaped', () => {
  const md = '| a | b |\n|---|---|\n| 1<2 | x&y |'
  expect(mdToHtml(md)).toBe('<pre>a    b\n1&lt;2  x&amp;y</pre>')
})

test('text around a table is still rendered', () => {
  const md = 'Итог:\n\n| k | v |\n|---|---|\n| a | 1 |\n\n**done**'
  const out = mdToHtml(md)
  expect(out).toContain('Итог:')
  expect(out).toContain('<pre>k  v\na  1</pre>')
  expect(out).toContain('<b>done</b>')
})

test('image becomes a labelled link', () => {
  expect(mdToHtml('![cat](https://x.io/c.png)')).toBe(
    '🖼 <a href="https://x.io/c.png">cat</a>')
  // empty alt → url as label
  expect(mdToHtml('![](https://x.io/c.png)')).toBe(
    '🖼 <a href="https://x.io/c.png">https://x.io/c.png</a>')
})

test('spoiler', () => {
  expect(mdToHtml('a ||boo|| b')).toBe('a <span class="tg-spoiler">boo</span> b')
})

test('a single | in prose is left alone', () => {
  expect(mdToHtml('use a | b for pipes')).toBe('use a | b for pipes')
})

test('chunkMarkdown keeps a whole table together', () => {
  const md = 'before\n| h1 | h2 |\n| --- | --- |\n| a | b |\n| c | d |\n| e | f |\nafter'
  const chunks = chunkMarkdown(md, 20)
  const tableChunks = chunks.filter(c => c.includes('| h1 |'))
  expect(tableChunks.length).toBe(1)
  expect(tableChunks[0]).toContain('| e | f |')
})
