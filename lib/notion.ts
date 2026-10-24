import type {
  ExtendedRecordMap,
  SearchParams,
  SearchResults
} from 'notion-types'
import { getBlockValue, mergeRecordMaps } from 'notion-utils'
import pMap from 'p-map'
import pMemoize from 'p-memoize'

import {
  isPreviewImageSupportEnabled,
  navigationLinks,
  navigationStyle
} from './config'
import { notion } from './notion-api'
import { getPreviewImageMap } from './preview-images'

const getNavigationLinkPages = pMemoize(
  async (): Promise<ExtendedRecordMap[]> => {
    const navigationLinkPageIds = (navigationLinks || [])
      .map((link) => link?.pageId)
      .filter((id): id is string => Boolean(id))

    if (navigationStyle !== 'default' && navigationLinkPageIds.length) {
      return pMap(
        navigationLinkPageIds,
        async (navigationLinkPageId) =>
          notion.getPage(navigationLinkPageId, {
            chunkLimit: 1,
            fetchMissingBlocks: false,
            fetchCollections: false,
            signFileUrls: false
          }),
        {
          concurrency: 4
        }
      )
    }

    return []
  }
)

export async function getPage(pageId: string): Promise<ExtendedRecordMap> {
  let recordMap = await notion.getPage(pageId)

  if (navigationStyle !== 'default') {
    // ensure that any pages linked to in the custom navigation header have
    // their block info fully resolved in the page record map so we know
    // the page title, slug, etc.
    const navigationLinkRecordMaps = await getNavigationLinkPages()

    if (navigationLinkRecordMaps?.length) {
      recordMap = navigationLinkRecordMaps.reduce(
        (map, navigationLinkRecordMap) =>
          mergeRecordMaps(map, navigationLinkRecordMap),
        recordMap
      )
    }
  }

  // Signed file URLs expire within a day, but pages are only regenerated when
  // Notion content changes. Render images from their permanent source instead,
  // which mapImageUrl routes through Notion's image proxy.
  for (const blockId of Object.keys(recordMap.signed_urls ?? {})) {
    if (getBlockValue(recordMap.block[blockId])?.type === 'image') {
      delete recordMap.signed_urls[blockId]
    }
  }

  if (isPreviewImageSupportEnabled) {
    const previewImageMap = await getPreviewImageMap(recordMap)
    ;(recordMap as any).preview_images = previewImageMap
  }

  // Notion's collaborative-editing data isn't used for rendering and accounts
  // for a large share of the page props serialized into every page's HTML
  for (const blockEntry of Object.values(recordMap.block)) {
    const block = getBlockValue(blockEntry) as any
    if (block) delete block.crdt_data
  }

  return recordMap
}

export async function search(params: SearchParams): Promise<SearchResults> {
  const results = await notion.search(params)

  // Normalize recordMap block entries to ensure they use the { value, role }
  // wrapper format. The Notion API v3 may return blocks without this wrapper,
  // but react-notion-x's SearchDialog accesses blocks via `.value` and expects it.
  if (results.recordMap?.block) {
    for (const [blockId, blockEntry] of Object.entries(
      results.recordMap.block
    )) {
      const value = getBlockValue(blockEntry as any)
      if (value) {
        ;(results.recordMap.block as any)[blockId] = { value, role: 'reader' }
      }
    }
  }

  if (results.recordMap?.collection) {
    for (const [collectionId, collectionEntry] of Object.entries(
      results.recordMap.collection
    )) {
      const value = getBlockValue(collectionEntry as any)
      if (value) {
        ;(results.recordMap.collection as any)[collectionId] = {
          value,
          role: 'reader'
        }
      }
    }
  }

  return results
}
