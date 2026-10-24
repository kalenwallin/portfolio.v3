import type { Block } from 'notion-types'
import { defaultMapImageUrl } from 'notion-utils'

import { defaultPageCover, defaultPageIcon } from './config'

export const mapImageUrl = (url: string | undefined, block: Block) => {
  if (url === defaultPageCover || url === defaultPageIcon) {
    return url
  }

  // Serve Notion uploads through Notion's image proxy, which signs them on
  // every request, so a statically generated page never embeds a URL that
  // expires. The default mapper leaves GIFs unproxied, which breaks uploads.
  if (url && isNotionUpload(url)) {
    // Drop the query: react-notion-x appends ?spaceId, which the proxy doesn't
    // need and which keeps the URL from matching its preview image
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

// Current uploads are `attachment:` references; older ones are private S3 URLs
function isNotionUpload(url: string) {
  if (url.startsWith('attachment:')) return true
  try {
    const { hostname, pathname } = new URL(url)
    return (
      hostname.endsWith('.amazonaws.com') &&
      (hostname.startsWith('prod-files-secure.') ||
        pathname.startsWith('/secure.notion-static.com/'))
    )
  } catch {
    return false
  }
}
