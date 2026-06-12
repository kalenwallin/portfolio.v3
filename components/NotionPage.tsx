import cs from 'classnames'
import dynamic from 'next/dynamic'
import Image from 'next/legacy/image'
import Link from 'next/link'
import { useRouter } from 'next/router'
import type { ExtendedRecordMap, PageBlock } from 'notion-types'
import {
  formatDate,
  getBlockTitle,
  getBlockValue,
  getPageProperty
} from 'notion-utils'
import * as React from 'react'
import BodyClassName from 'react-body-classname'
import {
  type NotionComponents,
  NotionRenderer,
  useNotionContext
} from 'react-notion-x'
import { EmbeddedTweet, TweetNotFound, TweetSkeleton } from 'react-tweet'
import * as config from '@/lib/config'
import { applyCollectionFilters } from '@/lib/filter-collection-view'
import { mapImageUrl } from '@/lib/map-image-url'
import { getCanonicalPageUrl, mapPageUrl } from '@/lib/map-page-url'
import { searchNotion } from '@/lib/search-notion'
import type * as types from '@/lib/types'
import { useDarkMode } from '@/lib/use-dark-mode'

import { Footer } from './Footer'
import { Loading } from './Loading'
import { NotionPageHeader } from './NotionPageHeader'
import { Page404 } from './Page404'
import { PageAside } from './PageAside'
import { PageHead } from './PageHead'
import { PageTabs, type Tab } from './PageTabs'
import styles from './styles.module.css'

// ---------------------------------------------------------------------------
// Tab configuration
// Mapping from Notion collection_view name → tab label + id.
// Collection views whose names aren't listed here are excluded from tabs.
// ---------------------------------------------------------------------------
const COLLECTION_VIEW_TAB_MAP: Record<string, { id: string; label: string }> = {
  Featured: { id: 'featured', label: 'Featured' },
  Blog: { id: 'blog', label: 'Blog' },
  'Side Projects': { id: 'projects', label: 'Projects' },
  Talk: { id: 'talks', label: 'Talks' },
  School: { id: 'school', label: 'School' },
  Work: { id: 'work', label: 'Work' }
}

const ABOUT_TAB: Tab = { id: 'about', label: 'About' }

const ALL_TABS: Tab[] = [
  ABOUT_TAB,
  { id: 'featured', label: 'Featured' },
  { id: 'projects', label: 'Projects' },
  { id: 'work', label: 'Work' },
  { id: 'blog', label: 'Blog' },
  { id: 'talks', label: 'Talks' },
  { id: 'school', label: 'School' }
]

/** Returns a copy of recordMap with the root block's content replaced. */
function sliceRecordMap(
  recordMap: ExtendedRecordMap,
  rootBlockId: string,
  contentIds: string[]
): ExtendedRecordMap {
  const rootEntry = recordMap.block[rootBlockId] as any
  if (!rootEntry) return recordMap
  // The root block entry may be double-nested: { value: { role, value: { content } } }
  // We must patch content at the correct level.
  const isDoubleNested = rootEntry?.value?.value !== undefined
  const patchedEntry = isDoubleNested
    ? {
        ...rootEntry,
        value: {
          ...rootEntry.value,
          value: { ...rootEntry.value.value, content: contentIds }
        }
      }
    : {
        ...rootEntry,
        value: { ...rootEntry.value, content: contentIds }
      }
  return {
    ...recordMap,
    block: { ...recordMap.block, [rootBlockId]: patchedEntry }
  }
}

/**
 * Returns the tab info for a collection_view block, or undefined if unmatched.
 */
function getTabForCollectionBlock(
  blockId: string,
  recordMap: ExtendedRecordMap
): { id: string; label: string } | undefined {
  const v = getBlockValue(recordMap.block[blockId]) as any
  if (v?.type !== 'collection_view') return undefined
  for (const viewId of v?.view_ids ?? []) {
    const vv = getBlockValue(recordMap.collection_view?.[viewId] as any) as any
    const info = COLLECTION_VIEW_TAB_MAP[vv?.name ?? '']
    if (info) return info
  }
  return undefined
}

function isHeadingBlock(type: string): boolean {
  return (
    type === 'header' ||
    type === 'sub_header' ||
    type === 'sub_sub_header' ||
    type.startsWith('heading_')
  )
}

