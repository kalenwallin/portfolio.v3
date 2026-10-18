import type { NextApiRequest, NextApiResponse } from 'next'
import { contentCache } from '../../lib/cache'
import { search } from '../../lib/notion'
import type * as types from '../../lib/types'

export default async function searchNotion(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'method not allowed' })
  }

  const searchParams: types.SearchParams = req.body
  if (
    !searchParams ||
    typeof searchParams !== 'object' ||
    Array.isArray(searchParams) ||
    typeof searchParams.query !== 'string' ||
    typeof searchParams.ancestorId !== 'string'
  ) {
    return res.status(400).json({ error: 'invalid search parameters' })
  }

  // Include every parameter (ancestor, filters, limit, session) in the key.
  const results = await contentCache.get('search', searchParams, 120_000, () =>
    search(searchParams)
  )

  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json(results)
}
