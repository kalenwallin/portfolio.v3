import './setup'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import Redis from 'ioredis'

import { ContentCache, SharedCache } from '../lib/cache'
import { WebhookCoordinator } from '../lib/webhook-coordinator'

const redisUrl = process.env.TEST_REDIS_URL
const redis = redisUrl
  ? new Redis(redisUrl, { maxRetriesPerRequest: 0 })
  : undefined
after(() => redis?.quit())

for (const mode of ['memory', ...(redis ? ['redis'] : [])]) {
  const makeStore = () =>
    new SharedCache(`test:${randomUUID()}`, () =>
      mode === 'redis' ? redis : undefined
    )

  describe(`${mode} cache`, () => {
    test('shares repeated queries and separates all search parameters', async () => {
      const cache = new ContentCache(makeStore())
      let loads = 0
      const load = async () => ++loads
      const query = { query: 'Blue Cross', ancestorId: 'root', limit: 10 }
      assert.equal(await cache.get('search', query, 1000, load), 1)
      assert.equal(
        await cache.get(
          'search',
          { limit: 10, ancestorId: 'root', query: 'Blue Cross' },
          1000,
          load
        ),
        1
      )
      for (const change of [
        { limit: 20 },
        { ancestorId: 'other' },
        { filters: { isNavigableOnly: false } },
        { searchSessionId: 'other-session' }
      ]) {
        await cache.get('search', { ...query, ...change }, 1000, load)
      }
      assert.equal(loads, 5)
    })

    test('expires results and deduplicates concurrent cache misses', async () => {
      const cache = new ContentCache(makeStore())
      let loads = 0
      const load = async () => {
        loads++
        await delay(10)
        return loads
      }
      assert.deepEqual(
        await Promise.all(
          Array.from({ length: 5 }, () => cache.get('search', {}, 10, load))
        ),
        [1, 1, 1, 1, 1]
      )
      await delay(20)
      assert.equal(await cache.get('search', {}, 10, load), 2)
    })

    test('a pre-update request cannot repopulate the new generation', async () => {
      const cache = new ContentCache(makeStore())
      let finish!: (value: string) => void
      let started!: () => void
      const loading = new Promise<void>((resolve) => {
        started = resolve
      })
      const old = cache.get('metadata', {}, 1000, () => {
        started()
        return new Promise<string>((resolve) => {
          finish = resolve
        })
      })
      await loading
      await cache.invalidate()
      assert.equal(
        await cache.get('metadata', {}, 1000, async () => 'fresh'),
        'fresh'
      )
      finish('obsolete')
      await old
      assert.equal(
        await cache.get('metadata', {}, 1000, async () => 'wrong'),
        'fresh'
      )
    })

    test('failed loaders remain retryable', async () => {
      const cache = new ContentCache(makeStore())
      await assert.rejects(
        cache.get('search', {}, 1000, async () => {
          throw new Error('Notion unavailable')
        })
      )
      assert.equal(
        await cache.get('search', {}, 1000, async () => 'recovered'),
        'recovered'
      )
    })

    test('only successful events become duplicates; unfinished events retry', async () => {
      const coordinator = new WebhookCoordinator(makeStore())
      const first = await coordinator.claimEvent('event')
      assert.equal(first.status, 'claimed')
      assert.equal((await coordinator.claimEvent('event')).status, 'busy')
      if (first.status !== 'claimed') throw new Error('Expected claim')
      await first.release()
      const retry = await coordinator.claimEvent('event')
      if (retry.status !== 'claimed') throw new Error('Expected retry')
      await retry.complete()
      await retry.release()
      assert.equal((await coordinator.claimEvent('event')).status, 'completed')
    })

    test('expired lock owners cannot release successor locks', async () => {
      const store = makeStore()
      const releaseOld = await store.lock('lock', 5)
      assert.ok(releaseOld)
      await delay(15)
      const releaseNew = await store.lock('lock', 1000)
      assert.ok(releaseNew)
      await releaseOld()
      assert.equal(await store.lock('lock', 1000), undefined)
      await releaseNew()
      assert.ok(await store.lock('lock', 10))
    })

    test('batches concurrent edit events into one rebuild', async () => {
      const coordinator = new WebhookCoordinator(makeStore(), 25, 5, 1000)
      let builds = 0
      const build = async () => {
        builds++
      }
      await Promise.all(
        Array.from({ length: 5 }, () => coordinator.rebuild(build))
      )
      assert.equal(builds, 1)
    })

    test('an edit after the build snapshot requires another rebuild', async () => {
      const coordinator = new WebhookCoordinator(makeStore(), 5, 5, 1000)
      let builds = 0
      let started!: () => void
      let finish!: () => void
      const building = new Promise<void>((resolve) => {
        started = resolve
      })
      const build = async () => {
        builds++
        if (builds === 1) {
          started()
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        }
      }
      const first = coordinator.rebuild(build)
      await building
      const second = coordinator.rebuild(build)
      await delay(10)
      finish()
      await Promise.all([first, second])
      assert.equal(builds, 2)
    })

    test('a failed rebuild does not cover pending edits', async () => {
      const coordinator = new WebhookCoordinator(makeStore(), 1, 5, 1000)
      await assert.rejects(
        coordinator.rebuild(async () => {
          throw new Error('Vercel unavailable')
        })
      )
      let builds = 0
      await coordinator.rebuild(async () => {
        builds++
      })
      assert.equal(builds, 1)
    })
  })
}

test('bounded local data eviction preserves invalidation and active locks', async () => {
  const store = new SharedCache('bounded')
  const cache = new ContentCache(store)
  await cache.invalidate()
  const version = await cache.version()
  const release = await store.lock('active', 1000)
  for (let i = 0; i < 300; i++) await store.set(`entry:${i}`, i, 1000)
  assert.equal(await store.get('entry:0'), undefined)
  assert.equal(await cache.version(), version)
  assert.equal(await store.lock('active', 1000), undefined)
  await release?.()
})

// Bun's node:test adapter does not honor the per-test skip option consistently.
if (redisUrl) {
  test('Redis payloads and invalidation are reused by another process', async () => {
    const prefix = `test:${randomUUID()}`
    const store = new SharedCache(prefix, () => redis)
    const cache = new ContentCache(store)
    await cache.invalidate()
    await cache.get('metadata', {}, 1000, async () => ({ title: 'shared' }))
    const child = spawnSync(
      process.execPath,
      [
        '--eval',
        `
    import Redis from 'ioredis';
    import { SharedCache, ContentCache } from './lib/cache.ts';
    const redis = new Redis(process.env.TEST_REDIS_URL);
    const cache = new ContentCache(new SharedCache(${JSON.stringify(prefix)}, () => redis));
    console.log(JSON.stringify(await cache.get('metadata', {}, 1000, async () => { throw new Error('Cache miss'); })));
    await cache.invalidate();
    await redis.quit();
  `
      ],
      { encoding: 'utf8', env: { ...process.env, REDIS_ENABLED: 'false' } }
    )
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /"title":"shared"/)
    assert.equal(
      await cache.get('metadata', {}, 1000, async () => 'new generation'),
      'new generation'
    )
  })
}