/**
 * Splits the root block's content array into:
 *   - aboutBlockIds: blocks not belonging to any tab section
 *   - collectionViewBlocks: { blockId, tabId, leaderBlockIds }[] for each tab
 *
 * A "tab section" is detected by finding a heading block where:
 *   - the next collection_view encountered is a matched (tab) collection, AND
 *   - no other heading block appears between them.
 * All blocks from that heading through the collection form the tab's content.
 * Everything else (before the first section, after the last, trailing blocks)
 * goes into the About tab.
 *
 * Returns null when the recordMap has no root block content.
 */
function buildTabSections(
  recordMap: ExtendedRecordMap,
  rootBlockId: string
): {
  aboutBlockIds: string[]
  collectionViewBlocks: Array<{
    blockId: string
    tabId: string
    leaderBlockIds: string[]
  }>
} | null {
  const rootBlock = getBlockValue(recordMap.block[rootBlockId]) as any
  const content: string[] = rootBlock?.content ?? []
  if (!content.length) return null

  // Find all tab section ranges: [startPos, collectionPos, tabId]
  const sectionRanges: Array<{
    start: number
    collectionPos: number
    tabId: string
  }> = []

  for (let i = 0; i < content.length; i++) {
    const blockType =
      (getBlockValue(recordMap.block[content[i]!]) as any)?.type ?? ''
    if (!isHeadingBlock(blockType)) continue

    // Look ahead for the next collection_view, stopping at another heading
    let foundCollection: { pos: number; tabId: string } | null = null
    for (let j = i + 1; j < content.length; j++) {
      const jType =
        (getBlockValue(recordMap.block[content[j]!]) as any)?.type ?? ''
      if (jType === 'collection_view') {
        const tabInfo = getTabForCollectionBlock(content[j]!, recordMap)
        if (tabInfo) foundCollection = { pos: j, tabId: tabInfo.id }
        break // stop at first collection regardless
      }
      if (isHeadingBlock(jType)) break // intervening heading → not a section start
    }

    if (foundCollection) {
      sectionRanges.push({
        start: i,
        collectionPos: foundCollection.pos,
        tabId: foundCollection.tabId
      })
      // Skip ahead past this section so we don't double-count inner headings
      i = foundCollection.pos
    }
  }

  if (!sectionRanges.length) return null

  // Build a set of positions belonging to tab sections
  const tabPositions = new Set<number>()
  for (const r of sectionRanges) {
    for (let k = r.start; k <= r.collectionPos; k++) tabPositions.add(k)
  }

  // About = all positions not in any tab section
  const aboutBlockIds = content.filter((_, i) => !tabPositions.has(i))

  // Tab sections: leaderBlockIds = heading + text before the collection
  const collectionViewBlocks = sectionRanges.map((r) => ({
    blockId: content[r.collectionPos]!,
    tabId: r.tabId,
    leaderBlockIds: content.slice(r.start, r.collectionPos)
  }))

  return { aboutBlockIds, collectionViewBlocks }
}

// -----------------------------------------------------------------------------
// Career timeline expansion
// Splits each year-row's description into per-bullet rows and shows month labels.
// -----------------------------------------------------------------------------

/**
 * Splits the child nodes of a table cell into per-line arrays,
 * treating '\n' in text nodes as line breaks, preserving element nodes whole.
 */
function splitCellIntoLines(cell: Element): Node[][] {
  const lines: Node[][] = [[]]

  for (const child of Array.from(cell.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const parts = (child.textContent ?? '').split('\n')
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) lines.push([])
        const part = parts[i]!
        if (part) lines[lines.length - 1]!.push(document.createTextNode(part))
      }
    } else {
      lines[lines.length - 1]!.push(child)
    }
  }

  return lines.filter((l) => l.some((n) => (n.textContent ?? '').trim()))
}

/**
 * Expands the career timeline table (Year | Month | Description) so each
 * bullet pair becomes its own row. Month lines are read directly from the
 * second column instead of being parsed from description text.
 * Idempotent — guarded by `data-tl-expanded` on the table element.
 */
