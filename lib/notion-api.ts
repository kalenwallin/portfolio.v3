import { NotionAPI } from 'packages/notion-client/src/notion-api'

export const notion = new NotionAPI({
  apiBaseUrl: process.env.NOTION_API_BASE_URL
})
