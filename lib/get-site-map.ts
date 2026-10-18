import ExpiryMap from 'expiry-map'
import {
  getAllPagesInSpace,
  getBlockParentPage,
  getBlockTitle,
  getBlockValue,
  getPageProperty,
  idToUuid
} from 'notion-utils'
import pMemoize from 'p-memoize'
import * as config from './config'
import { contentCache } from './cache'
import { includeNotionIdInUrls } from './config'
import { getCanonicalPageId } from './get-canonical-page-id'
import { getCanonicalPageUrl } from './map-page-url'
import { notion } from './notion-api'
import type * as types from './types'

const uuid = !!includeNotionIdInUrls

export async function getSiteMap(): Promise<types.SiteMap> {
  const partialSiteMap = await getAllPages(
    config.rootNotionPageId,
    config.rootNotionSpaceId ?? undefined,
    await contentCache.version()
  )

  return {
    site: config.site,
    ...partialSiteMap
  } as types.SiteMap
}

// Keep large Notion records local and short lived. A webhook changes the version
// on every instance, so a warm process cannot retain an obsolete sitemap.
const getAllPages = pMemoize(
  (root: string, space: string | undefined, _version: string) =>
    getAllPagesImpl(root, space),
  {
    cache: new ExpiryMap(60_000),
    cacheKey: (...args) => JSON.stringify(args)
  }
)

export function getSiteMetadata(): Promise<types.SiteMetadata> {
  return contentCache.get(
    'site-metadata',
    {
      includeNotionIdInUrls,
      pageUrlOverrides: config.pageUrlOverrides,
      name: config.name,
      description: config.description
    },
    300_000,
    async () => {
      const siteMap = await getSiteMap()
      const blogPosts: types.SiteMetadata['blogPosts'] = []

      for (const pageId of Object.values(siteMap.canonicalPageMap)) {
        const recordMap = siteMap.pageMap[pageId]
        if (!recordMap) continue
        const rootKey = Object.keys(recordMap.block)[0]
        const block = rootKey && getBlockValue(recordMap.block[rootKey])
        if (!block) continue
        const parent = getBlockParentPage(block, recordMap)
        if (
          block.type !== 'page' ||
          block.parent_table !== 'collection' ||
          parent?.id !== idToUuid(config.rootNotionPageId)
        ) {
          continue
        }

        blogPosts.push({
          pageId,
          title: getBlockTitle(block, recordMap) || config.name,
          description:
            getPageProperty<string>('Description', block, recordMap) ||
            config.description,
          url: getCanonicalPageUrl(config.site, recordMap)(pageId),
          lastUpdatedTime:
            getPageProperty<number>('Last Updated', block, recordMap) ?? null,
          publishedTime:
            getPageProperty<number>('Published', block, recordMap) ?? null
        })
      }

      return { canonicalPageMap: siteMap.canonicalPageMap, blogPosts }
    }
  )
}

const getPage = async (pageId: string, opts?: any) => {
  return notion.getPage(pageId, {
    kyOptions: {
      timeout: 30_000
    },
    ...opts
  })
}

async function getAllPagesImpl(
  rootNotionPageId: string,
  rootNotionSpaceId?: string,
  {
    maxDepth = 1
  }: {
    maxDepth?: number
  } = {}
): Promise<Partial<types.SiteMap>> {
  const pageMap = await getAllPagesInSpace(
    rootNotionPageId,
    rootNotionSpaceId,
    getPage,
    {
      maxDepth
    }
  )

  const canonicalPageMap = Object.keys(pageMap).reduce(
    (map: Record<string, string>, pageId: string) => {
      const recordMap = pageMap[pageId]
      if (!recordMap) {
        throw new Error(`Error loading page "${pageId}"`)
      }

      const block = getBlockValue(recordMap.block[pageId])
      if (
        !(getPageProperty<boolean | null>('Public', block!, recordMap) ?? true)
      ) {
        return map
      }

      const canonicalPageId = getCanonicalPageId(pageId, recordMap, {
        uuid
      })!

      if (map[canonicalPageId]) {
        // you can have multiple pages in different collections that have the same id
        // TODO: we may want to error if neither entry is a collection page
        console.warn('error duplicate canonical page id', {
          canonicalPageId,
          pageId,
          existingPageId: map[canonicalPageId]
        })

        return map
      } else {
        return {
          ...map,
          [canonicalPageId]: pageId
        }
      }
    },
    {}
  )

  return {
    pageMap,
    canonicalPageMap
  }
}
