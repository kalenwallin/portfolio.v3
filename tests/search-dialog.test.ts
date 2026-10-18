/* eslint-disable no-underscore-dangle -- Exercise the dependency's private event handlers. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import * as React from 'react'

// SearchDialog is private to react-notion-x. Exercise its installed event
// handlers with React's class updater queued, as in a batched input event.
// This tests the shipped dependency patch without copying the dialog into app code.
function createDialog(
  searchNotion: (params: { query: string }) => Promise<any>
) {
  const entryPath = fileURLToPath(import.meta.resolve('react-notion-x'))
  const entry = readFileSync(entryPath, 'utf8')
  const chunkPath = entry.match(/from "(\.\/src-[^"]+\.js)"/)?.[1]
  assert.ok(chunkPath, 'Could not locate the installed search dialog bundle')
  const source = readFileSync(resolve(dirname(entryPath), chunkPath), 'utf8')
  const start = source.indexOf('var SearchDialog = class')
  const end = source.indexOf('\n//#endregion', start)
  assert.ok(start >= 0 && end > start, 'Search dialog implementation changed')
  const SearchDialog = runInNewContext(
    `${source.slice(start, end)}; SearchDialog`,
    {
      React,
      console: { log() {} },
      _defineProperty: (target: object, key: string, value: unknown) =>
        Object.defineProperty(target, key, { value, writable: true })
    }
  )
  const dialog = new SearchDialog({ searchNotion, rootBlockId: 'root' })
  const updates: Array<() => void> = []
  dialog.updater = {
    enqueueSetState(instance: any, partial: object, callback?: () => void) {
      updates.push(() => {
        instance.state = { ...instance.state, ...partial }
        callback?.call(instance)
      })
    }
  }
  // The first call after a pause is the throttle's immediate, leading call.
  dialog._search = dialog._searchImpl.bind(dialog)
  const flush = () => {
    while (updates.length) updates.shift()!()
  }
  return { dialog, flush }
}

function results(total: number) {
  return { total, results: [], recordMap: { block: {}, collection: {} } }
}

test('far → farm searches the new query and finishes even with immediate cached results', async () => {
  const queries: string[] = []
  const { dialog, flush } = createDialog(async ({ query }) => {
    queries.push(query)
    return results(query === 'far' ? 5 : 6)
  })
  dialog.state.query = 'far'
  await dialog._searchImpl()
  flush()
  assert.equal(dialog.state.searchResult.total, 5)

  for (const query of ['farm', 'far', 'farm']) {
    dialog._onChangeQuery({ target: { value: query } })
    flush()
    await nextTurn()
    flush()
    assert.equal(dialog.state.query, query)
    assert.equal(dialog.state.isLoading, false)
    assert.equal(dialog.state.searchResult.total, query === 'far' ? 5 : 6)
  }
  assert.deepEqual(queries, ['far', 'farm', 'far', 'farm'])
})

test('an older search response cannot overwrite the latest query', async () => {
  const pending = new Map<string, (value: unknown) => void>()
  const { dialog, flush } = createDialog(
    ({ query }) => new Promise((done) => pending.set(query, done))
  )
  dialog._onChangeQuery({ target: { value: 'far' } })
  flush()
  dialog._onChangeQuery({ target: { value: 'farm' } })
  flush()
  pending.get('far')!(results(5))
  await nextTurn()
  flush()
  assert.equal(dialog.state.query, 'farm')
  assert.equal(dialog.state.isLoading, true)
  pending.get('farm')!(results(6))
  await nextTurn()
  flush()
  assert.equal(dialog.state.searchResult.total, 6)
  assert.equal(dialog.state.isLoading, false)
})
