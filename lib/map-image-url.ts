import { type Block } from 'notion-types'
import { defaultMapImageUrl } from 'notion-utils'

import { defaultPageCover, defaultPageIcon } from './config'

/**
 * Checks if a URL points to a GIF image by examining the file extension.
 * Handles URLs with query strings and fragments properly.
 */
function isGifUrl(url: string): boolean {
  try {
    const urlObj = new URL(url, 'https://example.com')
    return urlObj.pathname.toLowerCase().endsWith('.gif')
  } catch {
    const pathPart = url.toLowerCase().split(/[?#]/)[0]
    return pathPart?.endsWith('.gif') ?? false
  }
}

export const mapImageUrl = (url: string | undefined, block: Block) => {
  if (!url) {
    return url
  }

  if (url === defaultPageCover || url === defaultPageIcon) {
    return url
  }

  // For GIF images, bypass the Notion image proxy to preserve animations.
  // The Notion proxy at https://www.notion.so/image/... processes images
  // which can truncate GIF animations to ~3 seconds.
  if (isGifUrl(url)) {
    // Return the original URL for GIFs to preserve full animation
    return url
  }

  return defaultMapImageUrl(url, block)
}