function expandCareerTimeline(): void {
  const table = document.querySelector<HTMLTableElement>(
    '.notion-block-d52caa1b388749b9bc7466a825b47cfa'
  )
  if (!table || table.dataset.tlExpanded) return
  table.dataset.tlExpanded = '1'

  const tbody = table.querySelector('tbody')
  if (!tbody) return

  const allRows = Array.from(tbody.querySelectorAll('tr'))
  const headerRow = allRows[0]
  const dataRows = allRows.slice(1)

  const fragment = document.createDocumentFragment()
  if (headerRow) fragment.appendChild(headerRow)

  let isFirstDataRow = true
  let sideIdx = 0

  for (const row of dataRows) {
    const tds = row.querySelectorAll('td')
    const yearTd = tds[0]
    const monthTd = tds[1]
    const descTd = tds[2]

    const yearText =
      yearTd?.querySelector('.notion-simple-table-cell')?.textContent?.trim() ??
      ''
    const monthCell = monthTd?.querySelector('.notion-simple-table-cell')
    const descCell = descTd?.querySelector('.notion-simple-table-cell')
    if (!monthCell || !descCell) continue

    // Split month column on newlines, strip leading "- "
    const monthLines = (monthCell.textContent ?? '')
      .split('\n')
      .map((l) => l.replace(/^-\s*/, '').trim())
      .filter(Boolean)

    const descLines = splitCellIntoLines(descCell)

    // Most recent first within each year
    monthLines.reverse()
    descLines.reverse()

    const count = Math.max(monthLines.length, descLines.length)

    // Year header row — just the year label, no month/description
    const yearHeaderTr = document.createElement('tr')
    yearHeaderTr.className = row.className
    yearHeaderTr.dataset.tlType = 'year-header'
    if (isFirstDataRow) yearHeaderTr.dataset.tlFirst = '1'

    const yearHeaderTd = document.createElement('td')
    yearHeaderTd.className = yearTd?.className ?? ''
    const yearHeaderDiv = document.createElement('div')
    yearHeaderDiv.className = 'notion-simple-table-cell'
    const yearSpan = document.createElement('span')
    yearSpan.className = 'tl-year'
    yearSpan.textContent = yearText
    yearHeaderDiv.appendChild(yearSpan)
    yearHeaderTd.appendChild(yearHeaderDiv)

    for (const tdSrc of [monthTd, descTd]) {
      const emptyTd = document.createElement('td')
      emptyTd.className = tdSrc?.className ?? ''
      const emptyDiv = document.createElement('div')
      emptyDiv.className = 'notion-simple-table-cell'
      emptyTd.appendChild(emptyDiv)
      yearHeaderTr.appendChild(emptyTd)
    }
    yearHeaderTr.insertBefore(yearHeaderTd, yearHeaderTr.firstChild)
    fragment.appendChild(yearHeaderTr)

    // One row per bullet
    for (let i = 0; i < count; i++) {
      const tr = document.createElement('tr')
      tr.className = row.className
      tr.dataset.tlType = 'year-item'
      tr.dataset.tlSide = sideIdx % 2 === 0 ? 'left' : 'right'
      sideIdx++

      // Month in the left cell (same column as year)
      const monthLeftTd = document.createElement('td')
      monthLeftTd.className = yearTd?.className ?? ''
      const monthLeftDiv = document.createElement('div')
      monthLeftDiv.className = 'notion-simple-table-cell'
      monthLeftDiv.textContent = monthLines[i] ?? ''
      monthLeftTd.appendChild(monthLeftDiv)

      // Empty middle cell (hidden via CSS)
      const emptyMidTd = document.createElement('td')
      emptyMidTd.className = monthTd?.className ?? ''
      emptyMidTd.appendChild(document.createElement('div'))

      // Description cell — strip leading "- " from first text node
      const descNewTd = document.createElement('td')
      descNewTd.className = descTd?.className ?? ''
      const descDiv = document.createElement('div')
      descDiv.className = 'notion-simple-table-cell'
      const lineNodes = (descLines[i] ?? []).map((n) => n.cloneNode(true))
      if (
        lineNodes[0]?.nodeType === Node.TEXT_NODE &&
        (lineNodes[0] as Text).data.startsWith('- ')
      ) {
        ;(lineNodes[0] as Text).data = (lineNodes[0] as Text).data.slice(2)
      }
      for (const node of lineNodes) descDiv.appendChild(node)
      descNewTd.appendChild(descDiv)

      tr.appendChild(monthLeftTd)
      tr.appendChild(emptyMidTd)
      tr.appendChild(descNewTd)
      fragment.appendChild(tr)
    }

    isFirstDataRow = false
  }

  while (tbody.firstChild) tbody.removeChild(tbody.firstChild)
  tbody.appendChild(fragment)
}

// -----------------------------------------------------------------------------
// dynamic imports for optional components
// -----------------------------------------------------------------------------

