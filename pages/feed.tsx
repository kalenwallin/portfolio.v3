import type { GetServerSideProps } from 'next'
import RSS from 'rss'

import * as config from '@/lib/config'
import { getSiteMetadata } from '@/lib/get-site-map'
import { getSocialImageUrl } from '@/lib/get-social-image-url'

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  if (req.method !== 'GET') {
    res.statusCode = 405
    res.setHeader('Content-Type', 'application/json')
    res.write(JSON.stringify({ error: 'method not allowed' }))
    res.end()
    return { props: {} }
  }

  const metadata = await getSiteMetadata()
  const ttlMinutes = 24 * 60 // 24 hours

  const feed = new RSS({
    title: config.name,
    site_url: config.host,
    feed_url: `${config.host}/feed.xml`,
    language: config.language,
    ttl: ttlMinutes
  })

  for (const post of metadata.blogPosts) {
    const { pageId, title, description, url, lastUpdatedTime, publishedTime } =
      post
    const date = lastUpdatedTime
      ? new Date(lastUpdatedTime)
      : publishedTime
        ? new Date(publishedTime)
        : new Date()
    const socialImageUrl = getSocialImageUrl(pageId)

    feed.item({
      title,
      url,
      date,
      description,
      enclosure: socialImageUrl
        ? {
            url: socialImageUrl,
            type: 'image/jpeg'
          }
        : undefined
    })
  }

  const feedText = feed.xml({ indent: true })

  // Redis caches the metadata. Recheck it on each request so webhook invalidation
  // isn't hidden behind a separate day-long browser/CDN cache.
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
  res.setHeader('Content-Type', 'text/xml; charset=utf-8')
  res.write(feedText)
  res.end()

  return { props: {} }
}

export default function noop() {
  return null
}
