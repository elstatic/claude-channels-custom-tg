import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePaneThinking, parsePaneError, parseStuckInput } from './pane'

const fixture = (n: string) => readFileSync(join(import.meta.dir, 'testdata', n), 'utf8')

test('working pane: status word from the in-progress spinner caption', () => {
  const r = parsePaneThinking(fixture('pane-working.txt'))
  // CC renders the in-progress task's activeForm as the spinner caption.
  expect(r.statusWord).toBe('Building pane thinking parser')
})

test('working pane: keeps prose narration, drops the active tool block + todos', () => {
  const r = parsePaneThinking(fixture('pane-working.txt'))
  const blob = r.lines.join('\n')
  // The last prose line before the running Bash() call must survive.
  expect(r.lines.some(l => l.includes('derivation'))).toBe(true)
  // Tool header, its wrapped continuations, the ⎿ status, and the todo list
  // are NOT thinking — they must be stripped.
  expect(blob).not.toContain('Bash(')
  expect(blob).not.toContain('⎿')
  expect(blob).not.toContain('Running')
  expect(blob).not.toMatch(/testdata/)
  expect(blob).not.toMatch(/◼|◻/)
})

test('idle pane: caption parsed, last narration sentences kept, no chrome', () => {
  const r = parsePaneThinking(fixture('pane-idle.txt'))
  expect(r.statusWord.startsWith('Crunched')).toBe(true)
  expect(r.lines.length).toBeGreaterThan(0)
  expect(r.lines.length).toBeLessThanOrEqual(3)
  const blob = r.lines.join('\n')
  // No box borders, prompt echo, or footer chrome leaks in.
  expect(blob).not.toMatch(/────/)
  expect(blob).not.toContain('❯')
  expect(blob).not.toContain('bypass permissions')
  expect(blob).not.toContain('new task?')
})

test('caps at maxLines', () => {
  const r = parsePaneThinking(fixture('pane-idle.txt'), 2)
  expect(r.lines.length).toBeLessThanOrEqual(2)
})

test('explicit thinking text above an active spinner is captured', () => {
  const sample = [
    '  Earlier narration that scrolled up.',
    '',
    '  I should check whether the trace file races with the render,',
    '  then decide if a lock is needed.',
    '',
    '✶ Cogitating… (4s · ↑ 1.2k tokens)',
    '',
    '────────────────────────────',
    '❯ ',
    '────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
  ].join('\n')
  const r = parsePaneThinking(sample)
  expect(r.statusWord).toBe('Cogitating')
  expect(r.lines.some(l => l.includes('lock is needed'))).toBe(true)
  expect(r.lines.join('\n')).not.toContain('❯')
})

test('regression: `*` spinner glyph is detected by shape, not a glyph list', () => {
  const sample = [
    '  Я обновляю парсер, чтобы он ловил спиннер по форме.',
    '',
    '* Creating… (3m 3s · ↓ 7.7k tokens)',
    '  ⎿ Tip: Name your conversations with /rename',
    '',
    '────────────────────────────',
    '❯ ',
    '────────────────────────────',
  ].join('\n')
  const r = parsePaneThinking(sample)
  expect(r.statusWord).toBe('Creating')
  expect(r.lines.some(l => l.includes('ловил спиннер'))).toBe(true)
})

test('regression: queued inbound message must NOT be shown as thinking', () => {
  // The truncated "чтобы пр…" bug: the user's own queued message leaked in.
  const sample = [
    '  Реальная мысль агента вот здесь.',
    '',
    '* Creating… (1m · ↓ 2k tokens)',
    '  ⎿ Tip: ...',
    '',
    '',
    '  ← telegram-ss · el_static: чтобы приблизить функционал десктопа',
    '────────────────────────────',
    '❯ ',
    '────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
  ].join('\n')
  const r = parsePaneThinking(sample)
  const blob = r.lines.join('\n')
  expect(blob).not.toContain('telegram-ss')
  expect(blob).not.toContain('чтобы приблизить')
  expect(blob).not.toContain('el_static')
  expect(r.lines.some(l => l.includes('Реальная мысль'))).toBe(true)
})

test('garbage / empty input is safe', () => {
  expect(parsePaneThinking('')).toEqual({ statusWord: '', lines: [] })
  expect(parsePaneThinking('\n\n   \n')).toEqual({ statusWord: '', lines: [] })
})

