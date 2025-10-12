import { type GetStaticProps } from 'next'

import { NotionPage } from '@/components/NotionPage'
import { domain, isDev } from '@/lib/config'
import { getSiteMap } from '@/lib/get-site-map'
import { resolveNotionPage } from '@/lib/resolve-notion-page'
import { type PageProps, type Params } from '@/lib/types'

export const getStaticProps: GetStaticProps<PageProps, Params> = async (
  context
) => {
  const rawPageId = context.params.pageId as string

  try {
    const props = await resolveNotionPage(domain, rawPageId)

    return { props, revalidate: 10 }
  } catch (err) {
    console.error('page error', domain, rawPageId, err)

    // If it's a 403 error or other API issue, return a fallback page instead of failing the build
    if (err.message?.includes('403') || err.message?.includes('Forbidden')) {
      console.warn(`Skipping page ${rawPageId} due to access restrictions`)
      return {
        notFound: true,
        revalidate: 60 // Shorter revalidation for potentially temporary access issues
      }
    }

    // For other errors, we don't want to publish the error version of this page, so
    // let next.js know explicitly that incremental SSG failed
    throw err
  }
}

export async function getStaticPaths() {
  if (isDev) {
    return {
      paths: [],
      fallback: true
    }
  }

  try {
    const siteMap = await getSiteMap()

    const staticPaths = {
      paths: Object.keys(siteMap.canonicalPageMap).map((pageId) => ({
        params: {
          pageId
        }
      })),
      fallback: true // Changed to true to allow for ISR on missing pages
    }

    console.log(`Generated ${staticPaths.paths.length} static paths`)
    return staticPaths
  } catch (error) {
    console.error('Error generating static paths:', error)

    // Return minimal paths to prevent build failure
    // Pages will be generated on-demand with fallback: true
    return {
      paths: [],
      fallback: true
    }
  }
}

export default function NotionDomainDynamicPage(props) {
  return <NotionPage {...props} />
}