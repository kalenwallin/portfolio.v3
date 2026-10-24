import type { Block, PageBlock } from 'notion-types'
import { getBlockValue, idToUuid } from 'notion-utils'
import pMemoize from 'p-memoize'

import { contentCache, sharedCache } from './cache'
import { rootNotionPageId, rootNotionSpaceId } from './config'
import { isNotionUpload } from './notion-file-url'
import { notion } from './notion-api'

// Uploads that react-notion-x renders from recordMap.signed_urls
export const fileBlockTypes = new Set(['video', 'audio', 'file', 'pdf'])

// Stop reusing a signed URL early enough that a visitor can finish loading it
const EXPIRY_MARGIN_MS = 10 * 60_000

export interface SignedFile {
  url: string
  // When caches must stop handing out this URL (0 when its expiry is unknown)
  cacheUntil: number
}

export async function getSignedFile(
  blockId: string
): Promise<SignedFile | undefined> {
  // Versioned so an upload replaced in Notion is picked up after its webhook
  const key = `signed-file:${await contentCache.version()}:${blockId}`
  const cached = await sharedCache.get<SignedFile>(key)
  if (cached) return cached

  const { recordMap } = await notion.getBlocks([blockId])
  const block = getBlockValue(recordMap.block[blockId])
  const source = block && getUploadSource(block)
  // Only sign this site's uploads, so the route can't redirect visitors to
  // files from other Notion workspaces
  if (
    !block ||
    !source ||
    !isNotionUpload(source) ||
    block.space_id !== (await getSiteSpaceId())
  ) {
    return undefined
  }

  const { signedUrls } = await notion.getSignedFileUrls([
    { permissionRecord: { table: 'block', id: blockId }, url: source }
  ])
  const url = signedUrls?.[0]
  if (!url) return undefined

  const expiresAt = Number(new URL(url).searchParams.get('expirationTimestamp'))
  const file = {
    url,
    cacheUntil: expiresAt ? expiresAt - EXPIRY_MARGIN_MS : 0
  }
  if (file.cacheUntil > Date.now()) {
    await sharedCache.set(key, file, file.cacheUntil - Date.now())
  }
  return file
}

// The file a block displays: an upload's source, or a page's cover
function getUploadSource(block: Block): string | undefined {
  if (block.type === 'page') return (block as PageBlock).format?.page_cover
  if (block.type === 'image' || fileBlockTypes.has(block.type)) {
    return block.properties?.source?.[0]?.[0]
  }
  return undefined
}

const getSiteSpaceId = pMemoize(async () => {
  if (rootNotionSpaceId) return rootNotionSpaceId
  const rootId = idToUuid(rootNotionPageId)
  const { recordMap } = await notion.getBlocks([rootId])
  return getBlockValue(recordMap.block[rootId])?.space_id
})
