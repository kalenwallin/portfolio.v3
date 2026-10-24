import type { Block, PageBlock } from 'notion-types'
import { defaultMapImageUrl } from 'notion-utils'

import { defaultPageCover, defaultPageIcon } from './config'
import { getNotionFileUrl, isNotionUpload } from './notion-file-url'

export const mapImageUrl = (url: string | undefined, block: Block) => {
  if (url === defaultPageCover || url === defaultPageIcon) {
    return url
  }

  if (url && isNotionUpload(url)) {
    // Notion's image proxy only serves a GIF's first 60 frames, so link the
    // block's own GIF upload to the route that redirects to the full file
    if (/\.gif(?:$|[?#])/i.test(url) && isBlockUpload(url, block)) {
      return getNotionFileUrl(block.id, url)
    }

    // Serve other uploads through Notion's image proxy, which signs them on
    // every request, so a statically generated page never embeds a URL that
    // expires. Drop the query: react-notion-x appends ?spaceId, which the proxy
    // doesn't need and which keeps the URL from matching its preview image.
    const proxyUrl = new URL(
      `https://www.notion.so/image/${encodeURIComponent(url.split('?')[0]!)}`
    )
    proxyUrl.searchParams.set('table', 'block')
    proxyUrl.searchParams.set('id', block.id)
    proxyUrl.searchParams.set('cache', 'v2')
    return proxyUrl.toString()
  }

  return defaultMapImageUrl(url, block)
}

// Whether url is the upload the file route serves for this block: an image's
// source or a page's cover
function isBlockUpload(url: string, block: Block) {
  const upload =
    block.type === 'image'
      ? block.properties?.source?.[0]?.[0]
      : (block as PageBlock).format?.page_cover
  return upload?.split('?')[0] === url.split('?')[0]
}