test('parsePaneError: auth 401 line is detected and cleaned', () => {
  const sample = [
    '  Some earlier narration.',
    '',
    '● Please run /login · API Error: 401 Invalid authentication credentials',
    '✻ Churned for 2s',
    '────────────────────────────',
    '❯ ',
    '────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
  const err = parsePaneError(sample)
  expect(err).toBe('Please run /login · API Error: 401 Invalid authentication credentials')
})

test('parsePaneError: rate-limit / credit errors detected', () => {
  expect(parsePaneError('● API Error: 429 rate_limit_error')).toMatch(/429|rate/i)
  expect(parsePaneError('● Credit balance is too low')).toMatch(/Credit balance/i)
})

test('parsePaneError: normal prose and our own echo are NOT errors', () => {
  expect(parsePaneError('  I fixed the error in the parser and moved on.')).toBeNull()
  expect(parsePaneError('  ← telegram-ss · el_static: got a 401 earlier?')).toBeNull()
  expect(parsePaneError('')).toBeNull()
  // An error line that lives below the input border (footer/help) is ignored.
  const belowBorder = [
    '  Real narration up here.',
    '────────────────────────────',
    '❯ API Error: do not match what the user is typing',
    '────────────────────────────',
  ].join('\n')
  expect(parsePaneError(belowBorder)).toBeNull()
})

import { parseDialog, parseSessionPicker } from './pane'

test('parseDialog: real /model picker → title + numbered options', () => {
  const d = parseDialog(fixture('pane-model-picker.txt'))
  expect(d).not.toBeNull()
  expect(d!.question).toBe('Select model')
  expect(d!.options.map(o => o.idx)).toEqual([1, 2, 3])
  expect(d!.options[0].label.startsWith('1. Default')).toBe(true)
  expect(d!.options[1].label).toContain('Sonnet')
  expect(d!.options[2].label).toContain('Haiku')
  // Column padding collapsed — no runs of 2+ spaces in labels.
  for (const o of d!.options) expect(o.label).not.toMatch(/\s{2,}/)
})

test('parseDialog: no picker on screen → null', () => {
  expect(parseDialog(fixture('pane-no-dialog.txt'))).toBeNull()
})

test('parseDialog: ignores stray numbered prose (not sequential 1..n)', () => {
  const prose = [
    '  I considered three options here.',
    '  3. but only mentioned this one inline',
    '────────────────────',
    '❯ ',
  ].join('\n')
  expect(parseDialog(prose)).toBeNull()
})

test('parseDialog: synthetic two-option confirm picker', () => {
  const dlg = [
    '  Resume a conversation',
    '',
    '  ❯ 1. Fix the launcher bug',
    '    2. Add the native menu',
    '',
    '  Enter to select · Esc to cancel',
  ].join('\n')
  const d = parseDialog(dlg)
  expect(d!.question).toBe('Resume a conversation')
  expect(d!.options).toEqual([
    { idx: 1, label: '1. Fix the launcher bug' },
    { idx: 2, label: '2. Add the native menu' },
  ])
})

test('parseDialog: chained "switch model" cache-confirm (real wording)', () => {
  // After picking a different model family, Claude opens this confirm. The
  // bridge must mirror it as buttons (it was previously auto-dismissed).
  const confirm = [
    '  ⎿  Set model to Sonnet 4.6 and saved as your default for new sessions',
    '',
    '  This conversation is cached for the current model. Switching to Haiku 4.5',
    '  will start a fresh cache.',
    '',
    '  ❯ 1. Yes, switch to Haiku 4.5',
    '    2. No, go back',
  ].join('\n')
  const d = parseDialog(confirm)
  expect(d).not.toBeNull()
  expect(d!.options.map(o => o.idx)).toEqual([1, 2])
  expect(d!.options[0].label).toContain('Yes, switch')
  expect(d!.options[1].label).toContain('No, go back')
})

// ── /resume session picker (non-numbered, arrow-navigated) ───────────────────

test('parseSessionPicker: real /resume picker → entries + cursor', () => {
  const p = parseSessionPicker(fixture('pane-resume-picker.txt'))
  expect(p).not.toBeNull()
  expect(p!.question).toBe('Resume session')
  // Four sessions visible in the captured screenful.
  expect(p!.options.length).toBe(4)
  expect(p!.options.map(o => o.idx)).toEqual([0, 1, 2, 3])
  // Cursor (❯) is on the first/most-recent entry.
  expect(p!.cursor).toBe(0)
  // Summary labels: cursor + scroll-arrow glyphs stripped, text preserved.
  expect(p!.options[0].label).toBe('(session)')
  expect(p!.options[1].label).toBe('WARM-1780927725 ✓')
  expect(p!.options[2].label).toBe('typing started')
  // The 4th entry's summary is prefixed with a ↓ scroll arrow in the TUI — it
  // must be stripped, not kept as part of the label.
  expect(p!.options[3].label.startsWith('↓')).toBe(false)
  expect(p!.options[3].label).toContain('script ran successfully')
})

test('parseSessionPicker: parseDialog does NOT match the resume picker', () => {
  // The two pickers are disjoint: /resume has no numbered options, so the
  // numbered-picker parser must return null (the bridge falls through to
  // parseSessionPicker).
  expect(parseDialog(fixture('pane-resume-picker.txt'))).toBeNull()
})

test('parseSessionPicker: no resume header → null (no false positives)', () => {
  // Prose that happens to contain "… ago ·" but no picker header.
  const prose = [
    '  I shipped that change 3 days ago · the build is green now.',
    '────────────────────',
    '❯ ',
  ].join('\n')
  expect(parseSessionPicker(prose)).toBeNull()
})

// ── parseStuckInput ────────────────────────────────────────────────────────

test('stuck input: idle pane with text in the prompt → returns the buffered text', () => {
  // pane-idle.txt is an idle footer ("← for agents") with an unsubmitted prompt
  // sitting in the input box — exactly the wedge the watchdog recovers.
  const r = parseStuckInput(fixture('pane-idle.txt'))
  expect(r).toBe('Загляни в launcher.ts, есть ли там задел под HTTP')
})

test('stuck input: busy pane ("esc to interrupt") → null (turn still running)', () => {
  expect(parseStuckInput(fixture('pane-working.txt'))).toBeNull()
})

test('stuck input: idle pane with an empty prompt → null (nothing queued)', () => {
  expect(parseStuckInput(fixture('pane-idle-empty.txt'))).toBeNull()
})

test('stuck input: a model picker owns the prompt → null', () => {
  expect(parseStuckInput(fixture('pane-model-picker.txt'))).toBeNull()
})

test('stuck input: a resume picker owns the prompt → null', () => {
  expect(parseStuckInput(fixture('pane-resume-picker.txt'))).toBeNull()
})

test('stuck input: earlier "❯ /cmd" echoes are ignored; only the live box counts', () => {
  // pane-no-dialog.txt has past "❯ /model" echoes above, empty live input box.
  expect(parseStuckInput(fixture('pane-no-dialog.txt'))).toBeNull()
})

test('parsePaneError: disabled/retired model (404 model_not_found) is detected', () => {
  const tui = [
    '  Earlier narration.',
    "● There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it. Run /model to pick a different model.",
    '✻ Churned for 1s',
    '────────────────────────────',
    '❯ ',
    '────────────────────────────',
  ].join('\n')
  expect(parsePaneError(tui)).toMatch(/issue with the selected model/i)
  expect(parsePaneError('● API Error: 404 model_not_found')).toMatch(/model_not_found|404/i)
})

test('parsePaneError: assistant PROSE about errors is NOT relayed as an outage', () => {
  // Regression: a dev topic discussing the error detector itself used to trip
  // it. These phrases appear mid-sentence (not as a CC banner) → must be null.
  expect(parsePaneError('● Детектор ловил строку с Internal server error в логе.')).toBeNull()
  expect(parsePaneError('● Баг: при model_not_found фоллбэк-цепочка не срабатывает.')).toBeNull()
  expect(parsePaneError('● The selected model issue only fires on a real 404.')).toBeNull()
  expect(parsePaneError('● I hit a rate limit and a 429 error while testing quota.')).toBeNull()
  // …but a genuine leading banner in the same topic is still caught.
  expect(parsePaneError('● API Error: 500 Internal server error')).toMatch(/Internal server error/i)
})
