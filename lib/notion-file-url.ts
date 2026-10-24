import { host } from './config'

// Current uploads are `attachment:` references; older ones are private S3 URLs
export function isNotionUpload(url: string) {
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

// Notion signs uploads for less than a day, but pages are only regenerated when
// Notion content changes, so pages link uploads to a route that re-signs them.
// The URL is absolute because react-notion-x parses it with `new URL()`. Its
// path names the upload (its ID and file name), so the URL changes when the
// file is replaced: preview images are cached by URL without the query, and the
// CDN caches each redirect for hours.
export function getNotionFileUrl(blockId: string, source: string) {
  const upload = source
    .split('?')[0]!
    .split(/[:/]/)
    .slice(-2)
    .map(encodeURIComponent)
    .join('/')
  return `${host}/api/notion-file/${blockId}/${upload}`
}

// The block ID in a URL from getNotionFileUrl, or undefined for other URLs
export function getNotionFileBlockId(url: string) {
  const prefix = `${host}/api/notion-file/`
  return url.startsWith(prefix)
    ? url.slice(prefix.length).split('/')[0]
    : undefined
}
