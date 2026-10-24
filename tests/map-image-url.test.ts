import './setup'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Block } from 'notion-types'

import { host } from '../lib/config'
import { mapImageUrl } from '../lib/map-image-url'

const id = '30000000-0000-4000-8000-000000000001'
const proxied = (source: string) =>
  `https://www.notion.so/image/${encodeURIComponent(source)}?table=block&id=${id}&cache=v2`

test('uploaded images load through the image proxy instead of expiring URLs', () => {
  const legacyPng =
    'https://s3-us-west-2.amazonaws.com/secure.notion-static.com/file/photo.png'
  const image = (source: string) =>
    ({ id, type: 'image', properties: { source: [[source]] } }) as Block

  assert.equal(
    mapImageUrl(
      'attachment:file:photo.png?spaceId=space',
      image('attachment:file:photo.png')
    ),
    proxied('attachment:file:photo.png')
  )
  assert.equal(mapImageUrl(legacyPng, image(legacyPng)), proxied(legacyPng))
  assert.equal(
    mapImageUrl(
      'https://example.com/external.gif',
      image('https://example.com/external.gif')
    ),
    'https://example.com/external.gif'
  )
})

test('uploaded GIFs link to the file route, which serves every frame', () => {
  const route = `${host}/api/notion-file/${id}/file/demo.gif`
  const gif = 'attachment:file:demo.gif'
  const image = { id, type: 'image', properties: { source: [[gif]] } } as Block
  const page = { id, type: 'page', format: { page_cover: gif } } as Block

  assert.equal(mapImageUrl(`${gif}?spaceId=space`, image), route)
  assert.equal(mapImageUrl(gif, page), route)
  // A GIF that isn't the block's own image or cover, such as a page icon,
  // can't be resolved by the route
  assert.equal(
    mapImageUrl('attachment:file:icon.gif', page),
    proxied('attachment:file:icon.gif')
  )
})
