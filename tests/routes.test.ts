import './setup'

import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import type { NextApiRequest, NextApiResponse } from 'next'
import type { ExtendedRecordMap } from 'notion-types'
import { idToUuid } from 'notion-utils'

import { contentCache } from '../lib/cache'
import { rootNotionPageId } from '../lib/config'
import { getSiteMetadata } from '../lib/get-site-map'
import { notion } from '../lib/notion-api'
import webhook from '../pages/api/notion-webhook'
import search from '../pages/api/search-notion'
import { getServerSideProps as feed } from '../pages/feed'
import { getServerSideProps as sitemap } from '../pages/sitemap.xml'

class Response {
  statusCode = 200
  body: any
  text = ''
  headers = new Map<string, string>()
  revalidate = async (_path: string) => {}
  setHeader(key: string, value: string) {
    this.headers.set(key, value)
  }
  status(code: number) {
    this.statusCode = code
    return this
  }
  json(value: unknown) {
    this.body = value
    return this
  }
  send(value: unknown) {
    this.body = value
    return this
  }
  write(value: string) {
    this.text += value
  }
  end() {}
  get api() {
    return this as unknown as NextApiResponse
  }
}

test('search route reuses results, separates filters, and validates requests', async () => {
  const original = notion.search
  let calls = 0
  notion.search = async () => {
    calls++
    return {
      total: 0,
      results: [],
      recordMap: {
        block: {},
        collection: {},
        collection_view: {},
        notion_user: {}
      }
    }
  }
  try {
    await contentCache.invalidate()
    const params = { ancestorId: rootNotionPageId, query: randomUUID() }
    for (const body of [params, params, { ...params, limit: 5 }]) {
      const response = new Response()
      await search({ method: 'POST', body } as NextApiRequest, response.api)
      assert.equal(response.statusCode, 200)
      assert.equal(response.body.total, 0)
    }
    assert.equal(calls, 2)
    await contentCache.invalidate()
    await search(
      { method: 'POST', body: params } as NextApiRequest,
      new Response().api
    )
    assert.equal(calls, 3)
    const invalid = new Response()
    await search({ method: 'POST', body: null } as NextApiRequest, invalid.api)
    assert.equal(invalid.statusCode, 400)
    assert.equal(calls, 3)
  } finally {
    notion.search = original
  }
})

test('feed and sitemap share compact metadata and refresh a warm process after invalidation', async () => {
  const original = notion.getPage
  const rootId = idToUuid(rootNotionPageId)
  const pageId = '10000000-0000-4000-8000-000000000001'
  const privateId = '10000000-0000-4000-8000-000000000002'
  const collectionId = '10000000-0000-4000-8000-000000000003'
  let title = 'First title'
  let calls = 0
  notion.getPage = async (requestedId) => {
    calls++
    const root = { id: rootId, type: 'page', properties: { title: [['Home']] } }
    const post = (id: string, isPublic: boolean) => ({
      id,
      type: 'page',
      parent_table: 'collection',
      parent_id: collectionId,
      last_edited_time: 1700000000000,
      properties: {
        title: [[title]],
        public: [[isPublic ? 'Yes' : 'No']],
        description: [['Post description']]
      }
    })
    const blocks = {
      [rootId]: { value: root },
      [pageId]: { value: post(pageId, true) },
      [privateId]: { value: post(privateId, false) }
    }
    return {
      block: { [requestedId]: blocks[requestedId]!, ...blocks },
      collection: {
        [collectionId]: {
          value: {
            id: collectionId,
            parent_id: rootId,
            parent_table: 'block',
            schema: {
              title: { name: 'Name', type: 'title' },
              public: { name: 'Public', type: 'checkbox' },
              description: { name: 'Description', type: 'text' },
              updated: { name: 'Last Updated', type: 'last_edited_time' }
            }
          }
        }
      },
      collection_query: {},
      collection_view: {},
      notion_user: {},
      signed_urls: {}
    } as unknown as ExtendedRecordMap
  }
  try {
    await contentCache.invalidate()
    const metadata = await getSiteMetadata()
    assert.equal(metadata.blogPosts.length, 1)
    assert.equal(metadata.blogPosts[0]?.title, title)
    assert.equal(metadata.blogPosts[0]?.lastUpdatedTime, 1700000000000)
    assert.ok(!JSON.stringify(metadata).includes('collection_query'))
    const firstCalls = calls
    const rss = new Response()
    const xml = new Response()
    await feed({ req: { method: 'GET' }, res: rss } as any)
    await sitemap({ req: { method: 'GET' }, res: xml } as any)
    assert.equal(calls, firstCalls)
    assert.match(rss.text, /First title/)
    assert.match(rss.text, /Post description/)
    assert.match(xml.text, /first-title/)
    assert.ok(!xml.text.includes(privateId.replaceAll('-', '')))
    title = 'Updated title'
    await contentCache.invalidate()
    const updated = new Response()
    await feed({ req: { method: 'GET' }, res: updated } as any)
    assert.match(updated.text, /Updated title/)
    assert.ok(calls > firstCalls)
  } finally {
    notion.getPage = original
    await contentCache.invalidate()
  }
})

