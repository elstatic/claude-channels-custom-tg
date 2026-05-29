import { test, expect } from 'bun:test'
import { TopicDb } from './db'

function freshDb(): TopicDb {
  return new TopicDb(':memory:')
}

test('append + count per thread', () => {
  const db = freshDb()
  db.append({ thread_id: 1, role: 'user', text: 'hello world', ts: 1000, message_id: null })
  db.append({ thread_id: 1, role: 'assistant', text: 'goodbye moon', ts: 2000, message_id: 5 })
  db.append({ thread_id: 2, role: 'user', text: 'other topic', ts: 3000, message_id: null })
  expect(db.count(1)).toBe(2)
  expect(db.count(2)).toBe(1)
  expect(db.count(99)).toBe(0)
})

test('search matches across topics, newest first', () => {
  const db = freshDb()
  db.append({ thread_id: 1, role: 'user', text: 'hello world', ts: 1000, message_id: null })
  db.append({ thread_id: 2, role: 'user', text: 'hello again', ts: 3000, message_id: null })
  const found = db.search('hello')
  expect(found.length).toBe(2)
  expect(found[0].text).toBe('hello again') // newest first
})

test('search treats %, _ as literals (escaped)', () => {
  const db = freshDb()
  db.append({ thread_id: 1, role: 'user', text: '100% sure', ts: 1000, message_id: null })
  db.append({ thread_id: 1, role: 'user', text: 'fifty percent', ts: 2000, message_id: null })
  expect(db.search('100%').length).toBe(1)        // literal %, not wildcard
  expect(db.search('nomatch').length).toBe(0)
})

test('recent returns oldest→newest within a thread', () => {
  const db = freshDb()
  db.append({ thread_id: 1, role: 'user', text: 'first', ts: 1000, message_id: null })
  db.append({ thread_id: 1, role: 'user', text: 'second', ts: 2000, message_id: null })
  const rec = db.recent(1, 10)
  expect(rec[0].text).toBe('first')
  expect(rec[rec.length - 1].text).toBe('second')
})
