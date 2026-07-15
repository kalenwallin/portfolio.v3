import { NotionAPI } from 'notion-client'

const maxRetries = 5
const baseRetryDelayMs = 1000
const maxRetryDelayMs = 10_000
const retryJitterMs = 250

function getRetryAfterMs(response?: Response): number | undefined {
  const retryAfter = response?.headers.get('retry-after')
  if (!retryAfter) return

  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const retryAt = Date.parse(retryAfter)
  if (Number.isNaN(retryAt)) return

  return Math.max(0, retryAt - Date.now())
}

class ResilientNotionAPI extends NotionAPI {
  override getPage(...args: Parameters<NotionAPI['getPage']>) {
    const [pageId, options] = args

    // A page fetch can fan out into several Notion API requests. Keeping that
    // work serial prevents a single prerender from producing a request burst.
    return super.getPage(pageId, { concurrency: 1, ...options })
  }
}

export const notion = new ResilientNotionAPI({
  apiBaseUrl: process.env.NOTION_API_BASE_URL,
  ofetchOptions: {
    timeout: 30_000,
    // Notion's API uses POST requests, which ofetch does not retry by default.
    // Explicit retries make static generation tolerate transient rate limits.
    retry: maxRetries,
    retryStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
    retryDelay: ({ options, response }) => {
      const retriesRemaining =
        typeof options.retry === 'number' ? options.retry : maxRetries
      const attempt = Math.max(0, maxRetries - retriesRemaining)
      const exponentialDelay = Math.min(
        baseRetryDelayMs * 2 ** attempt,
        maxRetryDelayMs
      )

      return (
        Math.max(getRetryAfterMs(response) ?? 0, exponentialDelay) +
        Math.random() * retryJitterMs
      )
    }
  }
})
