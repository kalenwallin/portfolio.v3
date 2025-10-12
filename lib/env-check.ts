/**
 * Validates that required environment variables are present
 */
export function validateEnvironment() {
  const requiredEnvVars = [
    'NOTION_TOKEN_V2',
    'NOTION_ACTIVE_USER'
  ]

  const missing = requiredEnvVars.filter(envVar => !process.env[envVar])
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  // Validate token format
  const token = process.env.NOTION_TOKEN_V2
  if (token && !token.startsWith('v03%3A')) {
    console.warn('NOTION_TOKEN_V2 may be in an unexpected format. Expected to start with "v03%3A"')
  }

  console.log('Environment validation passed')
}