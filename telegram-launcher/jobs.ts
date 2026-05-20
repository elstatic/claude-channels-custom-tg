// Persistent store of cron jobs. Each job belongs to a (chatId, threadId)
// — when the topic is deleted between fires, the dispatcher recreates it
// and updates the record to point at the new threadId. Schema is JSON,
// atomic rename on write (same pattern as SessionRegistry).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { Cron } from 'croner'
import { dirname } from 'path'

export type ScheduledJob = {
  id: string
  chatId: number
  threadId: number       // current topic id (auto-updated on recreate)
  topicName: string      // remembered so we can recreate with the same title
  cron: string           // cron expression, e.g. "0 9 * * MON"
  prompt: string         // injected as channel notification content
  description?: string   // human-readable
  createdAt: number
  lastFireAt?: number
  nextFireAt: number     // pre-computed, persisted to survive restart
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function newJobId(): string {
  let out = ''
  for (let i = 0; i < 6; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

export function parseCron(expr: string): Cron {
  // Throws if invalid — caller surfaces to user.
  return new Cron(expr, { paused: true })
}

export function nextFireFrom(expr: string, anchor: Date = new Date()): number {
  const c = parseCron(expr)
  const next = c.nextRun(anchor)
  if (!next) throw new Error(`cron expression "${expr}" yields no future runs`)
  return next.getTime()
}

export class JobStore {
  private byId = new Map<string, ScheduledJob>()
  constructor(private file: string) {}

  load(): void {
    try {
      const arr = JSON.parse(readFileSync(this.file, 'utf8')) as ScheduledJob[]
      this.byId.clear()
      for (const j of arr) this.byId.set(j.id, j)
    } catch {
      this.byId.clear()
    }
  }

  save(): void {
    try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }) } catch {}
    const arr = Array.from(this.byId.values())
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tmp, JSON.stringify(arr, null, 2))
    renameSync(tmp, this.file)
  }

  all(): ScheduledJob[] {
    return Array.from(this.byId.values())
  }

  inThread(threadId: number): ScheduledJob[] {
    return this.all().filter(j => j.threadId === threadId)
  }

  get(id: string): ScheduledJob | undefined {
    return this.byId.get(id)
  }

  add(input: Omit<ScheduledJob, 'id' | 'createdAt' | 'nextFireAt'> & { nextFireAt?: number }): ScheduledJob {
    let id: string
    do { id = newJobId() } while (this.byId.has(id))
    const job: ScheduledJob = {
      id,
      createdAt: Date.now(),
      nextFireAt: input.nextFireAt ?? nextFireFrom(input.cron),
      ...input,
    }
    this.byId.set(id, job)
    this.save()
    return job
  }

  update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | undefined {
    const job = this.byId.get(id)
    if (!job) return undefined
    Object.assign(job, patch)
    this.save()
    return job
  }

  remove(id: string): boolean {
    const had = this.byId.delete(id)
    if (had) this.save()
    return had
  }
}