test('signed webhook acknowledges promptly, retries unfinished work, and skips completed deliveries', async () => {
  const originalGetPage = notion.getPage
  const originalToken = process.env.NOTION_VERIFICATION_TOKEN
  const originalHook = process.env.VERCEL_DEPLOY_HOOK_URL
  const symbol = Symbol.for('@vercel/request-context')
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, symbol)
  const tasks: Promise<unknown>[] = []
  Object.defineProperty(globalThis, symbol, {
    configurable: true,
    value: {
      get: () => ({ waitUntil: (task: Promise<unknown>) => tasks.push(task) })
    }
  })
  process.env.NOTION_VERIFICATION_TOKEN = 'test-token'
  process.env.VERCEL_DEPLOY_HOOK_URL = 'https://example.invalid/never-called'
  const pageId = '10000000-0000-4000-8000-000000000004'
  notion.getPage = async () =>
    ({
      block: {
        [pageId]: {
          value: {
            id: pageId,
            type: 'page',
            properties: { title: [['Webhook test']] }
          }
        }
      },
      collection: {}
    }) as unknown as ExtendedRecordMap
  const payload = {
    id: randomUUID(),
    type: 'page.content_updated',
    entity: { type: 'page', id: pageId }
  }
  const request = () => {
    const raw = JSON.stringify(payload)
    return Object.assign(Readable.from([Buffer.from(raw)]), {
      method: 'POST',
      headers: {
        'x-notion-signature': `sha256=${createHmac('sha256', 'test-token').update(raw).digest('hex')}`
      }
    }) as unknown as NextApiRequest
  }
  let finish!: () => void
  let started!: () => void
  const revalidating = new Promise<void>((resolve) => {
    started = resolve
  })
  let revalidations = 0
  try {
    const response = new Response()
    response.revalidate = async () => {
      revalidations++
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    await webhook(request(), response.api)
    assert.equal(response.statusCode, 200)
    const duplicate = new Response()
    await webhook(request(), duplicate.api)
    assert.equal(duplicate.statusCode, 503)
    await revalidating
    finish()
    await Promise.all(tasks)
    const completed = new Response()
    await webhook(request(), completed.api)
    assert.equal(completed.statusCode, 200)
    assert.equal(revalidations, 1)
  } finally {
    notion.getPage = originalGetPage
    if (originalToken === undefined)
      delete process.env.NOTION_VERIFICATION_TOKEN
    else process.env.NOTION_VERIFICATION_TOKEN = originalToken
    if (originalHook === undefined) delete process.env.VERCEL_DEPLOY_HOOK_URL
    else process.env.VERCEL_DEPLOY_HOOK_URL = originalHook
    if (originalContext)
      Object.defineProperty(globalThis, symbol, originalContext)
    else Reflect.deleteProperty(globalThis, symbol)
  }
})
