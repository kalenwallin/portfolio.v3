import { createHmac, timingSafeEqual } from 'node:crypto'

import type { NextApiRequest, NextApiResponse } from 'next'

// Notion signs the exact bytes it sends, so we need the raw request body
export const config = {
  api: {
    bodyParser: false
  }
}

/**
 * Receives Notion webhook events and triggers a Vercel rebuild so that
 * statically generated pages pick up content changes.
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

  let payload: { verification_token?: string; type?: string }
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

  let deployRes: Response
  try {
    deployRes = await fetch(deployHookUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    console.error('notion-webhook could not reach deploy hook')
    return res.status(502).send({ error: 'failed to trigger deploy' })
  }
  if (!deployRes.ok) {
    console.error('notion-webhook deploy hook failed', deployRes.status)
    return res.status(502).send({ error: 'failed to trigger deploy' })
  }

  console.log('notion-webhook triggered rebuild for event', payload.type)
  res.status(200).send({ ok: true })
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
