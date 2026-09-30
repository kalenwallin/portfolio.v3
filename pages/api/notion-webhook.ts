import { createHmac, timingSafeEqual } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { waitUntil } from '@vercel/functions'

import type { NextApiRequest, NextApiResponse } from 'next'

import { site } from '@/lib/config'
import { mapPageUrl } from '@/lib/map-page-url'
import { notion } from '@/lib/notion-api'

// Notion signs the exact bytes it sends, so we need the raw request body
export const config = {
  // Room for a page revalidation that times out plus the rebuild fallback
  maxDuration: 120,
  api: {
    bodyParser: false
  }
}

type NotionWebhookEvent = {
  verification_token?: string
  type?: string
  id?: string
  attempt_number?: number
  entity?: { id?: string; type?: string }
}

const REVALIDATE_TIMEOUT_MS = 45_000
const TIMED_OUT = Symbol('timed out')

/**
 * Receives Notion webhook events and refreshes the statically generated site:
 * content edits to an existing page revalidate just that page, and everything
 * else triggers a full Vercel rebuild.
 *
 * @see https://developers.notion.com/reference/webhooks
 */
export default async function notionWebhook(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).send({ error: 'method not allowed' })
  }

  const rawBody = await readRawBody(req)

  let payload: NotionWebhookEvent
  try {
    payload = JSON.parse(rawBody)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).send({ error: 'invalid webhook payload' })
    }
  } catch {
    return res.status(400).send({ error: 'invalid JSON body' })
  }

  // One-time handshake when the webhook subscription is created: paste this
  // token into Notion's webhook settings and save it as NOTION_VERIFICATION_TOKEN
  if (
    typeof payload.verification_token === 'string' &&
    payload.verification_token
  ) {
    console.log(
      'Notion webhook verification token:',
      payload.verification_token
    )
    return res.status(200).send({ ok: true })
  }

  const verificationToken = process.env.NOTION_VERIFICATION_TOKEN
  const deployHookUrl = process.env.VERCEL_DEPLOY_HOOK_URL
  if (!verificationToken || !deployHookUrl) {
    console.error(
      'notion-webhook missing NOTION_VERIFICATION_TOKEN or VERCEL_DEPLOY_HOOK_URL'
    )
    return res.status(500).send({ error: 'webhook not configured' })
  }

  const signature = req.headers['x-notion-signature']
  if (
    typeof signature !== 'string' ||
    !isValidSignature(rawBody, signature, verificationToken)
  ) {
    return res.status(401).send({ error: 'invalid signature' })
  }

  // Revalidating or rebuilding takes longer than Notion's delivery timeout. Keep
  // the function alive for background work while acknowledging Notion immediately.
  waitUntil(refreshSite(res, deployHookUrl, payload))
  console.log(
    'notion-webhook accepted event',
    payload.type,
    payload.id,
    'delivery attempt',
    payload.attempt_number
  )
  return res.status(200).send({ ok: true })
}

async function refreshSite(
  res: NextApiResponse,
  deployHookUrl: string,
  payload: NotionWebhookEvent
) {
  // A content edit only changes that page's own route. New, moved, deleted, or
  // retitled pages and database changes can change URLs and listings, so those
  // rebuild. A page that isn't part of the current build (e.g. just created)
  // 404s on revalidation, which also falls back to a rebuild.
  const pageId = payload.entity?.type === 'page' ? payload.entity.id : undefined
  if (
    payload.type === 'page.content_updated' &&
    pageId &&
    (await revalidatePage(res, pageId, payload.id))
  ) {
    return
  }

  await triggerRebuild(deployHookUrl, payload.type, payload.id)
}

async function revalidatePage(
  res: NextApiResponse,
  pageId: string,
  eventId?: string
): Promise<boolean> {
  let path: string | undefined

  try {
    // Resolve the URL the same way the build does, including custom slug
    // properties from the page's database
    const recordMap = await notion.getPage(pageId, {
      signFileUrls: false,
      ofetchOptions: { timeout: 15_000 }
    })
    path = mapPageUrl(site, recordMap, new URLSearchParams())(pageId)

    const result = await Promise.race([
      res.revalidate(path),
      delay(REVALIDATE_TIMEOUT_MS, TIMED_OUT, { ref: false })
    ])
    if (result === TIMED_OUT) {
      throw new Error(`timed out after ${REVALIDATE_TIMEOUT_MS}ms`)
    }

    console.log('notion-webhook revalidated', path, 'for event', eventId)
    return true
  } catch (err: any) {
    console.warn(
      'notion-webhook could not revalidate',
      path ?? pageId,
      err?.message,
      '- falling back to rebuild'
    )
    return false
  }
}

async function triggerRebuild(
  deployHookUrl: string,
  eventType?: string,
  eventId?: string
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const deployRes = await fetch(deployHookUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000)
      })
      if (deployRes.ok) {
        console.log(
          'notion-webhook triggered rebuild for event',
          eventType,
          eventId
        )
        return
      }
      console.error(
        'notion-webhook deploy hook failed',
        deployRes.status,
        eventId
      )
    } catch {
      console.error('notion-webhook could not reach deploy hook', eventId)
    }

    if (attempt < 3) await delay(attempt * 1000)
  }

  console.error(
    'notion-webhook exhausted deploy hook retries',
    eventType,
    eventId
  )
}

async function readRawBody(req: NextApiRequest): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isValidSignature(
  rawBody: string,
  signature: string,
  verificationToken: string
): boolean {
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', verificationToken).update(rawBody).digest('hex')}`
  )
  const received = Buffer.from(signature)

  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  )
}