const Code = dynamic(() =>
  import('react-notion-x/third-party/code').then(async (m) => {
    // add / remove any prism syntaxes here
    await Promise.allSettled([
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-markup-templating.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-markup.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-bash.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-c.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-cpp.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-csharp.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-docker.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-java.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-js-templates.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-coffeescript.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-diff.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-git.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-go.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-graphql.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-handlebars.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-less.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-makefile.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-markdown.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-objectivec.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-ocaml.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-python.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-reason.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-rust.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-sass.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-scss.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-solidity.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-sql.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-stylus.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-swift.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-wasm.js'),
      // @ts-expect-error Ignore prisma types
      import('prismjs/components/prism-yaml.js')
    ])
    return m.Code
  })
)

const Collection = dynamic(() =>
  import('react-notion-x/third-party/collection').then((m) => m.Collection)
)
const Equation = dynamic(() =>
  import('react-notion-x/third-party/equation').then((m) => m.Equation)
)
const Pdf = dynamic(
  () => import('react-notion-x/third-party/pdf').then((m) => m.Pdf),
  {
    ssr: false
  }
)
const Modal = dynamic(
  () =>
    import('react-notion-x/third-party/modal').then((m) => {
      m.Modal.setAppElement('.notion-viewport')
      return m.Modal
    }),
  {
    ssr: false
  }
)

function Tweet({ id }: { id: string }) {
  const { recordMap } = useNotionContext()
  const tweet = (recordMap as types.ExtendedTweetRecordMap)?.tweets?.[id]

  return (
    <React.Suspense fallback={<TweetSkeleton />}>
      {tweet ? <EmbeddedTweet tweet={tweet} /> : <TweetNotFound />}
    </React.Suspense>
  )
}

const propertyLastEditedTimeValue = (
  { block, pageHeader }: any,
  defaultFn: () => React.ReactNode
) => {
  if (pageHeader && block?.last_edited_time) {
    return `Last updated ${formatDate(block?.last_edited_time, {
      month: 'long'
    })}`
  }

  return defaultFn()
}

const propertyDateValue = (
  { data, schema, pageHeader }: any,
  defaultFn: () => React.ReactNode
) => {
  if (pageHeader && schema?.name?.toLowerCase() === 'published') {
    const publishDate = data?.[0]?.[1]?.[0]?.[1]?.start_date

    if (publishDate) {
      return `${formatDate(publishDate, {
        month: 'long'
      })}`
    }
  }

  return defaultFn()
}

const propertyTextValue = (
  { schema, pageHeader }: any,
  defaultFn: () => React.ReactNode
) => {
  if (pageHeader && schema?.name?.toLowerCase() === 'author') {
    return <b>{defaultFn()}</b>
  }

  return defaultFn()
}

const notionRendererComponents: Partial<NotionComponents> = {
  nextLegacyImage: Image,
  nextLink: Link,
  Code,
  Collection,
  Equation,
  Pdf,
  Modal,
  Tweet,
  Header: NotionPageHeader,
  propertyLastEditedTimeValue,
  propertyTextValue,
  propertyDateValue
}

