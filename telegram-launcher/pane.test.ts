import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePaneThinking } from './pane'

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

test('garbage / empty input is safe', () => {
  expect(parsePaneThinking('')).toEqual({ statusWord: '', lines: [] })
  expect(parsePaneThinking('\n\n   \n')).toEqual({ statusWord: '', lines: [] })
})
