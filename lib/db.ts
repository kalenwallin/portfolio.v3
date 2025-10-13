import { Redis } from '@upstash/redis'

import { isRedisEnabled, upstashRedisToken, upstashRedisURL } from './config'

let db_upstash: Redis
if (isRedisEnabled) {
  const upstashRedis = new Redis({
    url: upstashRedisURL,
    token: upstashRedisToken
  })
  db_upstash = upstashRedis
}

export { db_upstash }
