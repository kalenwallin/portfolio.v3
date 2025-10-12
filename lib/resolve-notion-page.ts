import { type ExtendedRecordMap } from 'notion-types'
import { parsePageId } from 'notion-utils'

import * as acl from './acl'
import { environment, pageUrlAdditions, pageUrlOverrides, site } from './config'
import { db_upstash } from './db'
import { getSiteMap } from './get-site-map'
import { getPage } from './notion'

export async function resolveNotionPage(domain: string, rawPageId?: string) {
  let pageId: string
  let recordMap: ExtendedRecordMap

  if (rawPageId && rawPageId !== 'index') {
    pageId = parsePageId(rawPageId)

    if (!pageId) {
      // check if the site configuration provides an override or a fallback for
      // the page's URI
      const override =
        pageUrlOverrides[rawPageId] || pageUrlAdditions[rawPageId]

      if (override) {
        pageId = parsePageId(override)
      }
    }

    const useUriToPageIdCache = true
    const cacheKey = `uri-to-page-id:${domain}:${environment}:${rawPageId}`
    // TODO: should we use a TTL for these mappings or make them permanent?
    // const cacheTTL = 8.64e7 // one day in milliseconds
    const cacheTTL = undefined // disable cache TTL

    if (!pageId && useUriToPageIdCache) {
      try {
        // check if the database has a cached mapping of this URI to page ID
        pageId = await db_upstash.get(cacheKey)

        // console.log(`redis get "${cacheKey}"`, pageId)
      } catch (err) {
        // ignore redis errors
        console.warn(`redis error get "${cacheKey}"`, err.message)
      }
    }

    if (pageId) {
      try {
        recordMap = await getPage(pageId)
      } catch (error: any) {
        console.error(`Failed to load page ${pageId}:`, error.message)
        
        // If it's a 403 error or other API issue, return an error instead of throwing
        if (error.message?.includes('403') || error.message?.includes('Forbidden')) {
          return {
            error: {
              message: `Access denied to page "${pageId}". The page may be private or there may be authentication issues.`,
              statusCode: 403
            }
          }
        }
        
        // For other errors, still throw to maintain existing behavior
        throw error
      }
    } else {
      // handle mapping of user-friendly canonical page paths to Notion page IDs
      // e.g., /developer-x-entrepreneur versus /71201624b204481f862630ea25ce62fe
      const siteMap = await getSiteMap()
      pageId = siteMap?.canonicalPageMap[rawPageId]

      if (pageId) {
        // TODO: we're not re-using the page recordMap from siteMaps because it is
        // cached aggressively
        // recordMap = siteMap.pageMap[pageId]

        try {
          recordMap = await getPage(pageId)

          if (useUriToPageIdCache) {
            try {
              // update the database mapping of URI to pageId
              await db_upstash.set(cacheKey, pageId, cacheTTL)

              // console.log(`redis set "${cacheKey}"`, pageId, { cacheTTL })
            } catch (err) {
              // ignore redis errors
              console.warn(`redis error set "${cacheKey}"`, err.message)
            }
          }
        } catch (error: any) {
          console.error(`Failed to load canonical page ${pageId} for ${rawPageId}:`, error.message)
          
          if (error.message?.includes('403') || error.message?.includes('Forbidden')) {
            return {
              error: {
                message: `Access denied to page "${rawPageId}". The page may be private or there may be authentication issues.`,
                statusCode: 403
              }
            }
          }
          
          throw error
        }
      } else {
        // note: we're purposefully not caching URI to pageId mappings for 404s
        return {
          error: {
            message: `Not found "${rawPageId}"`,
            statusCode: 404
          }
        }
      }
    }
  } else {
    pageId = site.rootNotionPageId

    console.log(site)
    try {
      recordMap = await getPage(pageId)
    } catch (error: any) {
      console.error(`Failed to load root page ${pageId}:`, error.message)
      
      // If we can't load the root page, this is a critical error
      if (error.message?.includes('403') || error.message?.includes('Forbidden')) {
        return {
          error: {
            message: `Access denied to root page "${pageId}". Please check your Notion token and permissions.`,
            statusCode: 403
          }
        }
      }
      
      throw error
    }
  }

  const props = { site, recordMap, pageId }
  return { ...props, ...(await acl.pageAcl(props)) }
}
