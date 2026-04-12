import type { Block, ExtendedRecordMap } from 'notion-types'
import { getBlockValue } from 'notion-utils'

interface CheckboxFilter {
  property: string
  filter: {
    operator: 'checkbox_is' | 'checkbox_is_not'
    value?: {
      type?: string
      value?: string | boolean
    }
  }
}

function isCheckboxFilter(f: any): f is CheckboxFilter {
  return (
    f?.filter?.operator === 'checkbox_is' ||
    f?.filter?.operator === 'checkbox_is_not'
  )
}

/**
 * Determines whether a checkbox filter expects the value to be checked.
 *
 * Notion's internal API may represent the filter value in several ways:
 *   - { type: "exact", value: "Yes" }   — full form
 *   - { value: "Yes" }                  — shortened
 *   - { value: true }                   — boolean variant
 *   - {}  or  undefined                 — implicit "is checked"
 *
 * For `checkbox_is` the default (when value is absent) is "Yes" (checked).
 */
function filterExpectsChecked(filter: CheckboxFilter): boolean {
  const raw = filter.filter.value?.value
  // Explicitly "No" or false → unchecked
  if (raw === 'No' || raw === false) return false
  // Everything else (including "Yes", true, undefined) → checked
  return true
}

/**
 * Checks whether a block passes a single checkbox filter.
 */
