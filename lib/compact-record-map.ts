import type { ExtendedRecordMap } from 'notion-types'

const UNUSED_RECORD_FIELDS = [
  'alive',
  'copied_from',
  'created_by_id',
  'created_by_table',
  'crdt_data',
  'crdt_format_version',
  'file_ids',
  'last_edited_by_id',
  'last_edited_by_table',
  'permissions',
  'space_id',
  'version'
] as const

function getRecordValue(record: any): any {
  return record?.value?.value ?? record?.value
}

function collectStrings(value: unknown, strings: Set<string>): void {
  if (typeof value === 'string') {
    strings.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, strings)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, strings)
  }
}

/**
 * Removes Notion API data that the read-only renderer never consumes.
 *
 * The API includes CRDT editing history and the full contents of pages returned
 * as collection rows. Both are large, but collection cards only need the page
 * record itself. Collection view switching is disabled by the renderer, so only
 * the first (displayed) view for each collection block is retained as well.
 */
export function compactRecordMap(
  recordMap: ExtendedRecordMap
): ExtendedRecordMap {
  const blocks = recordMap.block as Record<string, any>
  const blockIds = Object.keys(blocks)
  const rootBlockId = blockIds[0]

  if (!rootBlockId) return recordMap

  const retainedBlockIds = new Set<string>([rootBlockId])

  // Collection queries reference their row pages outside the normal content
  // tree. Retain those page records so galleries and page URL mapping still work.
  collectStrings(recordMap.collection_query, retainedBlockIds)

  // Parent pages and page mentions are also useful for breadcrumbs, titles,
  // canonical URLs, and collection metadata.
  for (const blockId of blockIds) {
    if (getRecordValue(blocks[blockId])?.type === 'page') {
      retainedBlockIds.add(blockId)
    }
  }

  const pendingBlockIds = [...retainedBlockIds]
  for (let index = 0; index < pendingBlockIds.length; index++) {
    const blockId = pendingBlockIds[index]!
    const block = getRecordValue(blocks[blockId])
    if (!block) continue

    // A non-root page is rendered as a link or collection card, never inline.
    // Its descendants otherwise duplicate the payload of the destination page.
    if (blockId !== rootBlockId && block.type === 'page') {
      delete block.content
    }

    // Content arrays, aliases, page mentions, and external object instances can
    // all point at other block records. Follow any block IDs found in the
    // retained value so the renderer never encounters a dangling reference.
    const referencedBlockIds = new Set<string>()
    collectStrings(block, referencedBlockIds)
    for (const referencedBlockId of referencedBlockIds) {
      if (
        blocks[referencedBlockId] &&
        !retainedBlockIds.has(referencedBlockId)
      ) {
        retainedBlockIds.add(referencedBlockId)
        pendingBlockIds.push(referencedBlockId)
      }
    }
  }

  for (const blockId of blockIds) {
    if (!retainedBlockIds.has(blockId)) delete blocks[blockId]
  }

  const retainedViewIds = new Set<string>()
  for (const blockRecord of Object.values(blocks)) {
    const block = getRecordValue(blockRecord)
    if (block?.type !== 'collection_view' || !block.view_ids?.length) continue

    const activeViewId = block.view_ids[0]
    block.view_ids = [activeViewId]
    retainedViewIds.add(activeViewId)
  }

  for (const viewId of Object.keys(recordMap.collection_view ?? {})) {
    if (!retainedViewIds.has(viewId)) {
      delete recordMap.collection_view[viewId]
    }
  }

  for (const views of Object.values(recordMap.collection_query ?? {})) {
    for (const viewId of Object.keys(views)) {
      if (!retainedViewIds.has(viewId)) delete views[viewId]
    }
  }

  // Strip edit-only metadata from every top-level record table. Keep creation
  // and edit timestamps because they can be displayed by react-notion-x.
  for (const table of Object.values(recordMap)) {
    if (!table || typeof table !== 'object') continue

    for (const record of Object.values(table)) {
      if (!record || typeof record !== 'object') continue

      delete (record as any).spaceId
      const value = getRecordValue(record)
      if (!value || typeof value !== 'object') continue

      for (const field of UNUSED_RECORD_FIELDS) delete value[field]
    }
  }

  return recordMap
}
