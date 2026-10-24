import cs from 'classnames'
import { uuidToId } from 'notion-utils'
import * as React from 'react'
import { createPortal } from 'react-dom'

import { ChevronDownIcon } from '@/lib/icons/chevron-down'

import styles from './CollapsiblePreamble.module.css'

/**
 * On small and medium screens, collapses a Notion text block to its first line
 * and a fading second line, with a chevron below that expands it. The block is
 * rendered by react-notion-x, so this styles it in place and renders the toggle
 * into an element placed right after it. Key it by blockId, since it binds to
 * the block once.
 */
export function CollapsiblePreamble({ blockId }: { blockId: string }) {
  const [isExpanded, setIsExpanded] = React.useState(false)
  // Created detached during render, then moved in after the block before paint
  const [toggleRow] = React.useState(() => {
    if (typeof document === 'undefined') return null
    const row = document.createElement('div')
    row.className = styles.toggleRow!
    return row
  })
  const blockRef = React.useRef<HTMLElement | null>(null)

  React.useLayoutEffect(() => {
    const block = document.querySelector<HTMLElement>(
      `.notion-block-${uuidToId(blockId)}`
    )
    if (!block || !toggleRow) return
    blockRef.current = block
    block.after(toggleRow)
    return () => {
      toggleRow.remove()
      block.classList.remove(styles.collapsed!)
      blockRef.current = null
    }
  }, [blockId, toggleRow])

  React.useLayoutEffect(() => {
    blockRef.current?.classList.toggle(styles.collapsed!, !isExpanded)
  }, [isExpanded])

  if (!toggleRow) return null

  return createPortal(
    <button
      type='button'
      className={cs(styles.toggle, isExpanded && styles.expanded)}
      aria-expanded={isExpanded}
      aria-label={isExpanded ? 'Show less' : 'Show more'}
      onClick={() => setIsExpanded((expanded) => !expanded)}
    >
      <ChevronDownIcon />
    </button>,
    toggleRow
  )
}
