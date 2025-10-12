import { NotionAPI } from 'packages/notion-client/src/notion-api'
import { validateEnvironment } from './env-check'

// Validate environment variables at startup
validateEnvironment()

export const notion = new NotionAPI({
  apiBaseUrl: process.env.NOTION_API_BASE_URL,
  activeUser: process.env.NOTION_ACTIVE_USER,
  authToken: process.env.NOTION_TOKEN_V2
})
