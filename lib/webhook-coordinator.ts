import { setTimeout as delay } from 'node:timers/promises'

import { hashCacheKey, sharedCache, type SharedCache } from './cache'

const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

type EventClaim =
  | { status: 'completed' }
  | { status: 'busy' }
  | {
      status: 'claimed'
      complete: () => Promise<void>
      release: () => Promise<void>
    }

export class WebhookCoordinator {
  constructor(
    private readonly store: SharedCache,
    private readonly batchMs = 3000,
    private readonly pollMs = 500,
    private readonly rebuildTimeoutMs = 50_000
  ) {}

  async claimEvent(eventId: string | undefined): Promise<EventClaim> {
    if (typeof eventId !== 'string' || !eventId) {
      return {
        status: 'claimed',
        complete: async () => {},
        release: async () => {}
      }
    }

    const key = `event:${hashCacheKey(eventId)}`
    if (await this.store.get<boolean>(`${key}:done`)) {
      return { status: 'completed' }
    }
    const release = await this.store.lock(`${key}:lock`, 180_000)
    if (!release) return { status: 'busy' }
    // A previous worker may have completed between our read and lock attempt.
    if (await this.store.get<boolean>(`${key}:done`)) {
      await release()
      return { status: 'completed' }
    }
    return {
      status: 'claimed',
      complete: () => this.store.set(`${key}:done`, true, EVENT_TTL_MS),
      release
    }
  }

  async rebuild(build: () => Promise<void>) {
    const backend = this.store.backend
    const sequence = await this.store.increment('rebuild-requested')
    const deadline = Date.now() + this.rebuildTimeoutMs

    while (Date.now() < deadline) {
      const completed = (await this.store.get<number>('rebuild-completed')) ?? 0
      // If Redis fails mid-flight, sequences from it cannot be compared with
      // local counters. Prefer a redundant build to silently losing an edit.
      if (backend !== this.store.backend) return build()
      if (completed >= sequence) return

      const release = await this.store.lock('rebuild-lock', 60_000)
      if (release) {
        try {
          const covered =
            (await this.store.get<number>('rebuild-completed')) ?? 0
          if (backend !== this.store.backend) return await build()
          if (covered >= sequence) return

          // Collect requests that arrived before this build starts. Requests
          // arriving after the snapshot must schedule a subsequent build.
          await delay(this.batchMs)
          const requested =
            (await this.store.get<number>('rebuild-requested')) ?? sequence
          await build()
          if (backend === this.store.backend) {
            await this.store.set('rebuild-completed', requested)
          }
          return
        } finally {
          await release()
        }
      }
      await delay(this.pollMs)
    }
    throw new Error('Timed out waiting for the pending Notion rebuild')
  }
}

export const webhookCoordinator = new WebhookCoordinator(sharedCache)
