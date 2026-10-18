import { createHash, randomUUID } from 'node:crypto'

import type Redis from 'ioredis'

import { domain, rootNotionPageId, rootNotionSpaceId } from './config'
import { getRedisClient } from './db'

const MAX_ENTRY_BYTES = 1024 * 1024
const MAX_MEMORY_BYTES = 8 * MAX_ENTRY_BYTES
const MAX_MEMORY_ENTRIES = 250
const RELEASE_LOCK = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`

type MemoryEntry = { value: string; expiresAt: number }

// A small local fallback keeps the app working when Redis is disabled or down.
// Redis is the authority while available; local state never shadows it.
export class SharedCache {
  private readonly memory = new Map<string, MemoryEntry>()
  private readonly permanent = new Map<string, string>()
  private readonly locks = new Map<string, MemoryEntry>()
  private memoryBytes = 0
  private redisFailed = false

  constructor(
    private readonly prefix: string,
    private readonly redis: () => Redis | undefined = () => undefined
  ) {}

  get backend() {
    return this.redisFailed ? undefined : this.redis()
  }

  private readMemory(key: string) {
    if (this.permanent.has(key)) return this.permanent.get(key)
    const entry = this.memory.get(key)
    if (entry && entry.expiresAt > Date.now()) return entry.value
    this.deleteMemory(key)
    return undefined
  }

  private deleteMemory(key: string) {
    const entry = this.memory.get(key)
    if (entry) this.memoryBytes -= Buffer.byteLength(entry.value)
    this.memory.delete(key)
  }

  private writeMemory(key: string, value: string, ttlMs?: number) {
    if (ttlMs === undefined) {
      this.permanent.set(key, value)
      return
    }
    this.deleteMemory(key)
    this.memory.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    })
    this.memoryBytes += Buffer.byteLength(value)
    while (
      this.memory.size > MAX_MEMORY_ENTRIES ||
      this.memoryBytes > MAX_MEMORY_BYTES
    ) {
      this.deleteMemory(this.memory.keys().next().value!)
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const redis = this.backend
    if (redis) {
      try {
        const value = await redis.get(`${this.prefix}:${key}`)
        return value === null ? undefined : (JSON.parse(value) as T)
      } catch {
        this.redisFailed = true
        console.warn('Shared Redis cache read failed; using local cache')
      }
    }
    const value = this.readMemory(key)
    return value === undefined ? undefined : (JSON.parse(value) as T)
  }

  async set(key: string, value: unknown, ttlMs?: number) {
    const serialized = JSON.stringify(value)
    if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) return
    const redis = this.backend
    if (redis) {
      try {
        if (ttlMs === undefined) {
          await redis.set(`${this.prefix}:${key}`, serialized)
        } else {
          await redis.set(`${this.prefix}:${key}`, serialized, 'PX', ttlMs)
        }
        return
      } catch {
        this.redisFailed = true
        console.warn('Shared Redis cache write failed; using local cache')
      }
    }
    this.writeMemory(key, serialized, ttlMs)
  }

  async increment(key: string): Promise<number> {
    const redis = this.backend
    if (redis) {
      try {
        return await redis.incr(`${this.prefix}:${key}`)
      } catch {
        this.redisFailed = true
        console.warn('Redis coordination unavailable; using local state')
      }
    }
    const next = Number(this.readMemory(key) ?? 0) + 1
    this.writeMemory(key, String(next))
    return next
  }

  async lock(key: string, ttlMs: number) {
    const token = JSON.stringify(randomUUID())
    const redis = this.backend
    if (redis) {
      try {
        const claimed = await redis.set(
          `${this.prefix}:${key}`,
          token,
          'PX',
          ttlMs,
          'NX'
        )
        if (!claimed) return undefined
        return async () => {
          // An expired owner must never delete its successor's lock.
          try {
            await redis.eval(RELEASE_LOCK, 1, `${this.prefix}:${key}`, token)
          } catch {
            // The lease expires even if Redis becomes unavailable.
          }
        }
      } catch {
        this.redisFailed = true
        console.warn('Redis coordination unavailable; using local state')
      }
    }
    for (const [lockKey, lease] of this.locks) {
      if (lease.expiresAt <= Date.now()) this.locks.delete(lockKey)
    }
    if (this.locks.has(key)) return undefined
    this.locks.set(key, { value: token, expiresAt: Date.now() + ttlMs })
    return async () => {
      if (this.locks.get(key)?.value === token) this.locks.delete(key)
    }
  }
}

export function hashCacheKey(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export class ContentCache {
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(private readonly store: SharedCache) {}

  async version() {
    return (await this.store.get<string>('content-version')) ?? 'initial'
  }

  async invalidate() {
    // Old keys expire naturally. A request already in flight can only populate
    // its old generation, never overwrite the result of a newer Notion event.
    await this.store.set('content-version', randomUUID())
  }

  async get<T>(
    kind: string,
    params: unknown,
    ttlMs: number,
    load: () => Promise<T>
  ): Promise<T> {
    const version = await this.version()
    const key = `content:${kind}:${version}:${hashCacheKey(params)}`
    const cached = await this.store.get<T>(key)
    if (cached !== undefined) return cached
    const pending = this.pending.get(key)
    if (pending) return pending as Promise<T>

    const result = (async () => {
      const value = await load()
      await this.store.set(key, value, ttlMs)
      return value
    })()
    this.pending.set(key, result)
    try {
      return await result
    } finally {
      this.pending.delete(key)
    }
  }
}

const scope = hashCacheKey({
  domain,
  rootNotionPageId,
  rootNotionSpaceId,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development'
})

export const sharedCache = new SharedCache(
  `portfolio:v1:${scope}`,
  getRedisClient
)
export const contentCache = new ContentCache(sharedCache)