export function NotionPage({
  site,
  recordMap: rawRecordMap,
  error,
  pageId
}: types.PageProps) {
  const router = useRouter()
  const lite = typeof router.query.lite === 'string' ? router.query.lite : null

  // lite mode is for oembed
  const isLiteMode = lite === 'true'

  const { isDarkMode } = useDarkMode()

  // Apply collection view checkbox filters client-side since the
  // Notion API no longer returns pre-filtered results per view.
  const recordMap = React.useMemo(
    () => (rawRecordMap ? applyCollectionFilters(rawRecordMap) : rawRecordMap),
    [rawRecordMap]
  )

  // Tab state — driven by URL hash for linkability
  const isRootPage = pageId === site?.rootNotionPageId
  const [activeTab, setActiveTab] = React.useState<string>(ABOUT_TAB.id)

  // Sync tab from URL hash on mount and on hash changes
  React.useEffect(() => {
    if (!isRootPage) return
    const syncHash = () => {
      const hash = window.location.hash.replace('#', '')
      const match = ALL_TABS.find((t) => t.id === hash)
      setActiveTab(match ? match.id : ABOUT_TAB.id)
    }
    syncHash()
    window.addEventListener('hashchange', syncHash)
    return () => window.removeEventListener('hashchange', syncHash)
  }, [isRootPage])

  const handleTabChange = React.useCallback((id: string) => {
    window.location.hash = id
    setActiveTab(id)
  }, [])

  // Build per-tab recordMaps for the root page
  const tabSections = React.useMemo(() => {
    if (!isRootPage || !recordMap) return null
    const keys = Object.keys(recordMap.block)
    const rootId = keys[0]
    if (!rootId) return null
    return buildTabSections(recordMap, rootId)
  }, [isRootPage, recordMap])

  const activeRecordMap = React.useMemo(() => {
    if (!isRootPage || !tabSections || !recordMap) return recordMap
    const keys = Object.keys(recordMap.block)
    const rootId = keys[0]!

    if (activeTab === ABOUT_TAB.id) {
      return sliceRecordMap(recordMap, rootId, tabSections.aboutBlockIds)
    }
    const cvBlock = tabSections.collectionViewBlocks.find(
      (b) => b.tabId === activeTab
    )
    if (!cvBlock) return sliceRecordMap(recordMap, rootId, [])
    return sliceRecordMap(recordMap, rootId, [
      ...cvBlock.leaderBlockIds,
      cvBlock.blockId
    ])
  }, [isRootPage, tabSections, recordMap, activeTab])

  const siteMapPageUrl = React.useMemo(() => {
    const params: any = {}
    if (lite) params.lite = lite

    const searchParams = new URLSearchParams(params)
    return site ? mapPageUrl(site, recordMap!, searchParams) : undefined
  }, [site, recordMap, lite])

  const keys = Object.keys(recordMap?.block || {})
  const block = getBlockValue(recordMap?.block?.[keys[0]!])

  const isBlogPost =
    block?.type === 'page' && block?.parent_table === 'collection'

  const showTableOfContents = !!isBlogPost
  const minTableOfContentsItems = 3

  const pageAside = React.useMemo(
    () => (
      <PageAside
        block={block!}
        recordMap={recordMap!}
        isBlogPost={isBlogPost}
      />
    ),
    [block, recordMap, isBlogPost]
  )

  // Auto-loop and autoplay embedded videos (e.g. webm demos)
  React.useEffect(() => {
    document
      .querySelectorAll<HTMLVideoElement>('.notion-asset-wrapper-video video')
      .forEach((v) => {
        v.loop = true
        v.muted = true
        v.autoplay = true
        v.play()
      })
  })

  // Expand career timeline bullets into individual per-month rows
  React.useEffect(() => {
    expandCareerTimeline()
  })

  if (router.isFallback) {
    return <Loading />
  }

  if (error || !site || !block || !recordMap) {
    return <Page404 site={site} pageId={pageId} error={error} />
  }

  const title = getBlockTitle(block, recordMap) || site.name

  if (!config.isServer) {
    // add important objects to the window global for easy debugging
    const g = window as any
    g.pageId = pageId
    g.recordMap = recordMap
    g.block = block
  }

  const canonicalPageUrl = config.isDev
    ? undefined
    : getCanonicalPageUrl(site, recordMap)(pageId)

  const socialImage = mapImageUrl(
    getPageProperty<string>('Social Image', block, recordMap) ||
      (block as PageBlock).format?.page_cover ||
      config.defaultPageCover,
    block
  )

  const socialDescription =
    getPageProperty<string>('Description', block, recordMap) ||
    config.description

  return (
    <>
      <PageHead
        pageId={pageId}
        site={site}
        title={title}
        description={socialDescription}
        image={socialImage}
        url={canonicalPageUrl}
        isBlogPost={isBlogPost}
      />

      {isLiteMode && <BodyClassName className='notion-lite' />}
      {isDarkMode && <BodyClassName className='dark-mode' />}

      <NotionRenderer
        bodyClassName={cs(
          styles.notion,
          pageId === site.rootNotionPageId && 'index-page'
        )}
        darkMode={isDarkMode}
        components={notionRendererComponents}
        recordMap={activeRecordMap ?? recordMap}
        rootPageId={site.rootNotionPageId}
        rootDomain={site.domain}
        fullPage={!isLiteMode}
        previewImages={!!recordMap.preview_images}
        showCollectionViewDropdown={false}
        showTableOfContents={showTableOfContents}
        minTableOfContentsItems={minTableOfContentsItems}
        defaultPageIcon={config.defaultPageIcon}
        defaultPageCover={config.defaultPageCover}
        defaultPageCoverPosition={config.defaultPageCoverPosition}
        mapPageUrl={siteMapPageUrl}
        mapImageUrl={mapImageUrl}
        searchNotion={config.isSearchEnabled ? searchNotion : undefined}
        pageAside={pageAside}
        pageHeader={
          isRootPage && tabSections ? (
            <>
              <h1 className='notion-title'>{title}</h1>
              <PageTabs
                tabs={ALL_TABS}
                activeTab={activeTab}
                onTabChange={handleTabChange}
              />
            </>
          ) : undefined
        }
        pageTitle={isRootPage && tabSections ? null : undefined}
        footer={<Footer />}
      />
    </>
  )
}
