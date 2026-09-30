import Keyv from '@keyvhq/core'
import KeyvRedis from '@keyvhq/redis'

import { isRedisEnabled, redisNamespace, redisUrl } from './config'

const memoryDb = new Keyv()
let db: Keyv = memoryDb

if (isRedisEnabled && redisUrl) {
  const keyvRedis = new KeyvRedis(redisUrl, {
    connectTimeout: 3_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  })
  db = new Keyv({ store: keyvRedis, namespace: redisNamespace || undefined })
  // Keyv forwards the Redis client's error events. Handle them so a network
  // failure cannot crash the build, and skip Redis for the rest of this process.
  db.on('error', () => {
    console.warn('Redis cache unavailable; using the in-memory cache')
    db = memoryDb
  })
} else if (isRedisEnabled) {
  console.warn('Redis cache is not configured; using the in-memory cache')
}

export { db }