function blockPassesCheckboxFilter(
  block: any,
  filter: CheckboxFilter
): boolean {
  const propValue = block?.properties?.[filter.property]
  const isChecked = propValue?.[0]?.[0] === 'Yes'
  const expects = filterExpectsChecked(filter)

  if (filter.filter.operator === 'checkbox_is') {
    return isChecked === expects
  }
  // checkbox_is_not
  return isChecked !== expects
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

interface SortRule {
  property: string
  direction: 'ascending' | 'descending'
}

/**
 * Extracts a comparable sort value from a block property.
 *
 * Handles:
 *  - date properties: `[["‣", [["d", { start_date, start_time? }]]]]`
 *  - created_time / last_edited_time (built-in timestamps on the block)
 *  - text/number/title: plain text content `[["value"]]`
 */
function getSortValue(
  pageBlock: Block,
  propertyId: string,
  collection: any
): string | number {
  // Handle built-in timestamp sorts
  const schema = collection?.schema?.[propertyId]
  if (schema?.type === 'created_time') {
    return (pageBlock as any).created_time ?? 0
  }
  if (schema?.type === 'last_edited_time') {
    return (pageBlock as any).last_edited_time ?? 0
  }

  const prop = (pageBlock as any).properties?.[propertyId]
  if (!prop) return ''

  // Date property: [["‣", [["d", { start_date: "2024-01-15", ... }]]]]
  const firstDecoration = prop[0]
  if (firstDecoration?.[0] === '‣' && firstDecoration[1]) {
    for (const sub of firstDecoration[1]) {
      if (sub?.[0] === 'd' && sub[1]?.start_date) {
        const d = sub[1]
        const dateStr = d.start_time
          ? `${d.start_date}T${d.start_time}`
          : d.start_date
        return new Date(dateStr).getTime() || 0
      }
    }
  }

  // Plain text / number value
  const text = firstDecoration?.[0]
  if (typeof text === 'string') {
    const num = Number(text)
    return Number.isNaN(num) ? text : num
  }

  return ''
}

/**
 * Sorts blockIds in-place according to the view's `query2.sort` rules.
 */
function sortBlockIds(
  blockIds: string[],
  sortRules: SortRule[],
  blockMap: ExtendedRecordMap['block'],
  collection: any
): string[] {
  if (!sortRules?.length || blockIds.length <= 1) return blockIds

  return [...blockIds].sort((a, b) => {
    const blockA = getBlockValue(blockMap[a])
    const blockB = getBlockValue(blockMap[b])
    if (!blockA || !blockB) return 0

    for (const rule of sortRules) {
      const valA = getSortValue(blockA, rule.property, collection)
      const valB = getSortValue(blockB, rule.property, collection)

      let cmp: number
      if (typeof valA === 'number' && typeof valB === 'number') {
        cmp = valA - valB
      } else {
        cmp = String(valA).localeCompare(String(valB))
      }

      if (cmp !== 0) {
        return rule.direction === 'descending' ? -cmp : cmp
      }
    }
    return 0
  })
}

/**
 * Applies collection view checkbox filters to the recordMap's
 * `collection_query` blockIds, since the Notion API no longer
 * returns pre-filtered results per view.
 *
 * Returns a shallow-cloned recordMap with filtered `collection_query`.
 */
export function applyCollectionFilters(
  recordMap: ExtendedRecordMap
): ExtendedRecordMap {
  const { collection_query, collection_view, block } = recordMap

  if (!collection_query || !collection_view) {
    return recordMap
  }

  const filteredCollectionQuery = { ...collection_query }
  let mutated = false

  for (const collectionId of Object.keys(filteredCollectionQuery)) {
    const viewMap = filteredCollectionQuery[collectionId]
    if (!viewMap) continue

    const collection = getBlockValue(
      (recordMap as any).collection?.[collectionId]
    )

    const newViewMap = { ...viewMap }

    for (const viewId of Object.keys(newViewMap)) {
      const view = getBlockValue(collection_view[viewId])
      const query2 = (view as any)?.query2

      // ---- Checkbox filters ----
      const filters: any[] = query2?.filter?.filters
      const checkboxFilters = filters?.length
        ? filters.filter(isCheckboxFilter)
        : []
      const hasFilters = checkboxFilters.length > 0

      // ---- Sort rules ----
      const sortRules: SortRule[] = query2?.sort ?? []
      const hasSort = sortRules.length > 0

      if (!hasFilters && !hasSort) continue

      const logicalOp: string = query2?.filter?.operator || 'and'
      const viewData = newViewMap[viewId]
      if (!viewData) continue

      const filterBlockIds = (blockIds: string[]): string[] => {
        let result = blockIds

        if (hasFilters) {
          result = result.filter((id) => {
            const pageBlock = getBlockValue(block[id])
            if (!pageBlock) return true

            const results = checkboxFilters.map((f) =>
              blockPassesCheckboxFilter(pageBlock, f)
            )

            const passes =
              logicalOp === 'or'
                ? results.some(Boolean)
                : results.every(Boolean)

            if (!passes) {
              console.debug(
                `[collection-filter] excluding block ${id} from view ${viewId}`,
                {
                  filters: checkboxFilters.map((f) => ({
                    prop: f.property,
                    op: f.filter.operator,
                    expects: filterExpectsChecked(f),
                    actual: pageBlock?.properties?.[f.property]?.[0]?.[0]
                  }))
                }
              )
            }

            return passes
          })
        }

        if (hasSort) {
          result = sortBlockIds(result, sortRules, block, collection)
        }

        return result
      }

      // Clone the view data and filter all blockId arrays
      const newViewData = { ...viewData }

      if (newViewData.blockIds) {
        newViewData.blockIds = filterBlockIds(newViewData.blockIds)
      }

      if (newViewData.collection_group_results) {
        newViewData.collection_group_results = {
          ...newViewData.collection_group_results,
          blockIds: filterBlockIds(
            newViewData.collection_group_results.blockIds
          )
        }
      }

      // Also filter any results:* grouped keys (used by board views)
      for (const key of Object.keys(newViewData)) {
        if (key.startsWith('results:') && (newViewData as any)[key]?.blockIds) {
          ;(newViewData as any)[key] = {
            ...(newViewData as any)[key],
            blockIds: filterBlockIds((newViewData as any)[key].blockIds)
          }
        }
      }

      newViewMap[viewId] = newViewData
      mutated = true

      console.debug(
        `[collection-filter] view "${(view as any)?.name || viewId}"`,
        {
          filters: checkboxFilters.map((f) => ({
            prop: f.property,
            op: f.filter.operator,
            rawValue: f.filter.value,
            expects: filterExpectsChecked(f)
          })),
          logicalOp,
          before:
            viewData.collection_group_results?.blockIds?.length ??
            viewData.blockIds?.length ??
            '?',
          after:
            newViewData.collection_group_results?.blockIds?.length ??
            newViewData.blockIds?.length ??
            '?'
        }
      )
    }

    filteredCollectionQuery[collectionId] = newViewMap
  }

  if (!mutated) return recordMap

  return {
    ...recordMap,
    collection_query: filteredCollectionQuery
  }
}
