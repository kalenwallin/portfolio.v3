import Keyv from '@keyvhq/core'
import KeyvRedis from '@keyvhq/redis'
import Redis from 'ioredis'

import { isRedisEnabled, redisNamespace, redisUrl } from './config'

const memoryDb = new Keyv()
let db: Keyv = memoryDb
let redis: Redis | undefined

if (isRedisEnabled && redisUrl) {
  redis = new Redis(redisUrl, {
    connectTimeout: 3_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  })
  const keyvRedis = new KeyvRedis(redis)
  db = new Keyv({ store: keyvRedis, namespace: redisNamespace || undefined })
  // Keyv forwards the Redis client's error events. Handle them so a network
  // failure cannot crash the build, and skip Redis for the rest of this process.
  db.on('error', () => {
    console.warn('Redis cache unavailable; using the in-memory cache')
    db = memoryDb
    redis = undefined
  })
} else if (isRedisEnabled) {
  console.warn('Redis cache is not configured; using the in-memory cache')
}

export { db }

export function getRedisClient() {
  return redis
}
