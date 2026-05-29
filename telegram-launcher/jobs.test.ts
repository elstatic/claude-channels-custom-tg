import { test, expect } from 'bun:test'
import { parseCron, nextFireFrom } from './jobs'

test('parseCron accepts a valid expression', () => {
  expect(() => parseCron('0 9 * * MON')).not.toThrow()
})

test('parseCron throws on garbage', () => {
  expect(() => parseCron('not a cron at all')).toThrow()
})

test('nextFireFrom returns a strictly future timestamp', () => {
  const anchor = new Date('2026-05-29T00:00:00Z')
  const next = nextFireFrom('0 9 * * *', anchor)
  expect(next).toBeGreaterThan(anchor.getTime())
})

test('nextFireFrom for a one-shot-style daily lands at 09:00', () => {
  const anchor = new Date('2026-05-29T00:00:00Z')
  const next = new Date(nextFireFrom('0 9 * * *', anchor))
  expect(next.getUTCHours()).toBe(9)
  expect(next.getUTCMinutes()).toBe(0)
})
