import type { NextApiRequest, NextApiResponse } from 'next'
import { parsePageId } from 'notion-utils'

import { getSignedFile } from '@/lib/notion-files'

/**
 * Redirects to a freshly signed URL for a block's upload (a video, audio clip,
 * PDF, file, full-length GIF, or page cover), so statically generated pages
 * never embed a link that expires.
 */
export default async function notionFile(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).send({ error: 'method not allowed' })
  }

  // The path is /<block id>/<upload id>/<file name>; the rest only makes the URL
  // change when the file does, since the route always serves the block's file
  const [id = ''] = ([] as string[]).concat(req.query.path ?? [])
  const blockId = parsePageId(id, { uuid: true })
  if (!blockId) {
    return res.status(400).json({ error: 'invalid file id' })
  }

  const file = await getSignedFile(blockId)
  if (!file) {
    return res.status(404).json({ error: 'file not found' })
  }

  // Browsers and the CDN can reuse the redirect until the URL nears expiry
  const maxAge = Math.floor((file.cacheUntil - Date.now()) / 1000)
  res.setHeader(
    'Cache-Control',
    maxAge > 0 ? `public, max-age=${maxAge}, s-maxage=${maxAge}` : 'no-store'
  )
  res.redirect(307, file.url)
}
