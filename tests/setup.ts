import { randomUUID } from 'node:crypto'

// Test processes must never read/write the app's production cache or deploy hook.
process.env.REDIS_ENABLED = process.env.TEST_REDIS_URL ? 'true' : 'false'
if (process.env.TEST_REDIS_URL) {
  process.env.REDIS_URL = process.env.TEST_REDIS_URL
}
process.env.VERCEL_ENV = `test-${randomUUID()}`
process.env.NOTION_VERIFICATION_TOKEN = 'test-token'
process.env.VERCEL_DEPLOY_HOOK_URL = 'https://example.invalid/never-called'
